"""Official `agy acp` stdio JSON-RPC 2.0 client for antigravity-bridge.

Connects directly to the first-party `agy acp` CLI server over stdio without any
HTTP reverse proxy or upstream profile spoofing.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable
from process_lifecycle import reap_cli_process

logger = logging.getLogger("antigravity-chat.acp")
ACP_SETUP_TIMEOUT_SECONDS = 30.0
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


def _collect_acp_log_trace(log_path: Path, session_id: str | None = None) -> dict[str, list[str]]:
    trace: dict[str, list[str]] = {
        "session_ids": [],
        "response_ids": [],
        "trace_ids": [],
        "upstream_urls": [],
    }
    if session_id and _UUID_RE.fullmatch(session_id):
        _append_unique(trace["session_ids"], session_id)
    try:
        text = log_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return trace
    for match in _ACP_SESSION_RE.finditer(text):
        _append_unique(trace["session_ids"], match.group(1))
    for match in _ACP_HTTP_RE.finditer(text):
        _append_unique(trace["upstream_urls"], match.group(1))
        _append_unique(trace["trace_ids"], match.group(2))
        _append_unique(trace["response_ids"], match.group(3))
    for match in _ACP_RESPONSE_ID_RE.finditer(text):
        _append_unique(trace["response_ids"], match.group(1))
    return trace


def _extract_content_text(content: Any) -> str:
    """Extract plain text from an ACP content block or list of blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        if content.get("type") == "text" and isinstance(content.get("text"), str):
            return content["text"]
        if isinstance(content.get("content"), (dict, list, str)):
            return _extract_content_text(content["content"])
        if isinstance(content.get("text"), str):
            return content["text"]
        return ""
    if isinstance(content, list):
        return "".join(_extract_content_text(item) for item in content)
    return ""


def _normalize_acp_usage(raw: Any) -> dict[str, int] | None:
    if not isinstance(raw, dict):
        return None
    usage: dict[str, int] = {}
    mapping = (
        ("inputTokens", "input_tokens"),
        ("outputTokens", "output_tokens"),
        ("thoughtTokens", "thinking_tokens"),
        ("cachedReadTokens", "cache_read_tokens"),
        ("totalTokens", "total_tokens"),
    )
    for src, dst in mapping:
        val = raw.get(src)
        if isinstance(val, int) and not isinstance(val, bool):
            usage[dst] = val
    if "total_tokens" not in usage and ("input_tokens" in usage or "output_tokens" in usage):
        usage["total_tokens"] = usage.get("input_tokens", 0) + usage.get("output_tokens", 0)
    return usage or None


def _permission_response(req_id: Any, params: Any) -> dict[str, Any]:
    """Auto-approve ACP permission requests when running headless with skip-permissions."""
    options = params.get("options") if isinstance(params, dict) else None
    option_id = None
    if isinstance(options, list):
        for preferred_kind in ("allow_always", "allow_once"):
            for opt in options:
                if isinstance(opt, dict) and opt.get("kind") == preferred_kind and opt.get("optionId"):
                    option_id = opt["optionId"]
                    break
            if option_id:
                break
        if not option_id:
            for opt in options:
                if isinstance(opt, dict) and opt.get("optionId"):
                    option_id = opt["optionId"]
                    break
    if option_id:
        return {"jsonrpc": "2.0", "id": req_id, "result": {"outcome": {"outcome": "selected", "optionId": option_id}}}
    return {"jsonrpc": "2.0", "id": req_id, "result": {"outcome": {"outcome": "cancelled"}}}


def _server_request_response(message: dict[str, Any]) -> dict[str, Any]:
    if message.get("method") == "session/request_permission":
        return _permission_response(message["id"], message.get("params"))
    # We advertise no client filesystem/terminal capabilities. Unsupported
    # requests must receive a JSON-RPC error, not a permission-shaped result.
    return {"jsonrpc": "2.0", "id": message["id"], "error": {
        "code": -32601, "message": "Unsupported ACP client method: " + str(message.get("method")),
    }}


def _merge_acp_usage(acc: dict[str, int], extra: dict[str, int] | None) -> dict[str, int]:
    if not extra:
        return acc
    for key, val in extra.items():
        acc[key] = acc.get(key, 0) + val
    return acc


async def stream_agy_acp(
    *,
    agy_bin: str,
    prompt: str,
    model: str | None,
    target_cwd: str,
    run_env: dict[str, str],
    scratch_dir: Path,
    conversation_id: str | None = None,
    user_id: str = "default",
    persist_conversation: bool = True,
    save_conversation_cb: Callable[[str, str], Awaitable[Any]] | None = None,
    route_info_factory: Callable[[str | None, str | None], dict] | None = None,
    route_enricher: Callable[[dict[str, Any], dict[str, list[str]]], None] | None = None,
    system_append: str | None = None,
    fallback_prompt: str | None = None,
    update_lease: Any = None,
    timeout: int = 0,
    register_injector: Callable[[Callable[[str, str], Awaitable[bool]] | None], None] | None = None,
):
    """Run one turn against the official `agy acp` stdio server and yield bridge events."""
    started_at = time.monotonic()
    route_info = route_info_factory(uuid.uuid4().hex, model) if route_info_factory else {
        "request_id": uuid.uuid4().hex,
        "requested_model": model,
        "transport": "acp",
    }
    route_info["transport"] = "acp"
    if model and model != "default":
        route_info["cli_config_model"] = model

    log_dir = tempfile.TemporaryDirectory(prefix="agy-acp-", dir=str(scratch_dir))
    log_path = Path(log_dir.name) / "acp.log"

    argv = [
        agy_bin,
        "acp",
        "--dangerously-skip-permissions",
        "--add-dir",
        target_cwd,
        "--log-file",
        str(log_path),
    ]

    proc: asyncio.subprocess.Process | None = None
    stderr_tail = bytearray()
    stderr_task: asyncio.Task | None = None
    session_id: str | None = None
    next_id = 1
    phase = "initialize"
    setup_complete = False
    send_lock = asyncio.Lock()
    prompt_ready = asyncio.Event()
    startup_failed = False
    accepting_input = True
    pending_prompt_ids: dict[int, str | None] = {}
    ordered_prompt_ids: list[int] = []

    async def _send(payload: dict[str, Any]) -> None:
        assert proc is not None and proc.stdin is not None
        data = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        async with send_lock:
            proc.stdin.write(data)
            await asyncio.wait_for(proc.stdin.drain(), timeout=ACP_SETUP_TIMEOUT_SECONDS)

    async def _inject_message(content: str, message_uuid: str) -> bool:
        nonlocal next_id
        try:
            await asyncio.wait_for(prompt_ready.wait(), timeout=ACP_SETUP_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            return False
        if (
            startup_failed
            or not accepting_input
            or not session_id
            or proc is None
            or proc.returncode is not None
            or proc.stdin is None
            or proc.stdin.is_closing()
        ):
            return False
        req_id = next_id
        next_id += 1
        pending_prompt_ids[req_id] = message_uuid
        ordered_prompt_ids.append(req_id)
        try:
            await _send(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "method": "session/prompt",
                    "params": {
                        "sessionId": session_id,
                        "prompt": [{"type": "text", "text": content}],
                    },
                }
            )
            return True
        except Exception:
            pending_prompt_ids.pop(req_id, None)
            if req_id in ordered_prompt_ids:
                ordered_prompt_ids.remove(req_id)
            return False

    async def _read_message(deadline: float | None) -> dict[str, Any] | None:
        assert proc is not None and proc.stdout is not None
        while True:
            if deadline is None:
                raw_line = await proc.stdout.readline()
            else:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise asyncio.TimeoutError
                raw_line = await asyncio.wait_for(proc.stdout.readline(), timeout=remaining)
            if not raw_line:
                return None
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                logger.debug("Ignoring non-JSON line from agy acp: %s", line[:200])
                continue
            if isinstance(parsed, dict):
                return parsed

    async def _call(method: str, params: dict[str, Any], deadline: float | None) -> dict[str, Any]:
        nonlocal next_id, phase
        phase = method
        req_id = next_id
        next_id += 1
        await _send({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
        while True:
            msg = await _read_message(deadline)
            if msg is None:
                err_txt = stderr_tail.decode("utf-8", errors="replace").strip()
                raise RuntimeError(err_txt or f"agy acp closed stdout during {method}")
            if "id" in msg and "method" in msg:
                await _send(_server_request_response(msg))
                continue
            if msg.get("id") == req_id:
                return msg

    async def _reap() -> None:
        await reap_cli_process(proc)

    try:
        if register_injector:
            register_injector(_inject_message)
        # Never use DesktopProfileProxy or reverse proxies in ACP mode; talk directly to `agy acp`.
        acp_env = dict(run_env)
        acp_env.pop("AGY_UPSTREAM_PROFILE", None)

        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=target_cwd,
            env=acp_env,
            start_new_session=os.name == "posix",
            limit=1024 * 1024,
        )

        async def _drain_stderr() -> None:
            assert proc is not None and proc.stderr is not None
            while True:
                chunk = await proc.stderr.read(4096)
                if not chunk:
                    return
                stderr_tail.extend(chunk)
                del stderr_tail[:-4000]

        stderr_task = asyncio.create_task(_drain_stderr())
        deadline = asyncio.get_running_loop().time() + timeout if timeout > 0 else None
        setup_deadline = asyncio.get_running_loop().time() + ACP_SETUP_TIMEOUT_SECONDS
        if deadline is not None:
            setup_deadline = min(setup_deadline, deadline)

        # 1. ACP initialize handshake
        init_res = await _call(
            "initialize",
            {
                "protocolVersion": 1,
                "clientCapabilities": {},
                "clientInfo": {"name": "mintcli-bridge", "version": "1.0.0"},
            },
            setup_deadline,
        )
        if "error" in init_res:
            err = init_res["error"]
            msg = err.get("message") if isinstance(err, dict) else str(err)
            yield {"event": "error", "error": f"agy acp initialize failed: {msg}"}
            return

        init_result = init_res.get("result") if isinstance(init_res.get("result"), dict) else {}
        agent_caps = init_result.get("agentCapabilities") if isinstance(init_result.get("agentCapabilities"), dict) else {}
        meta_caps = agent_caps.get("_meta") if isinstance(agent_caps.get("_meta"), dict) else {}
        agy_caps = meta_caps.get("antigravity") if isinstance(meta_caps.get("antigravity"), dict) else {}
        sys_caps = agy_caps.get("systemPrompt") if isinstance(agy_caps.get("systemPrompt"), dict) else {}
        supports_system_append = sys_caps.get("append") is True

        clean_system_append = (system_append or "").strip()
        session_meta: dict[str, Any] = {}
        if clean_system_append and supports_system_append:
            session_meta = {"_meta": {"antigravity": {"systemPrompt": {"append": clean_system_append}}}}

        # 2. Resume existing session or create a new one
        session_res: dict[str, Any] | None = None
        resumed_existing = False
        if conversation_id:
            resumed = await _call(
                "session/resume",
                {"sessionId": conversation_id, "cwd": target_cwd, "mcpServers": [], **session_meta},
                setup_deadline,
            )
            if "error" not in resumed and isinstance(resumed.get("result"), dict):
                session_res = resumed
                resumed_existing = True
            else:
                logger.info("agy acp session/resume fell back to session/new for %s", conversation_id)

        if session_res is None:
            session_res = await _call(
                "session/new",
                {"cwd": target_cwd, "mcpServers": [], **session_meta},
                setup_deadline,
            )
        if "error" in session_res:
            err = session_res["error"]
            msg = err.get("message") if isinstance(err, dict) else str(err)
            yield {"event": "error", "error": f"agy acp session failed: {msg}"}
            return

        result_obj = session_res.get("result") if isinstance(session_res.get("result"), dict) else {}
        session_id = str(result_obj.get("sessionId") or conversation_id or "")
        if session_id:
            if persist_conversation and save_conversation_cb:
                await save_conversation_cb(user_id, session_id)
            yield {
                "event": "init",
                "conversation_id": session_id,
                "model": model,
                "transport": "acp",
                "route_info": json.loads(json.dumps(route_info)),
            }

        # 3. Select model if requested
        if model and model != "default" and session_id:
            model_res = await _call(
                "session/set_model",
                {"sessionId": session_id, "modelId": model},
                setup_deadline,
            )
            if "error" in model_res:
                err = model_res["error"]
                logger.warning("agy acp session/set_model(%s) failed: %s", model, err)

        # 4. Stream prompt turn
        setup_complete = True
        phase = "session/prompt"
        prompt_req_id = next_id
        next_id += 1
        effective_prompt = fallback_prompt if (not resumed_existing and fallback_prompt) else prompt
        if clean_system_append and not supports_system_append and not resumed_existing:
            effective_prompt = f"{clean_system_append}\n\n{effective_prompt}" if effective_prompt else clean_system_append
        pending_prompt_ids[prompt_req_id] = None
        ordered_prompt_ids.append(prompt_req_id)
        await _send(
            {
                "jsonrpc": "2.0",
                "id": prompt_req_id,
                "method": "session/prompt",
                "params": {
                    "sessionId": session_id,
                    "prompt": [{"type": "text", "text": effective_prompt}],
                },
            }
        )
        prompt_ready.set()

        accumulated_text: list[str] = []
        merged_usage: dict[str, int] = {}
        while True:
            msg = await _read_message(deadline)
            if msg is None:
                accepting_input = False
                err_txt = stderr_tail.decode("utf-8", errors="replace").strip()
                yield {"event": "error", "error": err_txt or "agy acp terminated unexpectedly"}
                return

            # Handle server -> client JSON-RPC requests (e.g. permission prompts)
            if "id" in msg and "method" in msg:
                await _send(_server_request_response(msg))
                continue

            # Handle streaming session/update notifications
            if msg.get("method") == "session/update":
                params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
                update = params.get("update") if isinstance(params.get("update"), dict) else {}
                kind = update.get("sessionUpdate")

                if kind == "agent_message_chunk":
                    text = _extract_content_text(update.get("content"))
                    if text:
                        accumulated_text.append(text)
                        yield {"event": "delta", "delta": text}
                elif kind == "agent_thought_chunk":
                    thought = _extract_content_text(update.get("content"))
                    if thought:
                        yield {"event": "thinking", "thinking": thought}
                elif kind in ("tool_call", "tool_call_update"):
                    tool_name = str(
                        update.get("title")
                        or update.get("name")
                        or update.get("kind")
                        or "tool"
                    )
                    status = str(update.get("status") or "running")
                    tool_event: dict[str, Any] = {
                        "event": "tool",
                        "tool": tool_name,
                        "tool_name": str(update.get("name") or update.get("kind") or tool_name),
                        "status": status,
                    }
                    tool_id = update.get("toolCallId") or update.get("id")
                    if tool_id:
                        tool_event["tool_id"] = str(tool_id)
                    raw_input = update.get("rawInput")
                    if raw_input is None:
                        raw_input = update.get("input") if update.get("input") is not None else update.get("arguments")
                    if raw_input is not None:
                        tool_event["tool_input"] = raw_input
                    raw_output = update.get("rawOutput")
                    if raw_output is None:
                        raw_output = update.get("output") if update.get("output") is not None else update.get("result")
                    if raw_output is None and update.get("content") is not None:
                        extracted = _extract_content_text(update.get("content"))
                        if extracted:
                            raw_output = extracted
                    if raw_output is not None:
                        tool_event["tool_output"] = (
                            raw_output if isinstance(raw_output, str) else json.dumps(raw_output, ensure_ascii=False)
                        )
                    yield tool_event
                continue

            # Handle final or handoff response for any in-flight session/prompt
            msg_id = msg.get("id")
            if isinstance(msg_id, int) and msg_id in pending_prompt_ids:
                pending_prompt_ids.pop(msg_id, None)
                if msg_id in ordered_prompt_ids:
                    ordered_prompt_ids.remove(msg_id)
                if "error" in msg:
                    err = msg["error"]
                    err_msg = err.get("message") if isinstance(err, dict) else str(err)
                    if pending_prompt_ids:
                        logger.warning("agy acp intermediate prompt %s returned error: %s", msg_id, err_msg)
                        accumulated_text.clear()
                        next_req = next((rid for rid in ordered_prompt_ids if rid in pending_prompt_ids), None)
                        next_uuid = pending_prompt_ids.get(next_req) if next_req is not None else None
                        if next_uuid:
                            yield {"event": "user_message_applied", "uuid": next_uuid}
                        continue
                    accepting_input = False
                    if route_enricher:
                        trace = await asyncio.to_thread(_collect_acp_log_trace, log_path, session_id)
                        await asyncio.to_thread(route_enricher, route_info, trace)
                    yield {"event": "error", "error": err_msg or "agy acp prompt failed"}
                    break

                res = msg.get("result") if isinstance(msg.get("result"), dict) else {}
                _merge_acp_usage(merged_usage, _normalize_acp_usage(res.get("usage")))
                if pending_prompt_ids:
                    # A live follow-up session/prompt is already queued/active inside agy acp.
                    # Stay connected and transition into the new assistant segment without closing.
                    accumulated_text.clear()
                    next_req = next((rid for rid in ordered_prompt_ids if rid in pending_prompt_ids), None)
                    next_uuid = pending_prompt_ids.get(next_req) if next_req is not None else None
                    if next_uuid:
                        yield {"event": "user_message_applied", "uuid": next_uuid}
                    continue

                accepting_input = False
                if route_enricher:
                    trace = await asyncio.to_thread(_collect_acp_log_trace, log_path, session_id)
                    await asyncio.to_thread(route_enricher, route_info, trace)
                result_event: dict[str, Any] = {
                    "event": "result",
                    "response": "".join(accumulated_text),
                    "duration_seconds": round(time.monotonic() - started_at, 2),
                    "route_info": json.loads(json.dumps(route_info)),
                }
                if merged_usage:
                    result_event["usage"] = dict(merged_usage)
                yield result_event
                break

        yield {"event": "metadata", "route_info": json.loads(json.dumps(route_info))}

    except asyncio.CancelledError:
        accepting_input = False
        if proc is not None and proc.returncode is None and session_id:
            try:
                await _send(
                    {
                        "jsonrpc": "2.0",
                        "method": "session/cancel",
                        "params": {"sessionId": session_id},
                    }
                )
            except Exception:
                pass
        raise
    except asyncio.TimeoutError:
        accepting_input = False
        err_txt = stderr_tail.decode("utf-8", errors="replace").strip()
        detail = f" — {err_txt}" if err_txt else ""
        limit = timeout if setup_complete and timeout > 0 else ACP_SETUP_TIMEOUT_SECONDS
        yield {"event": "error", "error": f"antigravity-chat (ACP): {phase} timed out after {limit:g}s{detail}"}
    finally:
        accepting_input = False
        startup_failed = True
        prompt_ready.set()
        if register_injector:
            register_injector(None)
        if stderr_task is not None:
            stderr_task.cancel()
            try:
                await stderr_task
            except (asyncio.CancelledError, Exception):
                pass
        await _reap()
        if update_lease:
            update_lease.close()
        log_dir.cleanup()


async def probe_agy_acp_info(
    agy_bin: str,
    *,
    run_env: dict[str, str] | None = None,
    cwd: str | None = None,
    timeout: float = 10.0,
) -> dict[str, Any]:
    """Probe the first-party `agy acp` server via JSON-RPC `initialize`."""
    proc: asyncio.subprocess.Process | None = None
    stderr_tail = bytearray()
    stderr_task: asyncio.Task | None = None

    def _unavailable(error: str) -> dict[str, Any]:
        return {
            "available": False,
            "protocolVersion": None,
            "serverName": None,
            "serverVersion": None,
            "supportsSystemPromptAppend": False,
            "error": error,
        }

    try:
        acp_env = dict(run_env) if run_env is not None else dict(os.environ)
        acp_env.pop("AGY_UPSTREAM_PROFILE", None)
        proc = await asyncio.create_subprocess_exec(
            agy_bin,
            "acp",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=acp_env,
            start_new_session=os.name == "posix",
            limit=1024 * 1024,
        )

        async def _drain_stderr() -> None:
            assert proc is not None and proc.stderr is not None
            while True:
                chunk = await proc.stderr.read(4096)
                if not chunk:
                    return
                stderr_tail.extend(chunk)
                del stderr_tail[:-2000]

        stderr_task = asyncio.create_task(_drain_stderr())
        deadline = asyncio.get_running_loop().time() + max(timeout, 1.0)

        assert proc.stdin is not None and proc.stdout is not None
        req = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientCapabilities": {},
                "clientInfo": {"name": "mintcli-bridge", "version": "1.0.0"},
            },
        }
        proc.stdin.write((json.dumps(req, ensure_ascii=False) + "\n").encode("utf-8"))
        await asyncio.wait_for(proc.stdin.drain(), timeout=max(deadline - asyncio.get_running_loop().time(), 0.1))

        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                return _unavailable(f"agy acp initialize timed out after {timeout:g}s")
            raw_line = await asyncio.wait_for(proc.stdout.readline(), timeout=remaining)
            if not raw_line:
                err_txt = stderr_tail.decode("utf-8", errors="replace").strip()
                return _unavailable(err_txt or "agy acp closed stdout during initialize")
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict) or msg.get("id") != 1:
                continue
            if "error" in msg:
                err = msg["error"]
                err_msg = err.get("message") if isinstance(err, dict) else str(err)
                return _unavailable(err_msg or "agy acp initialize error")
            result = msg.get("result") if isinstance(msg.get("result"), dict) else {}
            agent_info = result.get("agentInfo") if isinstance(result.get("agentInfo"), dict) else {}
            agent_caps = result.get("agentCapabilities") if isinstance(result.get("agentCapabilities"), dict) else {}
            meta_caps = agent_caps.get("_meta") if isinstance(agent_caps.get("_meta"), dict) else {}
            agy_caps = meta_caps.get("antigravity") if isinstance(meta_caps.get("antigravity"), dict) else {}
            sys_caps = agy_caps.get("systemPrompt") if isinstance(agy_caps.get("systemPrompt"), dict) else {}
            protocol_version = result.get("protocolVersion")
            return {
                "available": True,
                "protocolVersion": protocol_version if isinstance(protocol_version, int) and not isinstance(protocol_version, bool) else None,
                "serverName": str(agent_info.get("name")) if agent_info.get("name") else None,
                "serverVersion": str(agent_info.get("version")) if agent_info.get("version") else None,
                "supportsSystemPromptAppend": sys_caps.get("append") is True,
            }
    except asyncio.TimeoutError:
        return _unavailable(f"agy acp initialize timed out after {timeout:g}s")
    except Exception as exc:
        return _unavailable(str(exc))
    finally:
        if stderr_task is not None:
            stderr_task.cancel()
            try:
                await stderr_task
            except (asyncio.CancelledError, Exception):
                pass
        await reap_cli_process(proc)

