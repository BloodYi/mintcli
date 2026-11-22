"""Tests for the official `agy acp` stdio JSON-RPC client."""
from __future__ import annotations

import asyncio
import json
import sys
import tempfile
from pathlib import Path

from acp_client import (
    _extract_content_text,
    _normalize_acp_usage,
    _permission_response,
    probe_agy_acp_info,
    stream_agy_acp,
)


def test_helpers():
    assert _extract_content_text({"type": "text", "text": "hello"}) == "hello"
    assert _extract_content_text([{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]) == "ab"
    assert _normalize_acp_usage({"inputTokens": 10, "outputTokens": 5, "thoughtTokens": 2}) == {
        "input_tokens": 10,
        "output_tokens": 5,
        "thinking_tokens": 2,
        "total_tokens": 15,
    }
    perm = _permission_response(9, {"options": [{"kind": "reject", "optionId": "no"}, {"kind": "allow_once", "optionId": "yes"}]})
    assert perm == {"jsonrpc": "2.0", "id": 9, "result": {"outcome": {"outcome": "selected", "optionId": "yes"}}}


def test_stream_agy_acp_end_to_end():
    fake_server = """
import json, sys

for line in sys.stdin:
    msg = json.loads(line)
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": 1}}), flush=True)
    elif method == "session/new":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": "sid-acp-1"}}), flush=True)
    elif method == "session/set_model":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {}}), flush=True)
    elif method == "session/prompt":
        print(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "sid-acp-1", "update": {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "thinking..."}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "sid-acp-1", "update": {"sessionUpdate": "tool_call", "title": "read_file", "status": "running"}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "sid-acp-1", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Hello ACP"}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn", "usage": {"inputTokens": 12, "outputTokens": 3, "totalTokens": 15}}}), flush=True)
        break
"""

    async def run():
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            wrapper = tmp_path / "fake_agy.py"
            wrapper.write_text(f"#!{sys.executable}\n{fake_server}", encoding="utf-8")
            wrapper.chmod(0o755)
            saved = []

            async def save_cb(uid, sid):
                saved.append((uid, sid))

            events = []
            async for ev in stream_agy_acp(
                agy_bin=str(wrapper),
                prompt="hi",
                model="gemini-3.8-flash-low",
                target_cwd=tmp,
                run_env={"PATH": "/usr/bin:/bin"},
                scratch_dir=tmp_path,
                save_conversation_cb=save_cb,
            ):
                events.append(ev)

            assert saved == [("default", "sid-acp-1")]
            kinds = [e["event"] for e in events]
            assert kinds == ["init", "thinking", "tool", "delta", "result", "metadata"]
            assert events[0]["conversation_id"] == "sid-acp-1"
            assert events[0]["transport"] == "acp"
            assert events[1]["thinking"] == "thinking..."
            assert events[2]["tool"] == "read_file"
            assert events[3]["delta"] == "Hello ACP"
            assert events[4]["response"] == "Hello ACP"
            assert events[4]["usage"]["total_tokens"] == 15

    asyncio.run(run())


def test_stream_agy_acp_system_prompt_append_and_fallback():
    fake_server = """
import json, os, sys

supports_append = os.environ.get("FAKE_ACP_APPEND") == "1"
log_file = None
for idx, arg in enumerate(sys.argv):
    if arg == "--log-file" and idx + 1 < len(sys.argv):
        log_file = sys.argv[idx + 1]

received = {}
for line in sys.stdin:
    msg = json.loads(line)
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        caps = {"_meta": {"antigravity": {"systemPrompt": {"append": True}}}} if supports_append else {}
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": 1, "agentCapabilities": caps}}), flush=True)
    elif method == "session/new":
        received["session_meta"] = msg.get("params", {}).get("_meta")
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": "55555555-6666-7777-8888-999999999999"}}), flush=True)
    elif method == "session/set_model":
        received["model"] = msg.get("params", {}).get("modelId")
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {}}), flush=True)
    elif method == "session/prompt":
        received["prompt"] = msg.get("params", {}).get("prompt", [{}])[0].get("text", "")
        if log_file:
            with open(log_file, "w", encoding="utf-8") as fh:
                fh.write("URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse Trace: 0xfeed ResponseID: Resp-ACP-1\\n")
        print(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "55555555-6666-7777-8888-999999999999", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": json.dumps(received)}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}}), flush=True)
        break
"""

    async def run():
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            wrapper = tmp_path / "fake_agy.py"
            wrapper.write_text(f"#!{sys.executable}\n{fake_server}", encoding="utf-8")
            wrapper.chmod(0o755)

            # 1. Server advertises official systemPrompt.append capability
            traces = []

            def enrich(info, trace):
                traces.append(trace)
                info["response_ids"] = trace["response_ids"]

            events = [
                ev async for ev in stream_agy_acp(
                    agy_bin=str(wrapper),
                    prompt="fix bug",
                    model="gemini-pro-orchestrator-neon",
                    target_cwd=tmp,
                    run_env={"PATH": "/usr/bin:/bin", "FAKE_ACP_APPEND": "1"},
                    scratch_dir=tmp_path,
                    system_append="ENHANCED_GUIDANCE",
                    route_enricher=enrich,
                )
            ]
            result = next(ev for ev in events if ev["event"] == "result")
            seen = json.loads(result["response"])
            assert seen["model"] == "gemini-pro-orchestrator-neon"
            assert seen["session_meta"] == {"antigravity": {"systemPrompt": {"append": "ENHANCED_GUIDANCE"}}}
            assert seen["prompt"] == "fix bug"
            assert traces == [{
                "session_ids": ["55555555-6666-7777-8888-999999999999"],
                "response_ids": ["Resp-ACP-1"],
                "trace_ids": ["0xfeed"],
                "upstream_urls": ["https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"],
            }]
            assert result["route_info"]["response_ids"] == ["Resp-ACP-1"]
            assert result["route_info"]["cli_config_model"] == "gemini-pro-orchestrator-neon"

            # 2. Fallback when older agy does not advertise systemPrompt.append
            events_fallback = [
                ev async for ev in stream_agy_acp(
                    agy_bin=str(wrapper),
                    prompt="fix bug",
                    model="gemini-pro-orchestrator",
                    target_cwd=tmp,
                    run_env={"PATH": "/usr/bin:/bin", "FAKE_ACP_APPEND": "0"},
                    scratch_dir=tmp_path,
                    system_append="ENHANCED_GUIDANCE",
                )
            ]
            result_fb = next(ev for ev in events_fallback if ev["event"] == "result")
            seen_fb = json.loads(result_fb["response"])
            assert seen_fb["session_meta"] is None
            assert seen_fb["prompt"] == "ENHANCED_GUIDANCE\n\nfix bug"

    asyncio.run(run())


def test_probe_agy_acp_info():
    fake_agy = r"""
import json, sys
for line in sys.stdin:
    req = json.loads(line)
    if req.get("method") == "initialize":
        sys.stdout.write(json.dumps({
            "jsonrpc": "2.0",
            "id": req["id"],
            "result": {
                "protocolVersion": 1,
                "agentInfo": {"name": "Antigravity ACP Server", "version": "1.5.14"},
                "agentCapabilities": {"_meta": {"antigravity": {"systemPrompt": {"append": True}}}},
            },
        }) + "\n")
        sys.stdout.flush()
        break
"""

    async def run():
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            fake_script = tmp_path / "fake_probe_agy.py"
            fake_script.write_text(fake_agy, encoding="utf-8")
            wrapper = tmp_path / "agy"
            wrapper.write_text(f"#!/bin/sh\nexec {sys.executable} {fake_script} \"$@\"\n", encoding="utf-8")
            wrapper.chmod(0o755)

            info = await probe_agy_acp_info(str(wrapper), cwd=tmp, timeout=5.0)
            assert info == {
                "available": True,
                "protocolVersion": 1,
                "serverName": "Antigravity ACP Server",
                "serverVersion": "1.5.14",
                "supportsSystemPromptAppend": True,
            }

            missing = await probe_agy_acp_info(str(tmp_path / "nonexistent-agy"), cwd=tmp, timeout=2.0)
            assert missing["available"] is False
            assert missing["serverVersion"] is None
            assert missing.get("error")

    asyncio.run(run())


