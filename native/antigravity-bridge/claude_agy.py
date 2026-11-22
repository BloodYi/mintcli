"""Run one opt-in Claude Code turn against the local agy provider."""

import asyncio
import json
import logging
import os
from pathlib import Path
import re
import tempfile

from process_lifecycle import reap_cli_process


logger = logging.getLogger("antigravity-chat")
_slots = asyncio.Semaphore(1)
_bridge = Path(__file__).resolve().parent
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")
_ACP_SESSION_RE = re.compile(
    r"(?:Created conversation|Starting conversation update stream for|Sending user message to conversation)\s+"
    r"([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\b"
)
_ACP_HTTP_RE = re.compile(
    r"URL:\s+(https?://\S+)\s+Trace:\s+([A-Za-z0-9._:-]{1,200})\s+ResponseID:\s+([A-Za-z0-9._:-]{1,200})"
)
_ACP_RESPONSE_ID_RE = re.compile(r"\[streamGenerateContent\] ResponseID:\s+([A-Za-z0-9._:-]{1,200})")


def _append_unique(target: list[str], value: str) -> None:
    if value and value not in target:
        target.append(value)


def _merge_trace(trace: dict[str, list[str]], event: dict) -> None:
    for value in event.get("session_ids") or []:
        if isinstance(value, str) and _UUID_RE.fullmatch(value):
            _append_unique(trace["session_ids"], value)
    for key in ("response_ids", "trace_ids", "upstream_urls"):
        for value in event.get(key) or []:
            if isinstance(value, str) and value.strip():
                _append_unique(trace[key], value.strip())


def _collect_acp_logs(temporary_dir: Path, trace: dict[str, list[str]]) -> None:
    try:
        entries = list(temporary_dir.iterdir())
    except OSError:
        return
    for entry in entries:
        if not entry.is_dir() or not entry.name.startswith("magpie-agy-bridge-"):
            continue
        log_path = entry / "agy-acp.log"
        try:
            text = log_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for match in _ACP_SESSION_RE.finditer(text):
            _append_unique(trace["session_ids"], match.group(1))
        for match in _ACP_HTTP_RE.finditer(text):
            _append_unique(trace["upstream_urls"], match.group(1))
            _append_unique(trace["trace_ids"], match.group(2))
            _append_unique(trace["response_ids"], match.group(3))
        for match in _ACP_RESPONSE_ID_RE.finditer(text):
            _append_unique(trace["response_ids"], match.group(1))
_environment_keys = {
    "home", "path", "lang", "lc_all", "ssh_connection", "dbus_session_bus_address",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy", "ws_proxy", "wss_proxy",
    "node_use_env_proxy",
}


def _worker_environment(source, agy_bin, temporary):
    env = {key: value for key, value in source.items() if key.lower() in _environment_keys}
    profile = Path(temporary) / "claude"
    profile.mkdir(mode=0o700)
    env.update({
        "TMPDIR": temporary,
        "XDG_STATE_HOME": temporary,
        "AGY_PATH": agy_bin,
        "AGY_BRIDGE_GEMINI_DIR": "default",
        "AGY_BRIDGE_SPARE": "0",
        "AGY_BRIDGE_MAX_PROCS": "1",
        "AGY_BRIDGE_EVENTS": "0",
        "AGY_BRIDGE_SYSTEM_APPEND": "0",
        "AGY_BRIDGE_MINIMAL_AGENT": "0",
        "AGY_CLI_DISABLE_AUTO_UPDATE": "true",
        "MINTCLI_REPO": str(_bridge.parents[1]),
        "MINTCLI_MAGPIE_AGY": os.getenv(
            "MINTCLI_MAGPIE_AGY", "/opt/mintcli-magpie-agy"
        ),
        "MINTCLI_CLAUDE_PATH": os.getenv(
            "MINTCLI_CLAUDE_PATH", "/var/lib/cloudcli/cli/bin/claude"
        ),
    })
    return env, str(profile)


async def stream_claude_agy(
    *, agy_bin, env, cwd, scratch, prompt, model, turn_id, sandbox, system_append=None,
):
    if _slots.locked():
        yield {"event": "error", "error": "Claude → agy 正在处理另一条回复，请稍后重试。"}
        return
    async with _slots:
        with tempfile.TemporaryDirectory(prefix="claude-agy-", dir=scratch) as temporary:
            worker_env, claude_home = _worker_environment(env, agy_bin, temporary)
            payload = {
                "prompt": prompt, "model": model, "cwd": cwd, "claudeHome": claude_home,
                "turnId": turn_id, "sandbox": sandbox,
            }
            if system_append:
                payload["systemAppend"] = system_append
            argv = [
                os.getenv("MINTCLI_NODE_BIN", "/opt/mintcli-node/bin/node"),
                str(_bridge / "claude-agy.mjs"),
            ]
            scope = None
            if os.getenv("MINTCLI_CLAUDE_WORKER_SCOPE") == "1":
                scope = "mintcli-claude-agy-" + turn_id + ".scope"
                argv = [
                    "/usr/bin/systemd-run", "--quiet", "--scope", "--unit=" + scope,
                    "--slice=mintcli.slice", "--property=MemoryMax=7G",
                    "--property=MemorySwapMax=1G", "--property=OOMPolicy=kill", "--", *argv,
                ]
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, start_new_session=True,
                env=worker_env, limit=32 * 1024 * 1024,
            )
            stderr_tail = bytearray()

            async def _drain_stderr() -> None:
                assert proc.stderr is not None
                while True:
                    chunk = await proc.stderr.read(4096)
                    if not chunk:
                        return
                    stderr_tail.extend(chunk)
                    del stderr_tail[:-4096]

            stderr_task = asyncio.create_task(_drain_stderr())
            terminal = False
            saw_error = False
            agy_trace: dict[str, list[str]] = {
                "session_ids": [],
                "response_ids": [],
                "trace_ids": [],
                "upstream_urls": [],
            }
            try:
                proc.stdin.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
                await asyncio.wait_for(proc.stdin.drain(), timeout=30)
                proc.stdin.close()
                while line := await proc.stdout.readline():
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        logger.warning(
                            "claude-agy emitted non-JSON stdout: %s",
                            line[:200].decode("utf-8", errors="replace").strip(),
                        )
                        continue
                    kind = event.get("event")
                    if kind == "agy_trace":
                        _merge_trace(agy_trace, event)
                        if any(agy_trace.values()):
                            yield {
                                "event": "agy_trace",
                                **{key: list(values) for key, values in agy_trace.items()},
                            }
                        continue
                    terminal |= kind in ("result", "error")
                    saw_error |= kind == "error"
                    yield event
                try:
                    await asyncio.wait_for(proc.wait(), timeout=5)
                except asyncio.TimeoutError:
                    pass
                await reap_cli_process(proc)
                _collect_acp_logs(Path(temporary), agy_trace)
                try:
                    await asyncio.wait_for(stderr_task, timeout=1)
                except asyncio.TimeoutError:
                    pass
                err_txt = stderr_tail.decode("utf-8", errors="replace").strip()
                if (saw_error or not terminal) and err_txt:
                    logger.warning("claude-agy failed (rc=%s): %s", proc.returncode, err_txt)
                if not terminal:
                    error = "Claude → agy 进程提前退出。"
                    if proc.returncode in (-9, 137):
                        error = "本轮进程被系统终止，可能达到内存上限。请缩小任务或分批运行测试后重试。"
                    yield {"event": "error", "error": error}
                if any(agy_trace.values()):
                    yield {
                        "event": "agy_trace",
                        "final": True,
                        **{key: list(values) for key, values in agy_trace.items()},
                    }
            finally:
                await reap_cli_process(proc)
                if scope:
                    # Also terminate descendants that started a separate process group.
                    try:
                        stop = await asyncio.create_subprocess_exec(
                            "/usr/bin/systemctl", "--no-block", "stop", scope,
                            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                        )
                        await asyncio.wait_for(stop.wait(), timeout=3)
                    except (OSError, asyncio.TimeoutError):
                        logger.warning("Could not stop worker scope %s", scope)
                if not stderr_task.done():
                    stderr_task.cancel()
                try:
                    await stderr_task
                except BaseException:
                    pass
