"""Run one opt-in Claude Code turn against the local agy provider."""

import asyncio
import json
import logging
import os
from pathlib import Path
import re
import tempfile

from armor_engine import (
    MAX_ARMOR_RETRIES,
    detect_prompt_lang,
    get_escalation_prompt,
    soften_prompt,
)
from process_lifecycle import reap_cli_process
from think_lang_engine import append_think_lang_reminder


logger = logging.getLogger("antigravity-chat")


def _configured_max_concurrency() -> int:
    raw = os.getenv("MINTCLI_CLAUDE_AGY_MAX_CONCURRENCY", "").strip()
    try:
        parsed = int(raw)
        if parsed >= 1:
            return parsed
    except ValueError:
        pass
    return 6


_MAX_CONCURRENCY = _configured_max_concurrency()
_slots = asyncio.Semaphore(_MAX_CONCURRENCY)
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
    register_injector=None, use_armor: bool = False,
    use_think_lang: bool = False, think_lang_user_text: str | None = None, think_lang_history=None,
    use_agy_fast: bool = False, agy_fast_mcp_servers=None, agy_fast_allowed_tools=None,
    is_shutting_down=None,
):
    if _slots.locked():
        yield {
            "event": "error",
            "error": f"Claude → agy 当前并发对话已达上限（{_MAX_CONCURRENCY} 个），请稍后重试。",
        }
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
            if use_agy_fast and agy_fast_mcp_servers:
                payload["useAgyFast"] = True
                payload["agyFastMcpServers"] = agy_fast_mcp_servers
                if agy_fast_allowed_tools:
                    payload["agyFastAllowedTools"] = list(agy_fast_allowed_tools)
            if use_armor:
                lang = detect_prompt_lang(prompt)
                payload["useArmor"] = True
                payload["armorEscalations"] = [
                    get_escalation_prompt(attempt=idx, lang=lang, original_prompt=prompt)
                    for idx in range(MAX_ARMOR_RETRIES)
                ]
            turn_lang_history = list(think_lang_history or [])
            seed_user_text = think_lang_user_text if think_lang_user_text is not None else prompt
            if use_think_lang and payload.get("prompt"):
                payload["prompt"], _ = append_think_lang_reminder(
                    payload["prompt"],
                    user_text=seed_user_text,
                    history_user_texts=turn_lang_history,
                )
            if seed_user_text and str(seed_user_text).strip():
                turn_lang_history.append(str(seed_user_text))
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

            ready_event = asyncio.Event()
            startup_failed = False
            accepting_input = True
            stdin_lock = asyncio.Lock()
            pending_acks: dict[str, asyncio.Future[bool]] = {}
            proc: asyncio.subprocess.Process | None = None
            stderr_task: asyncio.Task | None = None
            stdout_task: asyncio.Task | None = None

            def _fail_pending_acks() -> None:
                for fut in list(pending_acks.values()):
                    if not fut.done():
                        fut.set_result(False)
                pending_acks.clear()

            def _close_stdin() -> None:
                if proc is not None and proc.stdin is not None and not proc.stdin.is_closing():
                    try:
                        proc.stdin.close()
                    except OSError:
                        pass

            async def _inject_message(content: str, message_uuid: str) -> bool:
                if use_armor and content:
                    content, _ = soften_prompt(content)
                outbound_content = content
                if use_think_lang and outbound_content:
                    outbound_content, _ = append_think_lang_reminder(
                        outbound_content,
                        user_text=content,
                        history_user_texts=turn_lang_history,
                    )
                if content and content.strip():
                    turn_lang_history.append(content)
                try:
                    await asyncio.wait_for(ready_event.wait(), timeout=15)
                except asyncio.TimeoutError:
                    return False
                if (
                    startup_failed
                    or not accepting_input
                    or proc is None
                    or proc.returncode is not None
                    or proc.stdin is None
                    or proc.stdin.is_closing()
                ):
                    return False
                loop = asyncio.get_running_loop()
                ack: asyncio.Future[bool] = loop.create_future()
                pending_acks[message_uuid] = ack
                try:
                    async with stdin_lock:
                        if (
                            not accepting_input
                            or proc.returncode is not None
                            or proc.stdin.is_closing()
                        ):
                            pending_acks.pop(message_uuid, None)
                            return False
                        frame = json.dumps(
                            {"type": "user_message", "uuid": message_uuid, "content": outbound_content},
                            ensure_ascii=False,
                        ) + "\n"
                        proc.stdin.write(frame.encode("utf-8"))
                        await asyncio.wait_for(proc.stdin.drain(), timeout=10)
                    return bool(await asyncio.wait_for(ack, timeout=10))
                except (OSError, asyncio.TimeoutError, asyncio.CancelledError, ConnectionError):
                    pending_acks.pop(message_uuid, None)
                    return False

            if register_injector:
                register_injector(_inject_message)

            terminal = False
            saw_error = False
            agy_trace: dict[str, list[str]] = {
                "session_ids": [],
                "response_ids": [],
                "trace_ids": [],
                "upstream_urls": [],
            }
            stderr_tail = bytearray()
            event_queue: asyncio.Queue[dict | None] = asyncio.Queue()
            try:
                proc = await asyncio.create_subprocess_exec(
                    *argv,
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE, start_new_session=True,
                    env=worker_env, limit=32 * 1024 * 1024,
                )

                async def _drain_stderr() -> None:
                    assert proc is not None and proc.stderr is not None
                    while True:
                        chunk = await proc.stderr.read(4096)
                        if not chunk:
                            return
                        stderr_tail.extend(chunk)
                        del stderr_tail[:-4096]

                async def _read_stdout() -> None:
                    nonlocal accepting_input
                    assert proc is not None and proc.stdout is not None
                    try:
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
                            if kind == "user_message_queued":
                                msg_uuid = str(event.get("uuid") or "")
                                fut = pending_acks.pop(msg_uuid, None)
                                if fut is not None and not fut.done():
                                    fut.set_result(True)
                                continue
                            if kind == "inject_rejected":
                                msg_uuid = str(event.get("uuid") or "")
                                fut = pending_acks.pop(msg_uuid, None)
                                if fut is not None and not fut.done():
                                    fut.set_result(False)
                                continue
                            if kind in ("result", "error"):
                                accepting_input = False
                                _fail_pending_acks()
                                _close_stdin()
                            await event_queue.put(event)
                    finally:
                        accepting_input = False
                        _fail_pending_acks()
                        await event_queue.put(None)

                stderr_task = asyncio.create_task(_drain_stderr())
                stdout_task = asyncio.create_task(_read_stdout())

                assert proc.stdin is not None
                async with stdin_lock:
                    proc.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
                    await asyncio.wait_for(proc.stdin.drain(), timeout=30)
                ready_event.set()

                while (event := await event_queue.get()) is not None:
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
                accepting_input = False
                _fail_pending_acks()
                _close_stdin()
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
                    if is_shutting_down and is_shutting_down():
                        raise asyncio.CancelledError
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
                accepting_input = False
                startup_failed = True
                ready_event.set()
                _fail_pending_acks()
                if register_injector:
                    register_injector(None)
                _close_stdin()
                if stdout_task is not None:
                    if not stdout_task.done():
                        stdout_task.cancel()
                    try:
                        await stdout_task
                    except BaseException:
                        pass
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
                if stderr_task is not None:
                    if not stderr_task.done():
                        stderr_task.cancel()
                    try:
                        await stderr_task
                    except BaseException:
                        pass
