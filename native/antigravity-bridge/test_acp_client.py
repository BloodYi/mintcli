"""Tests for the official `agy acp` stdio JSON-RPC client."""
from __future__ import annotations

import asyncio
import json
import sys
import tempfile
from pathlib import Path

from acp_client import _extract_content_text, _normalize_acp_usage, _permission_response, stream_agy_acp


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
