"""Regression tests for Claude -> agy routing, prompt rendering, and subprocess bridge."""
from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import agy_metadata
import app
import claude_agy
import detached_chat


def _pb_varint(value: int) -> bytes:
    out = bytearray()
    while value >= 0x80:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


def _pb_bytes(field: int, payload: bytes) -> bytes:
    return _pb_varint((field << 3) | 2) + _pb_varint(len(payload)) + payload


def _pb_int(field: int, value: int) -> bytes:
    return _pb_varint((field << 3) | 0) + _pb_varint(value)


def _write_fake_acp_db(
    home: Path,
    session_id: str,
    *,
    response_model: str = "gemini-4-neon",
    response_model_full: str | None = None,
    execution_id: str = "exec-1234",
) -> Path:
    db_dir = home / ".gemini" / "antigravity-cli" / "conversations"
    db_dir.mkdir(parents=True, exist_ok=True)
    db_path = db_dir / f"{session_id}.db"
    con = sqlite3.connect(db_path)
    try:
        con.execute("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)")
        con.execute("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
        step_meta = _pb_bytes(12, execution_id.encode("utf-8"))
        con.execute("INSERT INTO steps (idx, step_type, status, metadata) VALUES (0, 1, 3, ?)", (step_meta,))
        con.execute("INSERT INTO steps (idx, step_type, status, metadata) VALUES (1, 15, 3, ?)", (step_meta,))
        chat = _pb_bytes(19, response_model.encode("utf-8"))
        if response_model_full:
            chat += _pb_bytes(22, response_model_full.encode("utf-8"))
        gen = _pb_bytes(1, chat) + _pb_int(2, 1) + _pb_bytes(4, execution_id.encode("utf-8"))
        con.execute("INSERT INTO gen_metadata (idx, data) VALUES (0, ?)", (gen,))
        con.commit()
    finally:
        con.close()
    return db_path


class ClaudeAgyPromptAndRouteTests(unittest.IsolatedAsyncioTestCase):
    def test_claude_agy_prompt_omits_no_tool_default_system(self):
        req = app.ChatRequest(
            messages=[app.Message(role="user", content="检查当前目录的文件")],
            use_claude_agy=True,
        )
        claude_prompt = app._prompt_with_saved_history(req, [], claude_agy=True)
        self.assertEqual(claude_prompt, "检查当前目录的文件")
        self.assertNotIn("Do not use tools", claude_prompt)
        self.assertNotIn("Output only your reply", claude_prompt)

        native_prompt = app._prompt_with_saved_history(req, [], claude_agy=False)
        self.assertIn("Do not use tools", native_prompt)

    def test_claude_agy_system_append_keeps_download_instruction_and_custom_system(self):
        default_append = app._claude_agy_system_append(None)
        self.assertIn(app.DOWNLOAD_LINK_INSTRUCTION, default_append)
        self.assertNotIn("Do not use tools", default_append)

        custom_append = app._claude_agy_system_append("Always reply in Chinese.")
        self.assertIn("Always reply in Chinese.", custom_append)
        self.assertIn(app.DOWNLOAD_LINK_INSTRUCTION, custom_append)

    def test_history_truncates_oversized_latest_message_instead_of_dropping_all(self):
        huge = "头部标记-" + ("中文内容" * 10000) + "-尾部标记"
        self.assertGreater(len(huge.encode("utf-8")), 48 * 1024)
        history = [
            {"role": "user", "content": "早期消息", "status": "complete"},
            {"role": "assistant", "content": huge, "status": "complete"},
        ]
        recent = app._recent_saved_messages(history)
        self.assertEqual(len(recent), 1)
        self.assertLessEqual(len(recent[0].content.encode("utf-8")), 48 * 1024)
        self.assertIn("头部标记-", recent[0].content)
        self.assertIn("-尾部标记", recent[0].content)
        self.assertIn("内容过长已截断", recent[0].content)

    def test_history_preserves_attachments_and_attachment_only_rows(self):
        history = [
            {
                "role": "user",
                "content": "",
                "attachments": [
                    {"name": "screen.png", "path": "/tmp/screen.png", "mimeType": "image/png"},
                    {"filename": "notes.txt", "path": "/tmp/notes.txt", "is_image": False},
                ],
            },
            {"role": "assistant", "content": "已查看截图", "status": "complete"},
            {"role": "assistant", "content": "失败回复", "status": "error"},
            {"role": "assistant", "content": "中断回复", "status": "stopped"},
        ]
        recent = app._recent_saved_messages(history)
        self.assertEqual(len(recent), 2)
        self.assertIn("附带图片: screen.png", recent[0].content)
        self.assertIn("/tmp/screen.png", recent[0].content)
        self.assertIn("附带文件: notes.txt", recent[0].content)
        self.assertEqual(recent[1].content, "已查看截图")

    def test_resolve_route_ignores_failed_or_stopped_turns(self):
        saved = [
            {"role": "assistant", "status": "complete", "routeInfo": {"transport": "claude_agy"}},
            {"role": "assistant", "status": "error", "routeInfo": {"native_conversation_id": "native-bad"}},
            {"role": "assistant", "status": "stopped", "routeInfo": {"native_conversation_id": "native-stop"}},
        ]
        replay_native, native_id = app._resolve_conversation_route("native-orig", saved)
        self.assertTrue(replay_native)
        self.assertEqual(native_id, "native-orig")

        saved_native_then_failed_claude = [
            {"role": "assistant", "status": "complete", "routeInfo": {"native_conversation_id": "native-2"}},
            {"role": "assistant", "status": "error", "routeInfo": {"transport": "claude_agy"}},
        ]
        replay_native, native_id = app._resolve_conversation_route("mintcli-claude-abc", saved_native_then_failed_claude)
        self.assertFalse(replay_native)
        self.assertEqual(native_id, "native-2")

        replay_native, native_id = app._resolve_conversation_route("mintcli-claude-abc", [])
        self.assertTrue(replay_native)
        self.assertEqual(native_id, "mintcli-claude-abc")

    async def test_default_claude_agy_model_uses_discovered_models(self):
        with patch.object(app, "_models_cache", None), patch.object(
            app, "models", AsyncMock(return_value={"models": [{"id": "gemini-4-neon-high", "name": "Gemini 4"}]})
        ):
            self.assertEqual(await app._default_claude_agy_model(), "gemini-4-neon-high")

    def test_detached_chat_records_claude_sdk_cache_token_metrics(self):
        with tempfile.TemporaryDirectory(prefix="mintcli-detached-test-") as tmp:
            manager = detached_chat.TurnManager(Path(tmp), app.logger)
            turn = detached_chat.WebTurn(manager, "0" * 32, None, "conv-1", [], "test-model", "Test Model")
            turn.absorb({
                "event": "result",
                "response": "done",
                "usage": {
                    "input_tokens": 120,
                    "output_tokens": 45,
                    "cache_read_input_tokens": 15000,
                    "cache_creation_input_tokens": 800,
                },
                "duration_seconds": 2.5,
            })
            metrics = turn.assistant["metrics"]
            self.assertIn("15,965 tokens", metrics)
            self.assertIn("输入 120", metrics)
            self.assertIn("输出 45", metrics)
            self.assertIn("缓存 15,000", metrics)
            self.assertIn("缓存写入 800", metrics)
            self.assertIn("2.5s", metrics)


    def test_apply_claude_agy_trace_reads_acp_session_models_and_backfills_history(self):
        acp_sid = "11111111-2222-3333-4444-555555555555"
        with tempfile.TemporaryDirectory(prefix="mintcli-acp-db-test-") as tmp:
            home = Path(tmp)
            _write_fake_acp_db(
                home,
                acp_sid,
                response_model="gemini-4-neon",
                response_model_full="gemini-4-neon-001",
            )
            route = app._new_route_info("req-1", "gemini-4-neon-high")
            route["transport"] = "claude_agy"
            app._apply_claude_agy_trace(
                route,
                str(home),
                {
                    "session_ids": [acp_sid],
                    "response_ids": ["Resp-ABC"],
                    "trace_ids": ["0xdeadbeef"],
                    "upstream_urls": ["https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"],
                },
            )
            self.assertEqual(route["acp_session_ids"], [acp_sid])
            self.assertEqual(route["returned_models"], ["gemini-4-neon"])
            self.assertEqual(route["returned_model_fulls"], ["gemini-4-neon-001"])
            self.assertEqual(route["response_ids"], ["Resp-ABC"])
            self.assertEqual(route["trace_ids"], ["0xdeadbeef"])
            self.assertEqual(
                route["upstream_urls"],
                ["https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent"],
            )
            self.assertEqual(route["status"], "available")
            self.assertEqual(route["observed_step_indices"], [1])
            self.assertEqual(route["model_step_indices"], [1])
            self.assertEqual(route["uncovered_step_indices"], [])

            # Also verify read_message_history backfills persisted claude_agy messages that saved acp_session_ids.
            messages_dir = home / "messages"
            messages_dir.mkdir()
            cid = "mintcli-claude-backfilltest"
            saved_route = app._new_route_info("req-2", "gemini-4-neon-high")
            saved_route["transport"] = "claude_agy"
            saved_route["acp_session_ids"] = [acp_sid]
            (messages_dir / f"{cid}.json").write_text(
                json.dumps([
                    {"id": "u1", "role": "user", "content": "hi", "created_at": 1700000000.0},
                    {"id": "a1", "role": "assistant", "content": "ok", "created_at": 1700000001.0, "metrics": "10 tokens", "routeInfo": saved_route},
                ]),
                encoding="utf-8",
            )
            with patch.object(app, "MESSAGES_DIR", messages_dir), patch.object(app, "HOME", str(home)):
                history = app.read_message_history(cid)
            self.assertEqual(history[1]["routeInfo"]["returned_models"], ["gemini-4-neon"])
            self.assertEqual(history[1]["routeInfo"]["returned_model_fulls"], ["gemini-4-neon-001"])
            self.assertEqual(history[1]["routeInfo"]["status"], "available")

            # Invalid UUIDs are rejected cleanly.
            self.assertEqual(agy_metadata.read_acp_session_evidence(str(home), "../bad")["records"], [])

    async def test_claude_agy_chat_persists_returned_models_via_metadata_event(self):
        acp_sid = "22222222-3333-4444-5555-666666666666"
        with tempfile.TemporaryDirectory(prefix="mintcli-claude-chat-test-") as tmp:
            root = Path(tmp)
            home = root / "home"
            messages_dir = root / "messages"
            messages_dir.mkdir()
            _write_fake_acp_db(home, acp_sid, response_model="gemini-4-neon")

            async def fake_stream(**_kwargs):
                yield {
                    "event": "agy_trace",
                    "session_ids": [acp_sid],
                    "response_ids": ["Resp-1"],
                    "trace_ids": ["0xabc"],
                    "upstream_urls": ["https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"],
                }
                yield {"event": "delta", "delta": "Hello"}
                yield {"event": "result", "response": "Hello", "usage": {"input_tokens": 10, "output_tokens": 5}, "duration_seconds": 1.0}
                yield {
                    "event": "agy_trace",
                    "final": True,
                    "session_ids": [acp_sid],
                    "response_ids": ["Resp-1"],
                    "trace_ids": ["0xabc"],
                    "upstream_urls": ["https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"],
                }

            manager = detached_chat.TurnManager(messages_dir, app.logger)
            req = app.ChatRequest(
                messages=[app.Message(role="user", content="test")],
                model="gemini-4-neon-high",
                use_claude_agy=True,
                turn_id="a" * 32,
            )
            with patch.object(app, "web_turns", manager), \
                 patch.object(app, "MESSAGES_DIR", messages_dir), \
                 patch.object(app, "HOME", str(home)), \
                 patch.object(app, "AGY_PERSIST_CONVERSATIONS", False), \
                 patch.object(app, "_agy_environment", return_value={"HOME": str(home)}), \
                 patch.object(app, "stream_claude_agy", side_effect=fake_stream):
                response = await app.chat(req)
                chunks = []
                async for chunk in response.body_iterator:
                    chunks.append(chunk.decode("utf-8") if isinstance(chunk, bytes) else str(chunk))
                turn = manager.turns["a" * 32]
                await turn.task

            raw_sse = "".join(chunks)
            self.assertNotIn('"event": "agy_trace"', raw_sse)
            self.assertIn('"event": "metadata"', raw_sse)
            saved_files = list(messages_dir.glob("mintcli-claude-*.json"))
            self.assertEqual(len(saved_files), 1)
            saved_messages = json.loads(saved_files[0].read_text(encoding="utf-8"))
            assistant = [m for m in saved_messages if m.get("role") == "assistant"][-1]
            self.assertEqual(assistant["routeInfo"]["returned_models"], ["gemini-4-neon"])
            self.assertEqual(assistant["routeInfo"]["acp_session_ids"], [acp_sid])
            self.assertEqual(assistant["routeInfo"]["status"], "available")


class ClaudeAgySubprocessTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mintcli-claude-agy-test-")
        self.root = Path(self.temp.name)
        self.repo = self.root / "fake-repo"
        self.sdk_dir = self.repo / "node_modules" / "@anthropic-ai" / "claude-agent-sdk"
        self.sdk_dir.mkdir(parents=True)
        (self.repo / "package.json").write_text(json.dumps({"name": "fake-repo", "type": "module"}))
        (self.sdk_dir / "package.json").write_text(json.dumps({
            "name": "@anthropic-ai/claude-agent-sdk",
            "type": "module",
            "exports": "./index.mjs",
        }))
        self.plugin_dir = self.root / "fake-plugin"
        self.plugin_dir.mkdir(parents=True)
        self.scratch = self.root / "scratch"
        self.scratch.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def _write_mocks(self, sdk_code: str, plugin_code: str):
        (self.sdk_dir / "index.mjs").write_text(sdk_code, encoding="utf-8")
        (self.plugin_dir / "index.mjs").write_text(plugin_code, encoding="utf-8")

    async def _run_stream(self, *, prompt="hello", system_append=None):
        env = dict(os.environ)
        env["MINTCLI_MAGPIE_AGY"] = str(self.plugin_dir)
        env["MINTCLI_CLAUDE_PATH"] = "/bin/true"
        with patch.dict(os.environ, {
            "MINTCLI_MAGPIE_AGY": str(self.plugin_dir),
            "MINTCLI_CLAUDE_PATH": "/bin/true",
        }), patch.object(claude_agy, "_worker_environment", wraps=claude_agy._worker_environment) as orig:
            def wrapped(source, agy_bin, temporary):
                worker_env, claude_home = orig._mock_wraps(source, agy_bin, temporary)
                worker_env["MINTCLI_REPO"] = str(self.repo)
                return worker_env, claude_home
            orig.side_effect = wrapped
            events = []
            async for ev in claude_agy.stream_claude_agy(
                agy_bin="agy",
                env=env,
                cwd=str(self.root),
                scratch=self.scratch,
                prompt=prompt,
                model="test-model",
                turn_id="turn-123",
                sandbox=False,
                system_append=system_append,
            ):
                events.append(ev)
            return events

    async def test_multistep_text_separation_tool_summary_and_retry_recovery(self):
        plugin_code = """
let messagesCalls = 0;
export default {
  async server() {
    return {
      auth: {
        async loader() {
          return {
            async fetch(url) {
              if (url.includes('/v1/messages/count_tokens')) {
                return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad count_tokens' } }), {
                  status: 400, headers: { 'content-type': 'application/json' },
                });
              }
              messagesCalls += 1;
              if (messagesCalls === 1) {
                return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), {
                  status: 503, headers: { 'content-type': 'application/json' },
                });
              }
              return new Response(JSON.stringify({ id: 'msg_1', type: 'message', content: [] }), {
                status: 200, headers: { 'content-type': 'application/json' },
              });
            },
          };
        },
      },
    };
  },
};
"""
        sdk_code = """
export async function* query({ prompt, options }) {
  const base = options.env.ANTHROPIC_BASE_URL;
  const headers = { 'content-type': 'application/json', 'x-api-key': options.env.ANTHROPIC_API_KEY };
  const ct = await fetch(base + '/v1/messages/count_tokens', { method: 'POST', headers, body: '{}' });
  if (ct.status !== 400) throw new Error('expected count_tokens 400, got ' + ct.status);
  const first = await fetch(base + '/v1/messages', { method: 'POST', headers, body: '{}' });
  if (first.status !== 503) throw new Error('expected first /v1/messages 503, got ' + first.status);
  const retry = await fetch(base + '/v1/messages', { method: 'POST', headers, body: '{}' });
  if (retry.status !== 200) throw new Error('expected retried /v1/messages 200, got ' + retry.status);
  if (options.systemPrompt?.append !== 'custom-append') throw new Error('missing systemPrompt.append');

  yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'step1' } } };
  yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'First step.' } } };
  yield {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'First step.' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/opt/cloudcli-candidate/native/antigravity-bridge/app.py' } },
        { type: 'tool_use', name: 'Bash', input: { description: 'Run unit tests', command: 'pytest' } },
      ],
    },
  };
  yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'step2' } } };
  yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Second step.' } } };
  yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Second step.' }] } };
  yield { type: 'result', is_error: false, result: 'Second step.', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1200, cache_creation_input_tokens: 300 }, duration_ms: 1200 };
}
"""
        self._write_mocks(sdk_code, plugin_code)
        events = await self._run_stream(system_append="custom-append")
        deltas = "".join(ev["delta"] for ev in events if ev.get("event") == "delta")
        thinking = "".join(ev["thinking"] for ev in events if ev.get("event") == "thinking")
        tools = [ev["tool"] for ev in events if ev.get("event") == "tool"]
        results = [ev for ev in events if ev.get("event") == "result"]
        errors = [ev for ev in events if ev.get("event") == "error"]

        self.assertEqual(errors, [])
        self.assertEqual(deltas, "First step.\n\nSecond step.")
        self.assertEqual(thinking, "step1\n\nstep2")
        self.assertEqual(tools, [
            "Read: /opt/cloudcli-candidate/native/antigravity-bridge/app.py",
            "Bash: Run unit tests",
        ])
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["response"], "First step.\n\nSecond step.")
        self.assertEqual(results[0]["usage"]["cache_read_tokens"], 1200)
        self.assertEqual(results[0]["usage"]["cache_creation_tokens"], 300)
        self.assertEqual(results[0]["usage"]["total_tokens"], 1515)

    async def test_stderr_is_captured_and_logged_on_fatal_error(self):
        plugin_code = "export default { async server() { throw new Error('boom-from-plugin'); } };"
        sdk_code = "export async function* query() {}"
        self._write_mocks(sdk_code, plugin_code)
        with self.assertLogs(claude_agy.logger, level="WARNING") as captured:
            events = await self._run_stream()
        self.assertTrue(any(ev.get("event") == "error" for ev in events))
        self.assertTrue(any("boom-from-plugin" in line for line in captured.output))

    async def test_emits_agy_trace_even_when_workspace_removed_before_exit(self):
        acp_sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        plugin_code = f"""
import fs from 'node:fs';
import path from 'node:path';
export default {{
  async server() {{
    return {{
      auth: {{
        async loader() {{
          return {{
            async fetch(url) {{
              if (url.includes('/v1/messages')) {{
                const ws = path.join(process.env.TMPDIR, 'magpie-agy-bridge-TEST01');
                fs.mkdirSync(ws, {{ recursive: true }});
                fs.writeFileSync(path.join(ws, 'agy-acp.log'), [
                  'I1121 06:45:39.454640 23 server.go:1265] Created conversation {acp_sid} (backend=BACKEND_TYPE_UNSPECIFIED)',
                  'I1121 06:45:40.092870 300 http_helpers.go:771] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse Trace: 0x1234abcd ResponseID: Resp-999',
                ].join('\\n') + '\\n');
                let sent = false;
                const body = new ReadableStream({{
                  pull(controller) {{
                    if (!sent) {{
                      sent = true;
                      controller.enqueue(new TextEncoder().encode(JSON.stringify({{ id: 'msg_1', type: 'message', content: [] }})));
                      return;
                    }}
                    controller.close();
                    // Simulate magpie-agy deleting its workspace before process exit.
                    fs.rmSync(ws, {{ recursive: true, force: true }});
                  }},
                }});
                return new Response(body, {{
                  status: 200,
                  headers: {{ 'content-type': 'application/json' }},
                }});
              }}
              return new Response('{{}}', {{ status: 200, headers: {{ 'content-type': 'application/json' }} }});
            }},
          }};
        }},
      }},
    }};
  }},
}};
"""
        sdk_code = """
export async function* query({ options }) {
  const base = options.env.ANTHROPIC_BASE_URL;
  const headers = { 'content-type': 'application/json', 'x-api-key': options.env.ANTHROPIC_API_KEY };
  const res = await fetch(base + '/v1/messages', { method: 'POST', headers, body: '{}' });
  await res.text();
  yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done.' } } };
  yield { type: 'result', is_error: false, result: 'Done.', usage: { input_tokens: 5, output_tokens: 2 }, duration_ms: 100 };
}
"""
        self._write_mocks(sdk_code, plugin_code)
        events = await self._run_stream()
        traces = [ev for ev in events if ev.get("event") == "agy_trace"]
        self.assertTrue(traces)
        final_trace = traces[-1]
        self.assertTrue(final_trace.get("final"))
        self.assertEqual(final_trace["session_ids"], [acp_sid])
        self.assertEqual(final_trace["response_ids"], ["Resp-999"])
        self.assertEqual(final_trace["trace_ids"], ["0x1234abcd"])
        self.assertEqual(
            final_trace["upstream_urls"],
            ["https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"],
        )


if __name__ == "__main__":
    unittest.main()
