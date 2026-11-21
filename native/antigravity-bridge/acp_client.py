"""Official `agy acp` stdio JSON-RPC 2.0 client for antigravity-bridge.

Connects directly to the first-party `agy acp` CLI server over stdio without any
HTTP reverse proxy or upstream profile spoofing.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable
from process_lifecycle import reap_cli_process

logger = logging.getLogger("antigravity-chat.acp")
ACP_SETUP_TIMEOUT_SECONDS = 30.0


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
    update_lease: Any = None,
    timeout: int = 0,
):
    """Run one turn against the official `agy acp` stdio server and yield bridge events."""
    started_at = time.monotonic()
    route_info = route_info_factory(uuid.uuid4().hex, model) if route_info_factory else {
        "request_id": uuid.uuid4().hex,
        "requested_model": model,
        "transport": "acp",
    }
    route_info["transport"] = "acp"

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

    async def _send(payload: dict[str, Any]) -> None:
        assert proc is not None and proc.stdin is not None
        data = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        proc.stdin.write(data)
        await asyncio.wait_for(proc.stdin.drain(), timeout=ACP_SETUP_TIMEOUT_SECONDS)

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

        # 2. Resume existing session or create a new one
        session_res: dict[str, Any] | None = None
        if conversation_id:
            resumed = await _call(
                "session/resume",
                {"sessionId": conversation_id, "cwd": target_cwd, "mcpServers": []},
                setup_deadline,
            )
            if "error" not in resumed and isinstance(resumed.get("result"), dict):
                session_res = resumed
            else:
                logger.info("agy acp session/resume fell back to session/new for %s", conversation_id)

        if session_res is None:
            session_res = await _call(
                "session/new",
                {"cwd": target_cwd, "mcpServers": []},
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
        await _send(
            {
                "jsonrpc": "2.0",
                "id": prompt_req_id,
                "method": "session/prompt",
                "params": {
                    "sessionId": session_id,
                    "prompt": [{"type": "text", "text": prompt}],
                },
            }
        )

        accumulated_text: list[str] = []
        while True:
            msg = await _read_message(deadline)
            if msg is None:
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
                    yield {"event": "tool", "tool": tool_name, "status": status}
                continue

            # Handle final response for session/prompt
            if msg.get("id") == prompt_req_id:
                if "error" in msg:
                    err = msg["error"]
                    err_msg = err.get("message") if isinstance(err, dict) else str(err)
                    yield {"event": "error", "error": err_msg or "agy acp prompt failed"}
                else:
                    res = msg.get("result") if isinstance(msg.get("result"), dict) else {}
                    usage = _normalize_acp_usage(res.get("usage"))
                    result_event: dict[str, Any] = {
                        "event": "result",
                        "response": "".join(accumulated_text),
                        "duration_seconds": round(time.monotonic() - started_at, 2),
                        "route_info": json.loads(json.dumps(route_info)),
                    }
                    if usage:
                        result_event["usage"] = usage
                    yield result_event
                break

        yield {"event": "metadata", "route_info": json.loads(json.dumps(route_info))}

    except asyncio.CancelledError:
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
        err_txt = stderr_tail.decode("utf-8", errors="replace").strip()
        detail = f" — {err_txt}" if err_txt else ""
        limit = timeout if setup_complete and timeout > 0 else ACP_SETUP_TIMEOUT_SECONDS
        yield {"event": "error", "error": f"antigravity-chat (ACP): {phase} timed out after {limit:g}s{detail}"}
    finally:
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
