#!/usr/bin/python3
"""Import the configured Mihomo subscription into loopback listeners; never print secrets."""
import fcntl
import hashlib
import json
import os
import sys
from pathlib import Path
import subprocess
import tempfile
import urllib.request
import yaml

ROOT = Path('/var/lib/cloudcli/egress')
CONFIG = Path('/etc/mintcli-egress')
CORE = '/usr/local/libexec/cloudcli-mihomo'
DIRECT_HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def atomic(file, value):
    temp = file.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False))
    temp.chmod(0o600)
    temp.replace(file)


def sync():
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (ROOT / 'sync.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        settings = json.loads((CONFIG / 'source.json').read_text())
        snapshot = len(sys.argv) == 3 and sys.argv[1] == '--snapshot'
        if snapshot:
            raw = Path(sys.argv[2]).read_bytes()
        else:
            request = urllib.request.Request(settings['url'], headers={'User-Agent': 'Clash.Meta/1.19.32'})
            with DIRECT_HTTP.open(request, timeout=30) as response:
                raw = response.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError('Subscription too large')
        source = yaml.safe_load(raw)
        proxies = source.get('proxies') if isinstance(source, dict) else None
        if not isinstance(proxies, list) or not proxies or len(proxies) > 150:
            raise ValueError('Expected 1–150 Mihomo proxies')
        allowed = settings.get('allowedProxyNames')
        if allowed is not None:
            proxies = [proxy for proxy in proxies if proxy.get('name') in allowed]
            if {proxy['name'] for proxy in proxies} != set(allowed):
                raise ValueError('Required subscription nodes are missing')
        registry_file = CONFIG / 'registry.json'
        registry = json.loads(registry_file.read_text()) if registry_file.exists() else {}
        nodes = []
        seen = set()
        for proxy in proxies:
            name = proxy.get('name') if isinstance(proxy, dict) else None
            if not isinstance(name, str) or not name.strip() or len(name) > 160 or name in seen:
                raise ValueError('Invalid or duplicate proxy name')
            seen.add(name)
            node_id = hashlib.sha256(name.encode()).hexdigest()[:20]
            if node_id not in registry:
                port = 18080 + len(registry)
                if port >= 19080:
                    raise ValueError('Listener capacity reached')
                registry[node_id] = {'id': node_id, 'name': name, 'port': port}
            # Retain old listeners so running requests keep their original route.
            registry[node_id]['proxy'] = proxy
            nodes.append({k: registry[node_id][k] for k in ('id', 'name', 'port')})
        secret = settings['controllerSecret']
        config = {
            'allow-lan': False, 'bind-address': '127.0.0.1', 'mode': 'rule',
            'log-level': 'warning', 'ipv6': False,
            'external-controller': '127.0.0.1:17991', 'secret': secret,
            'proxies': [node['proxy'] for node in registry.values()],
            'listeners': [{'name': node['id'], 'type': 'mixed', 'listen': '127.0.0.1',
                           'port': node['port'], 'proxy': node['name']} for node in registry.values()],
            'rules': ['MATCH,REJECT'],
        }
        payload = yaml.safe_dump(config, allow_unicode=True, sort_keys=False)
        with tempfile.TemporaryDirectory(prefix='mintcli-egress-check-') as directory:
            candidate = Path(directory) / 'config.yaml'
            candidate.write_text(payload)
            candidate.chmod(0o600)
            subprocess.run([CORE, '-t', '-d', directory, '-f', str(candidate)], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        old = (CONFIG / 'config.yaml').read_text() if (CONFIG / 'config.yaml').exists() else None
        (CONFIG / 'config.yaml').write_text(payload)
        (CONFIG / 'config.yaml').chmod(0o600)
        if subprocess.run(['systemctl', 'is-active', '--quiet', 'mintcli-egress.service']).returncode == 0:
            request = urllib.request.Request('http://127.0.0.1:17991/configs', method='PUT',
                headers={'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json'},
                data=json.dumps({'payload': payload}).encode())
            try:
                with DIRECT_HTTP.open(request, timeout=15) as response:
                    if response.status != 204:
                        raise RuntimeError('Core reload failed')
            except Exception:
                if old is not None:
                    (CONFIG / 'config.yaml').write_text(old)
                raise
        atomic(registry_file, registry)
        from datetime import datetime, timezone
        atomic(ROOT / 'inventory.json', {'updatedAt': datetime.now(timezone.utc).isoformat(), 'nodes': nodes, 'source': 'snapshot' if snapshot else 'subscription'})
        print(json.dumps({'ok': True, 'nodes': len(nodes)}))


if __name__ == '__main__':
    try:
        sync()
    except Exception:
        print('{"ok":false,"error":"Subscription import failed; previous nodes retained"}')
        raise SystemExit(1)
