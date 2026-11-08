"""Bind each native agy command to the saved routing choice, without global mutation."""
import json
import os
import re
from pathlib import Path


def egress_environment(source: dict[str, str]) -> dict[str, str]:
    root = Path(os.getenv("MINTCLI_EGRESS_ROOT", "/var/lib/cloudcli/egress"))
    if not (root / "inventory.json").exists() and not (root / "selection.json").exists():
        return source.copy()
    selections = json.loads((root / "selection.json").read_text()) if (root / "selection.json").exists() else {"selections": {}}
    selected = selections["selections"].get("antigravity", "legacy")
    port = 0 if selected == "direct" else 17890
    if selected not in ("direct", "legacy"):
        inventory = json.loads((root / "inventory.json").read_text())
        node = next((n for n in inventory["nodes"] if n["id"] == selected), None)
        if not node:
            raise RuntimeError("Selected egress node is unavailable; select another node")
        port = node["port"]
    env = {k: v for k, v in source.items() if not re.fullmatch(r"(?:(?:http|https|all|ws|wss|no)_proxy|node_use_env_proxy)", k, re.I)}
    if port:
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "WS_PROXY", "WSS_PROXY", "http_proxy", "https_proxy", "all_proxy", "ws_proxy", "wss_proxy"):
            env[key] = f"http://127.0.0.1:{port}"
    env["NODE_USE_ENV_PROXY"] = "1" if port else "0"
    env["NO_PROXY"] = env["no_proxy"] = "localhost,127.0.0.1,::1"
    return env
