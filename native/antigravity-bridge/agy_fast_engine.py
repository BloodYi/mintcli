"""agy-fast plugin engine for antigravity-bridge.

Integrates https://github.com/INK-Q/agy-fast as a toggleable accelerator plugin
for both native `agy acp` and `Claude -> agy` execution paths, with GitHub
update checking, staged auto-update, live MCP smoke verification, automatic
tool/rule adaptation, and rollback on verification failure.
"""
from __future__ import annotations

import fcntl
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections import OrderedDict
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger("antigravity-chat.agy-fast")

AGY_FAST_REPO_URL = os.getenv("MINTCLI_AGY_FAST_REPO", "https://github.com/INK-Q/agy-fast.git")
AGY_FAST_GITHUB_SLUG = os.getenv("MINTCLI_AGY_FAST_GITHUB_SLUG", "INK-Q/agy-fast")
AGY_FAST_DIR = Path(os.getenv("MINTCLI_AGY_FAST_DIR", "/var/lib/cloudcli/agy-fast"))
STATE_FILENAME = ".mintcli-update-state.json"

DEFAULT_TOOLS = (
    "batch_search",
    "apply_edits",
    "read_slices",
    "quick_outline",
    "run_checks",
)
DEFAULT_SERVER_NAME = "agy-fast_fast"
SNAPSHOT_TIMEOUT_SECONDS = 2.5
SMOKE_TIMEOUT_SECONDS = 8.0
GIT_TIMEOUT_SECONDS = 60.0
HTTP_TIMEOUT_SECONDS = 12.0

_update_lock = threading.Lock()
_cache_lock = threading.Lock()
_rules_cache: dict[str, tuple[float, str]] = {}
_git_info_cache: dict[str, tuple[tuple[int, int], dict[str, str | None]]] = {}
_snapshot_cache: OrderedDict[str, str] = OrderedDict()
_MAX_SNAPSHOT_CACHE_ENTRIES = 256


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def get_agy_fast_dir() -> Path:
    env_dir = os.getenv("MINTCLI_AGY_FAST_DIR", "").strip()
    return Path(env_dir) if env_dir else AGY_FAST_DIR


def resolve_node_bin() -> str:
    for candidate in (
        os.getenv("MINTCLI_NODE_BIN", "").strip(),
        "/opt/mintcli-node/bin/node",
        shutil.which("node") or "",
    ):
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return "node"


def resolve_agy_bin() -> str | None:
    for candidate in (
        os.getenv("AGY_BIN", "").strip(),
        "/var/lib/cloudcli/cli/bin/agy",
        shutil.which("agy") or "",
    ):
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def _state_path(plugin_dir: Path | None = None) -> Path:
    base = plugin_dir or get_agy_fast_dir()
    return base / STATE_FILENAME


def _read_json_safe(path: Path) -> dict[str, Any] | None:
    try:
        raw = path.read_text(encoding="utf-8")
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def _state_lock_path(plugin_dir: Path | None = None) -> Path:
    base = (plugin_dir or get_agy_fast_dir()).resolve()
    parent = base.parent if base.parent.exists() else Path("/tmp")
    return parent / f".{base.name}-state.lock"


@contextmanager
def _locked_state_file(plugin_dir: Path | None = None, *, shared: bool = False):
    lock_path = _state_lock_path(plugin_dir)
    fd: int | None = None
    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(fd, fcntl.LOCK_SH if shared else fcntl.LOCK_EX)
    except OSError:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
            fd = None
    try:
        yield
    finally:
        if fd is not None:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
            try:
                os.close(fd)
            except OSError:
                pass


def _read_state_unlocked(plugin_dir: Path | None = None) -> dict[str, Any]:
    data = _read_json_safe(_state_path(plugin_dir)) or {}
    if "auto_update_enabled" not in data:
        data["auto_update_enabled"] = True
    return data


def _read_state(plugin_dir: Path | None = None) -> dict[str, Any]:
    with _locked_state_file(plugin_dir, shared=True):
        return _read_state_unlocked(plugin_dir)


def _write_state(patch: dict[str, Any], plugin_dir: Path | None = None) -> dict[str, Any]:
    base = plugin_dir or get_agy_fast_dir()
    with _locked_state_file(base, shared=False):
        base.mkdir(parents=True, exist_ok=True)
        current = _read_state_unlocked(base)
        merged = {**current, **patch}
        tmp = base / f".{STATE_FILENAME}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp"
        try:
            tmp.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            tmp.replace(_state_path(base))
        finally:
            if tmp.exists():
                try:
                    tmp.unlink()
                except OSError:
                    pass
        return merged


def _run_cmd(
    argv: list[str],
    *,
    cwd: Path | str | None = None,
    timeout: float = GIT_TIMEOUT_SECONDS,
    stdin_text: str | None = None,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        cwd=str(cwd) if cwd else None,
        input=stdin_text,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
        check=False,
    )


def _git_info(plugin_dir: Path) -> dict[str, str | None]:
    git_dir = plugin_dir / ".git"
    if not git_dir.exists():
        return {"commit": None, "commit_full": None, "branch": None}
    head_file = git_dir / "HEAD"
    head_mtime = 0
    ref_mtime = 0
    head_raw = ""
    try:
        head_stat = head_file.stat()
        head_mtime = head_stat.st_mtime_ns
        head_raw = head_file.read_text(encoding="utf-8", errors="replace").strip()
        if head_raw.startswith("ref:"):
            ref_rel = head_raw.split(":", 1)[1].strip()
            ref_file = git_dir / ref_rel
            if ref_file.is_file():
                ref_mtime = ref_file.stat().st_mtime_ns
    except OSError:
        pass

    cache_key = str(plugin_dir)
    stamp = (head_mtime, ref_mtime)
    with _cache_lock:
        cached = _git_info_cache.get(cache_key)
        if cached and cached[0] == stamp and stamp != (0, 0):
            return dict(cached[1])

    # Fast zero-subprocess resolution when HEAD points directly to an unpacked ref or detached SHA
    commit_full: str | None = None
    branch: str | None = None
    if head_raw.startswith("ref:"):
        ref_rel = head_raw.split(":", 1)[1].strip()
        if ref_rel.startswith("refs/heads/"):
            branch = ref_rel[len("refs/heads/"):]
        ref_file = git_dir / ref_rel
        if ref_file.is_file():
            try:
                sha = ref_file.read_text(encoding="utf-8", errors="replace").strip()
                if re.fullmatch(r"[0-9a-fA-F]{40}", sha):
                    commit_full = sha
            except OSError:
                pass
    elif re.fullmatch(r"[0-9a-fA-F]{40}", head_raw):
        commit_full = head_raw
        branch = "HEAD"

    if not commit_full or not branch:
        res = _run_cmd(["git", "rev-parse", "HEAD", "--short", "HEAD", "--abbrev-ref", "HEAD"], cwd=plugin_dir, timeout=5.0)
        if res.returncode == 0:
            lines = [ln.strip() for ln in res.stdout.splitlines() if ln.strip()]
            if len(lines) >= 3:
                commit_full = lines[0]
                short_sha = lines[1]
                branch = lines[2]
                info = {"commit": short_sha, "commit_full": commit_full, "branch": branch}
                with _cache_lock:
                    _git_info_cache[cache_key] = (stamp, info)
                return dict(info)

    info = {
        "commit": commit_full[:7] if commit_full else None,
        "commit_full": commit_full,
        "branch": branch,
    }
    if commit_full:
        with _cache_lock:
            _git_info_cache[cache_key] = (stamp, info)
    return dict(info)


def _parse_semver(version: str | None) -> tuple[int, int, int] | None:
    if not version:
        return None
    m = re.match(r"^v?(\d+)\.(\d+)\.(\d+)", str(version).strip())
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)))


def _is_newer_version(latest: str | None, installed: str | None) -> bool:
    lv = _parse_semver(latest)
    iv = _parse_semver(installed)
    if lv is not None and iv is not None:
        return lv > iv
    return False


def get_agy_fast_mcp_config(plugin_dir: Path | None = None) -> dict[str, Any]:
    """Dynamically adapt mcp_config.json into ACP and Claude Agent SDK formats."""
    base = plugin_dir or get_agy_fast_dir()
    node_bin = resolve_node_bin()
    mcp_json = _read_json_safe(base / "mcp_config.json") or {}
    servers_raw = mcp_json.get("mcpServers") if isinstance(mcp_json.get("mcpServers"), dict) else {}

    server_name = DEFAULT_SERVER_NAME
    server_cmd = node_bin
    server_args = [str(base / "dist" / "mcp-server.mjs")]
    tools_list = list(DEFAULT_TOOLS)

    if servers_raw:
        first_key, first_cfg = next(iter(servers_raw.items()))
        if isinstance(first_key, str) and first_key.strip():
            server_name = f"agy-fast_{first_key.strip()}"
        if isinstance(first_cfg, dict):
            raw_cmd = str(first_cfg.get("command") or "node").strip()
            server_cmd = node_bin if raw_cmd == "node" else raw_cmd
            raw_args = first_cfg.get("args")
            if isinstance(raw_args, list) and raw_args:
                server_args = [
                    str(arg).replace("${PLUGIN_ROOT}", str(base)).replace("${AGY_PLUGIN_ROOT}", str(base))
                    for arg in raw_args
                ]
            raw_tools = first_cfg.get("tools")
            if isinstance(raw_tools, dict) and raw_tools:
                tools_list = [str(k) for k in raw_tools.keys() if isinstance(k, str) and k.strip()]

    # Merge any live-discovered tools from the last smoke test so newly added upstream tools work immediately.
    state = _read_state(base)
    live_tools = state.get("adapted_tools")
    if isinstance(live_tools, list) and live_tools:
        for tool in live_tools:
            if isinstance(tool, str) and tool.strip() and tool not in tools_list:
                tools_list.append(tool)

    mcp_entry_exists = any(Path(a).is_file() for a in server_args if a.endswith(".mjs") or a.endswith(".js"))
    claude_allowed = [f"mcp__{server_name}__{tool}" for tool in tools_list]
    claude_allowed.append(f"mcp__{server_name}__*")
    mcp_env_map = {
        "PLUGIN_ROOT": str(base),
        "AGY_PLUGIN_ROOT": str(base),
        "AGY_FAST_AUTO_UPDATE": "0",
    }
    acp_env_list = [{"name": k, "value": v} for k, v in mcp_env_map.items()]

    return {
        "installed": mcp_entry_exists,
        "plugin_dir": str(base),
        "server_name": server_name,
        "command": server_cmd,
        "args": server_args,
        "tools": tools_list,
        "acp_mcp_servers": (
            [{"name": server_name, "command": server_cmd, "args": server_args, "env": acp_env_list}]
            if mcp_entry_exists
            else []
        ),
        "claude_mcp_servers": (
            {server_name: {"type": "stdio", "command": server_cmd, "args": server_args, "env": dict(mcp_env_map)}}
            if mcp_entry_exists
            else {}
        ),
        "claude_allowed_tools": claude_allowed if mcp_entry_exists else [],
    }


def _read_rules_text(plugin_dir: Path) -> str:
    rules_path = plugin_dir / "rules" / "AGENTS.md"
    local_path = plugin_dir / "rules" / "AGENTS.local.md"
    if not rules_path.is_file():
        return ""
    try:
        mtime = rules_path.stat().st_mtime
        if local_path.is_file():
            mtime = max(mtime, local_path.stat().st_mtime)
    except OSError:
        mtime = 0.0

    cache_key = str(plugin_dir)
    cached = _rules_cache.get(cache_key)
    if cached and cached[0] == mtime:
        return cached[1]

    parts: list[str] = []
    try:
        base_text = rules_path.read_text(encoding="utf-8", errors="replace").strip()
        if base_text:
            base_text = base_text.replace("${PLUGIN_ROOT}", str(plugin_dir)).replace("<plugin>", str(plugin_dir))
            parts.append(base_text)
    except OSError:
        pass
    if local_path.is_file():
        try:
            local_text = local_path.read_text(encoding="utf-8", errors="replace").strip()
            if local_text:
                parts.append(local_text)
        except OSError:
            pass
    combined = "\n\n".join(parts)
    _rules_cache[cache_key] = (mtime, combined)
    return combined


def get_agy_fast_session_snapshot(
    target_cwd: str | None,
    plugin_dir: Path | None = None,
    *,
    session_key: str | None = None,
) -> str:
    """Run agy-fast's dist/session-start.mjs to produce a compact <=1.5KB workspace snapshot."""
    if not target_cwd:
        return ""
    base = plugin_dir or get_agy_fast_dir()
    cache_id = f"{base}::{session_key}::{target_cwd}" if session_key else None
    if cache_id:
        with _cache_lock:
            cached_snap = _snapshot_cache.get(cache_id)
            if cached_snap is not None:
                _snapshot_cache.move_to_end(cache_id)
                return cached_snap

    script = base / "dist" / "session-start.mjs"
    if not script.is_file():
        return ""
    node_bin = resolve_node_bin()
    env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/var/lib/cloudcli"),
        "PLUGIN_ROOT": str(base),
        "AGY_PLUGIN_ROOT": str(base),
        "AGY_FAST_AUTO_UPDATE": "0",
    }
    try:
        res = _run_cmd(
            [node_bin, str(script)],
            cwd=target_cwd,
            timeout=SNAPSHOT_TIMEOUT_SECONDS,
            stdin_text=json.dumps({"cwd": target_cwd}),
            env=env,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        logger.debug("agy-fast session-start snapshot skipped: %s", exc)
        return ""
    if res.returncode != 0 or not res.stdout.strip():
        return ""
    try:
        parsed = json.loads(res.stdout)
    except json.JSONDecodeError:
        return ""
    steps = parsed.get("injectSteps")
    if not isinstance(steps, list):
        return ""
    messages: list[str] = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        sm = step.get("systemMessage")
        if isinstance(sm, dict) and isinstance(sm.get("systemMessage"), str) and sm["systemMessage"].strip():
            messages.append(sm["systemMessage"].strip())
        elif isinstance(sm, str) and sm.strip():
            messages.append(sm.strip())
    result = "\n\n".join(messages)
    if cache_id and result:
        with _cache_lock:
            _snapshot_cache[cache_id] = result
            _snapshot_cache.move_to_end(cache_id)
            while len(_snapshot_cache) > _MAX_SNAPSHOT_CACHE_ENTRIES:
                _snapshot_cache.popitem(last=False)
    return result


def get_agy_fast_system_directive(
    *,
    mode: str = "acp",
    target_cwd: str | None = None,
    include_snapshot: bool = True,
    session_key: str | None = None,
    plugin_dir: Path | None = None,
) -> str:
    """Build the system prompt directive for agy-fast, dynamically adapted to ACP or Claude->agy."""
    base = plugin_dir or get_agy_fast_dir()
    cfg = get_agy_fast_mcp_config(base)
    if not cfg["installed"]:
        return ""

    manifest = _read_json_safe(base / "plugin.json") or {}
    version = str(manifest.get("version") or "unknown")
    server_name = cfg["server_name"]
    tool_names = cfg["tools"]

    parts: list[str] = [f"# Plugin Active: agy-fast (v{version})"]
    cwd_hint = f" (active workspace: `{target_cwd}`)" if target_cwd else ""
    if mode == "claude_agy":
        mcp_list = ", ".join(f"`mcp__{server_name}__{t}`" for t in tool_names)
        parts.append(
            "## Claude Code Tool Surface Adaptation\n"
            f"- The `agy-fast` MCP server is attached as `{server_name}` with tools: {mcp_list}.\n"
            "- In the rules below, map Antigravity's built-in `read_file` -> `Read`, `run_command` -> `Bash`, "
            "`edit_file` -> `Edit`, `write_file` -> `Write`.\n"
            f"- Always include a brief `toolSummary` string on every `mcp__{server_name}__*` call "
            "(the underlying Antigravity host injects `toolSummary` as a required schema property), "
            f"and pass explicit absolute `cwd`{cwd_hint}."
        )
    else:
        parts.append(
            f"- Installed plugin path: `{base}` (MCP server: `{server_name}`, tools: {', '.join(tool_names)}){cwd_hint}."
        )

    rules_text = _read_rules_text(base)
    if rules_text:
        parts.append(rules_text)

    if include_snapshot and target_cwd:
        snapshot = get_agy_fast_session_snapshot(target_cwd, base, session_key=session_key)
        if snapshot:
            parts.append(snapshot)

    return "\n\n".join(parts)


def smoke_test_agy_fast(plugin_dir: Path | None = None) -> dict[str, Any]:
    """Verify plugin manifest, MCP stdio server handshake/tools, session-start, and agy validate."""
    base = plugin_dir or get_agy_fast_dir()
    manifest = _read_json_safe(base / "plugin.json")
    if not manifest or not manifest.get("name") or not manifest.get("version"):
        return {"ok": False, "error": "Invalid or missing plugin.json"}

    mcp_script = base / "dist" / "mcp-server.mjs"
    start_script = base / "dist" / "session-start.mjs"
    rules_file = base / "rules" / "AGENTS.md"
    for req_file in (mcp_script, start_script, rules_file):
        if not req_file.is_file():
            return {"ok": False, "error": f"Missing required runtime file: {req_file.name}"}

    node_bin = resolve_node_bin()

    # 1. Live MCP stdio smoke test (initialize + tools/list)
    mcp_probe_code = (
        'import { spawn } from "node:child_process";'
        'const script = process.argv[1];'
        'const proc = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });'
        'let buf = "";'
        'const timer = setTimeout(() => { proc.kill(); process.stderr.write("MCP smoke timeout"); process.exit(2); }, 6000);'
        'proc.stdout.on("data", chunk => {'
        '  buf += chunk.toString();'
        '  let idx;'
        '  while ((idx = buf.indexOf("\\n")) !== -1) {'
        '    const line = buf.slice(0, idx).trim();'
        '    buf = buf.slice(idx + 1);'
        '    if (!line) continue;'
        '    try {'
        '      const msg = JSON.parse(line);'
        '      if (msg.id === 2 && msg.result && Array.isArray(msg.result.tools)) {'
        '        clearTimeout(timer);'
        '        process.stdout.write(JSON.stringify(msg.result.tools.map(t => t.name)));'
        '        proc.kill();'
        '        process.exit(0);'
        '      }'
        '    } catch {}'
        '  }'
        '});'
        'proc.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"mintcli-smoke",version:"1.0"}}}) + "\\n");'
        'proc.stdin.write(JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list",params:{}}) + "\\n");'
    )
    try:
        mcp_res = _run_cmd([node_bin, "-e", mcp_probe_code, str(mcp_script)], timeout=SMOKE_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "MCP server smoke test timed out"}
    if mcp_res.returncode != 0:
        return {"ok": False, "error": f"MCP server smoke test failed: {(mcp_res.stderr or mcp_res.stdout).strip()[:300]}"}
    try:
        discovered_tools = json.loads(mcp_res.stdout.strip())
        if not isinstance(discovered_tools, list) or not discovered_tools:
            return {"ok": False, "error": "MCP server returned empty tools list"}
    except json.JSONDecodeError:
        return {"ok": False, "error": f"Unexpected MCP smoke output: {mcp_res.stdout[:200]}"}

    # 2. SessionStart snapshot smoke test
    try:
        snap_res = _run_cmd(
            [node_bin, str(start_script)],
            cwd=base,
            timeout=SNAPSHOT_TIMEOUT_SECONDS,
            stdin_text=json.dumps({"cwd": str(base)}),
            env={**os.environ, "PLUGIN_ROOT": str(base), "AGY_FAST_AUTO_UPDATE": "0"},
        )
        if snap_res.returncode != 0:
            return {"ok": False, "error": f"session-start smoke failed (rc={snap_res.returncode})"}
        json.loads(snap_res.stdout)
    except Exception as exc:
        return {"ok": False, "error": f"session-start smoke error: {exc}"}

    # 3. Official `agy plugin validate --strict` if agy CLI is installed
    agy_validated: bool | None = None
    agy_bin = resolve_agy_bin()
    if agy_bin:
        try:
            val_res = _run_cmd([agy_bin, "plugin", "validate", "--strict", str(base)], timeout=10.0)
            agy_validated = val_res.returncode == 0
            if not agy_validated:
                return {
                    "ok": False,
                    "error": f"agy plugin validate failed: {(val_res.stderr or val_res.stdout).strip()[:300]}",
                }
        except Exception as exc:
            logger.warning("agy plugin validate skipped due to error: %s", exc)

    return {
        "ok": True,
        "version": str(manifest.get("version")),
        "tools": discovered_tools,
        "agy_validated": agy_validated,
    }


def _fetch_github_latest_release() -> dict[str, Any] | None:
    url = f"https://api.github.com/repos/{AGY_FAST_GITHUB_SLUG}/releases/latest"
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "mintcli-agy-fast-updater/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
            if isinstance(data, dict):
                return data
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        logger.debug("GitHub release check failed: %s", exc)
    return None


def _fetch_remote_main_commit(plugin_dir: Path) -> str | None:
    try:
        res = _run_cmd(
            ["git", "ls-remote", AGY_FAST_REPO_URL, "refs/heads/main"],
            cwd=plugin_dir if plugin_dir.exists() else None,
            timeout=15.0,
        )
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip().split()[0]
    except Exception as exc:
        logger.debug("git ls-remote failed: %s", exc)
    return None


def get_agy_fast_status(plugin_dir: Path | None = None) -> dict[str, Any]:
    """Return full installed + update status of the agy-fast plugin."""
    base = plugin_dir or get_agy_fast_dir()
    manifest = _read_json_safe(base / "plugin.json") or {}
    cfg = get_agy_fast_mcp_config(base)
    git = _git_info(base)
    state = _read_state(base)

    installed_version = str(manifest.get("version") or "") or None
    latest_version = state.get("latest_version")
    latest_commit = state.get("latest_commit")

    update_available = bool(state.get("update_available", False))
    if installed_version and latest_version:
        if _is_newer_version(latest_version, installed_version):
            update_available = True
        elif latest_commit and git.get("commit_full") and latest_commit == git.get("commit_full"):
            update_available = False

    return {
        "installed": bool(cfg["installed"] and installed_version),
        "plugin_dir": str(base),
        "repo": AGY_FAST_GITHUB_SLUG,
        "repo_url": f"https://github.com/{AGY_FAST_GITHUB_SLUG}",
        "installed_version": installed_version,
        "installed_commit": git.get("commit"),
        "installed_commit_full": git.get("commit_full"),
        "branch": git.get("branch"),
        "latest_version": latest_version,
        "latest_commit": (latest_commit[:7] if isinstance(latest_commit, str) and len(latest_commit) >= 7 else latest_commit),
        "release_url": state.get("release_url"),
        "update_available": update_available,
        "auto_update_enabled": bool(state.get("auto_update_enabled", True)),
        "last_checked_at": state.get("last_checked_at"),
        "last_updated_at": state.get("last_updated_at"),
        "last_error": state.get("last_error"),
        "smoke_ok": state.get("smoke_ok"),
        "server_name": cfg["server_name"],
        "adapted_tools": cfg["tools"],
    }


def set_agy_fast_config(*, auto_update_enabled: bool, plugin_dir: Path | None = None) -> dict[str, Any]:
    base = plugin_dir or get_agy_fast_dir()
    _write_state({"auto_update_enabled": bool(auto_update_enabled)}, base)
    return get_agy_fast_status(base)


def check_agy_fast_update(plugin_dir: Path | None = None) -> dict[str, Any]:
    """Query GitHub for the latest release & main commit of INK-Q/agy-fast."""
    base = plugin_dir or get_agy_fast_dir()
    manifest = _read_json_safe(base / "plugin.json") or {}
    installed_version = str(manifest.get("version") or "") or None
    git = _git_info(base)
    installed_commit_full = git.get("commit_full")

    release = _fetch_github_latest_release()
    remote_commit = _fetch_remote_main_commit(base)

    if release is None and remote_commit is None:
        _write_state({"last_checked_at": _utc_now_iso(), "last_error": "无法连接 GitHub 检查 agy-fast 更新"}, base)
        status = get_agy_fast_status(base)
        status["ok"] = False
        return status

    latest_version = None
    release_url = None
    if release:
        tag = str(release.get("tag_name") or "").strip()
        if tag:
            latest_version = tag.lstrip("v")
        release_url = release.get("html_url")

    update_available = False
    if latest_version and installed_version and _is_newer_version(latest_version, installed_version):
        update_available = True
    elif remote_commit and installed_commit_full and remote_commit != installed_commit_full:
        update_available = True
    elif not installed_version:
        update_available = True

    effective_latest_version = latest_version or installed_version
    if latest_version and installed_version and _is_newer_version(installed_version, latest_version):
        effective_latest_version = installed_version

    _write_state(
        {
            "last_checked_at": _utc_now_iso(),
            "latest_version": effective_latest_version,
            "latest_commit": remote_commit,
            "release_url": release_url,
            "update_available": update_available,
            "last_error": None,
        },
        base,
    )
    status = get_agy_fast_status(base)
    status["ok"] = True
    return status


def update_agy_fast_plugin(
    *,
    force: bool = False,
    only_if_auto_enabled: bool = False,
    plugin_dir: Path | None = None,
) -> dict[str, Any]:
    """Pull latest INK-Q/agy-fast from GitHub, smoke-test, auto-adapt tools/rules, or rollback on failure."""
    base = plugin_dir or get_agy_fast_dir()
    with _update_lock:
        state = _read_state(base)
        if only_if_auto_enabled and not state.get("auto_update_enabled", True):
            return {
                "ok": True,
                "skipped": True,
                "reason": "auto_update_disabled",
                "status": get_agy_fast_status(base),
            }

        prev_manifest = _read_json_safe(base / "plugin.json") or {}
        prev_version = str(prev_manifest.get("version") or "") or None
        prev_git = _git_info(base)
        prev_commit = prev_git.get("commit_full")

        # Preserve user's personal rules/AGENTS.local.md across git reset
        local_rules_path = base / "rules" / "AGENTS.local.md"
        local_rules_backup: str | None = None
        if local_rules_path.is_file():
            try:
                local_rules_backup = local_rules_path.read_text(encoding="utf-8")
            except OSError:
                local_rules_backup = None

        try:
            if not (base / ".git").exists():
                base.parent.mkdir(parents=True, exist_ok=True)
                preserved_state = dict(state)
                if base.exists():
                    shutil.rmtree(base, ignore_errors=True)
                clone_res = _run_cmd(["git", "clone", "--depth", "1", AGY_FAST_REPO_URL, str(base)])
                if clone_res.returncode != 0:
                    err = (clone_res.stderr or clone_res.stdout).strip()[:400]
                    _write_state(
                        {**preserved_state, "last_checked_at": _utc_now_iso(), "last_error": f"git clone failed: {err}"},
                        base,
                    )
                    return {"ok": False, "error": f"git clone failed: {err}", "status": get_agy_fast_status(base)}
                _write_state(preserved_state, base)
            else:
                fetch_res = _run_cmd(["git", "fetch", "--depth", "1", "origin", "main"], cwd=base)
                if fetch_res.returncode != 0:
                    err = (fetch_res.stderr or fetch_res.stdout).strip()[:400]
                    _write_state({"last_checked_at": _utc_now_iso(), "last_error": f"git fetch failed: {err}"}, base)
                    return {"ok": False, "error": f"git fetch failed: {err}", "status": get_agy_fast_status(base)}

                target_rev = _run_cmd(["git", "rev-parse", "FETCH_HEAD"], cwd=base, timeout=5.0)
                new_commit_target = target_rev.stdout.strip() if target_rev.returncode == 0 else None
                if not force and prev_commit and new_commit_target and prev_commit == new_commit_target:
                    smoke = smoke_test_agy_fast(base)
                    _write_state(
                        {
                            "last_checked_at": _utc_now_iso(),
                            "latest_version": prev_version,
                            "latest_commit": prev_commit,
                            "update_available": False,
                            "smoke_ok": bool(smoke.get("ok")),
                            "adapted_tools": smoke.get("tools") or state.get("adapted_tools") or list(DEFAULT_TOOLS),
                            "last_error": None if smoke.get("ok") else smoke.get("error"),
                        },
                        base,
                    )
                    return {
                        "ok": True,
                        "updated": False,
                        "previous_version": prev_version,
                        "current_version": prev_version,
                        "status": get_agy_fast_status(base),
                    }

                reset_res = _run_cmd(["git", "reset", "--hard", "FETCH_HEAD"], cwd=base)
                if reset_res.returncode != 0:
                    err = (reset_res.stderr or reset_res.stdout).strip()[:400]
                    _write_state({"last_checked_at": _utc_now_iso(), "last_error": f"git reset failed: {err}"}, base)
                    return {"ok": False, "error": f"git reset failed: {err}", "status": get_agy_fast_status(base)}

            if local_rules_backup is not None:
                local_rules_path.parent.mkdir(parents=True, exist_ok=True)
                local_rules_path.write_text(local_rules_backup, encoding="utf-8")

            # Build dist/*.mjs fallback if upstream commit did not bundle prebuilt artifacts
            build_script = base / "scripts" / "build.mjs"
            if not (base / "dist" / "mcp-server.mjs").is_file() and build_script.is_file():
                _run_cmd([resolve_node_bin(), str(build_script)], cwd=base, timeout=30.0)

            with _cache_lock:
                _rules_cache.clear()
                _git_info_cache.clear()
                _snapshot_cache.clear()

            # Live smoke verification + automatic tool discovery/adaptation
            smoke = smoke_test_agy_fast(base)
            if not smoke.get("ok"):
                rolled_back = False
                if prev_commit and (base / ".git").exists():
                    rb = _run_cmd(["git", "reset", "--hard", prev_commit], cwd=base)
                    rolled_back = rb.returncode == 0
                    if local_rules_backup is not None:
                        local_rules_path.parent.mkdir(parents=True, exist_ok=True)
                        local_rules_path.write_text(local_rules_backup, encoding="utf-8")
                    with _cache_lock:
                        _rules_cache.clear()
                        _git_info_cache.clear()
                err = str(smoke.get("error") or "Smoke verification failed")
                _write_state(
                    {
                        "last_checked_at": _utc_now_iso(),
                        "smoke_ok": False,
                        "last_error": f"更新验证失败已回滚: {err}" if rolled_back else f"更新验证失败: {err}",
                    },
                    base,
                )
                return {
                    "ok": False,
                    "rolled_back": rolled_back,
                    "error": err,
                    "status": get_agy_fast_status(base),
                }

            # Clear cached rules so next turn immediately uses the updated plugin
            with _cache_lock:
                _rules_cache.clear()
                _git_info_cache.clear()
                _snapshot_cache.clear()
            new_git = _git_info(base)
            new_version = str(smoke.get("version") or prev_version or "")
            changed = (new_git.get("commit_full") != prev_commit) or (new_version != prev_version)
            now = _utc_now_iso()
            _write_state(
                {
                    "last_checked_at": now,
                    "last_updated_at": now if changed else state.get("last_updated_at") or now,
                    "latest_version": new_version,
                    "latest_commit": new_git.get("commit_full"),
                    "update_available": False,
                    "smoke_ok": True,
                    "adapted_tools": smoke.get("tools") or list(DEFAULT_TOOLS),
                    "last_error": None,
                },
                base,
            )
            return {
                "ok": True,
                "updated": changed,
                "previous_version": prev_version,
                "current_version": new_version,
                "adapted_tools": smoke.get("tools") or list(DEFAULT_TOOLS),
                "status": get_agy_fast_status(base),
            }
        except Exception as exc:
            logger.exception("agy-fast update failed")
            _write_state({"last_checked_at": _utc_now_iso(), "last_error": str(exc)}, base)
            return {"ok": False, "error": str(exc), "status": get_agy_fast_status(base)}


if __name__ == "__main__":
    import sys

    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "check":
        print(json.dumps(check_agy_fast_update(), ensure_ascii=False, indent=2))
    elif cmd == "update":
        only_auto = "--if-auto" in sys.argv[2:]
        force_flag = "--force" in sys.argv[2:]
        result = update_agy_fast_plugin(force=force_flag, only_if_auto_enabled=only_auto)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        sys.exit(0 if result.get("ok") else 1)
    elif cmd == "smoke":
        result = smoke_test_agy_fast()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        sys.exit(0 if result.get("ok") else 1)
    else:
        print(json.dumps(get_agy_fast_status(), ensure_ascii=False, indent=2))
