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

        # Truncating inside a fenced code block repairs unclosed ``` fences on both sides
        fenced_huge = "前文说明\n```typescript\n" + ("const x = 1;\n" * 5000) + "```\n后文结论"
        truncated_fenced = app._truncate_utf8_head_tail(fenced_huge, 4096)
        self.assertLessEqual(len(truncated_fenced.encode("utf-8")), 4096)
        self.assertIsNone(app._scan_unclosed_fence(truncated_fenced))
        self.assertTrue(truncated_fenced.endswith("后文结论"))

    def test_claude_agy_history_includes_compact_prior_tool_summary_and_segment_reset(self):
        history = [
            {"role": "user", "content": "修改配置", "status": "complete"},
            {
                "role": "assistant",
                "content": "已完成修改",
                "status": "complete",
                "steps": [
                    {"type": "tool_use", "toolName": "Read", "toolLabel": "Read: app.py", "status": "completed"},
                    {
                        "type": "tool_use",
                        "toolName": "mcp__agy-fast_fast__apply_edits",
                        "toolInput": {"edits": [{"path": "/opt/a.ts"}, {"path": "/opt/b.ts"}]},
                        "status": "completed",
                    },
                ],
            },
        ]
        req = app.ChatRequest(messages=[app.Message(role="user", content="继续测试")], use_claude_agy=True)
        rendered = app._prompt_with_saved_history(req, history, claude_agy=True)
        self.assertIn("[Prior tool actions: Read: app.py; apply_edits(a.ts, b.ts)]", rendered)

        # WebTurn segment_reset clears leaked partial text after the last tool while keeping earlier text
        with tempfile.TemporaryDirectory() as td:
            mgr = detached_chat.TurnManager(Path(td), app.logger)
            async def dummy():
                if False:
                    yield {}
            turn = detached_chat.WebTurn(mgr, "t" * 32, dummy, "cid-1", [], "m", "m")
            turn.absorb({"event": "delta", "delta": "Step 1 kept."})
            turn.absorb({"event": "tool", "tool": "Read: x.py", "tool_id": "tu1", "status": "completed"})
            turn.absorb({"event": "delta", "delta": "Leaked refusal fragment"})
            self.assertIn("Leaked refusal fragment", turn.assistant["content"])
            turn.absorb({"event": "segment_reset"})
            self.assertNotIn("Leaked refusal fragment", turn.assistant["content"])
            self.assertEqual(turn.assistant["content"], "Step 1 kept.")

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

    async def _run_stream(self, *, prompt="hello", model="test-model", system_append=None):
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
                model=model,
                turn_id="turn-123",
                sandbox=False,
                system_append=system_append,
            ):
                events.append(ev)
            return events

    async def test_neon_declares_its_context_window_to_claude(self):
        self._write_mocks(
            """
export async function* query({ options }) {
  yield { type: 'result', is_error: false, result: JSON.stringify({
    model: options.model,
    contextWindow: options.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? null,
  }) };
}
""",
            "export default { async server() { return { auth: { async loader() { return {}; } } }; } };",
        )
        for model, window in (
            ("gemini-4-neon", "512000"),
            ("gemini-4-neon-low", "512000"),
            ("gemini-4-neon-medium", "512000"),
            ("gemini-4-neon-high", "512000"),
            ("gemini-4-neon-xhigh", "512000"),
            ("gemini-4-carbon-high", "512000"),
            ("gemini-3.8-flash-high", "512000"),
            ("claude-opus-5-5", "200000"),
            ("gemini-pro-orchestrator-neon", None),
            ("gemini-4-orchestrator", None),
            ("test-model", None),
        ):
            with self.subTest(model=model):
                events = await self._run_stream(model=model)
                result = next(event for event in events if event["event"] == "result")
                self.assertEqual(json.loads(result["response"]), {"model": model, "contextWindow": window})

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

    async def test_large_file_tool_use_result_preserves_structured_patch(self):
        plugin_code = "export default { async server() { return { auth: { async loader() { return {}; } } }; } };"
        sdk_code = """
export async function* query() {
  const hugeOriginal = 'x'.repeat(50000);
  yield {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_big', name: 'Edit', input: { file_path: '/tmp/big.ts' } }] },
  };
  yield {
    type: 'user',
    tool_use_result: {
      type: 'update',
      filePath: '/tmp/big.ts',
      originalFile: hugeOriginal,
      structuredPatch: [{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ['-old', '+new'] }],
    },
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_big', content: 'Updated /tmp/big.ts', is_error: false }] },
  };
  yield { type: 'result', is_error: false, result: 'Done' };
}
"""
        self._write_mocks(sdk_code, plugin_code)
        events = await self._run_stream()
        tr = next(ev for ev in events if ev.get("event") == "tool_result")
        self.assertIn("tool_use_result", tr)
        self.assertEqual(tr["tool_use_result"]["filePath"], "/tmp/big.ts")
        self.assertEqual(len(tr["tool_use_result"]["structuredPatch"]), 1)
        self.assertNotIn("originalFile", tr["tool_use_result"])

    async def test_stderr_is_captured_and_logged_on_fatal_error(self):
        plugin_code = "export default { async server() { throw new Error('boom-from-plugin'); } };"
        sdk_code = "export async function* query() {}"
        self._write_mocks(sdk_code, plugin_code)
        with self.assertLogs(claude_agy.logger, level="WARNING") as captured:
            events = await self._run_stream()
        self.assertTrue(any(ev.get("event") == "error" for ev in events))
        self.assertTrue(any("boom-from-plugin" in line for line in captured.output))

    async def test_trace_reads_each_log_version_once_and_keeps_prior_ids(self):
        self._write_mocks("""
import fs from 'node:fs';
import path from 'node:path';
export async function* query({ options }) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'magpie-agy-bridge-'));
  const log = path.join(dir, 'agy-acp.log');
  const readFile = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function(file, ...args) {
    if (file === log) reads++;
    return readFile.call(this, file, ...args);
  };
  const record = id => '[streamGenerateContent] ResponseID: ' + id + '\\n';
  const send = async () => {
    const res = await fetch(options.env.ANTHROPIC_BASE_URL + '/v1/messages', {
      method: 'POST', headers: { 'x-api-key': options.env.ANTHROPIC_API_KEY }, body: '{}',
    });
    await res.text();
  };
  try {
    fs.writeFileSync(log, record('one'));
    await send();
    await send();
    fs.appendFileSync(log, record('two'));
    await send();
    fs.writeFileSync(log + '.new', record('six') + record('ten'));
    fs.renameSync(log + '.new', log);
    await send();
    yield { type: 'result', is_error: false, result: String(reads) };
  } finally {
    fs.readFileSync = readFile;
  }
}
""", """
export default { async server() {
  return { auth: { async loader() { return { fetch: async () => Response.json({}) }; } } };
} };
""")
        events = await self._run_stream()
        self.assertEqual(next(e["response"] for e in events if e["event"] == "result"), "3")
        traces = [e for e in events if e["event"] == "agy_trace"]
        self.assertTrue(traces[-1]["final"])
        self.assertEqual(traces[-1]["response_ids"], ["one", "two", "six", "ten"])

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

    async def test_multiple_claude_agy_conversations_run_concurrently(self):
        barrier_dir = self.root / "barrier"
        barrier_dir.mkdir()
        sdk_code = f"""
import fs from 'node:fs';
import path from 'node:path';
const barrierDir = {json.dumps(str(barrier_dir))};
export async function* query({{ prompt, options }}) {{
  let text = '';
  for await (const msg of prompt) {{
    text = String(msg?.message?.content || '');
    break;
  }}
  const marker = path.join(barrierDir, text + '.started');
  fs.writeFileSync(marker, '1');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {{
    const count = fs.readdirSync(barrierDir).filter(f => f.endsWith('.started')).length;
    if (count >= 3) break;
    await new Promise(r => setTimeout(r, 25));
  }}
  const seenCount = fs.readdirSync(barrierDir).filter(f => f.endsWith('.started')).length;
  yield {{ type: 'stream_event', event: {{ type: 'content_block_delta', delta: {{ type: 'text_delta', text: text + ':parallel=' + seenCount }} }} }};
  yield {{ type: 'result', is_error: false, result: text + ':parallel=' + seenCount, usage: {{ input_tokens: 5, output_tokens: 2 }}, duration_ms: 50 }};
}}
"""
        plugin_code = "export default { async server() { return { auth: { async loader() { return {}; } } }; } };"
        self._write_mocks(sdk_code, plugin_code)
        self.assertGreaterEqual(claude_agy._MAX_CONCURRENCY, 2)

        async def run_one(name: str):
            events = await self._run_stream(prompt=name)
            return next(ev["response"] for ev in events if ev.get("event") == "result")

        results = await asyncio.gather(run_one("conv-1"), run_one("conv-2"), run_one("conv-3"))
        self.assertEqual(results, ["conv-1:parallel=3", "conv-2:parallel=3", "conv-3:parallel=3"])

    async def test_live_mid_turn_injection_delivers_immediately_and_persists_new_thinking(self):
        sdk_code = """
export async function* query({ prompt, options }) {
  if (!options.extraArgs || !('replay-user-messages' in options.extraArgs)) {
    throw new Error('missing replay-user-messages');
  }
  const iter = prompt[Symbol.asyncIterator]();
  const first = await iter.next();
  if (first.done) throw new Error('missing initial prompt');

  yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'initial thought' } } };
  yield {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: '/tmp/a.txt' } },
      ],
    },
  };

  // Wait for the live injected user message while the tool is in flight.
  const injected = await iter.next();
  if (injected.done) throw new Error('expected injected follow-up');
  const injectedMsg = injected.value;

  // Tool finishes, then CLI replays the injected message and emits fresh thinking.
  yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'file-body', is_error: false }] } };
  yield { type: 'user', isReplay: true, uuid: injectedMsg.uuid, message: injectedMsg.message };
  yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'new thought for: ' + injectedMsg.message.content } } };
  yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Handled ' + injectedMsg.message.content } } };
  yield { type: 'result', is_error: false, result: 'Handled ' + injectedMsg.message.content, usage: { input_tokens: 20, output_tokens: 10 }, duration_ms: 200 };
}
"""
        plugin_code = "export default { async server() { return { auth: { async loader() { return {}; } } }; } };"
        self._write_mocks(sdk_code, plugin_code)

        messages_dir = self.root / "messages"
        messages_dir.mkdir()
        manager = detached_chat.TurnManager(messages_dir, app.logger)
        turn_id = "d" * 32
        req = app.ChatRequest(
            messages=[app.Message(role="user", content="first task")],
            model="gemini-4-neon-xhigh",
            use_claude_agy=True,
            cwd=str(self.root),
            turn_id=turn_id,
        )

        orig_worker_env = claude_agy._worker_environment
        def wrapped_worker_env(source, agy_bin, temporary):
            worker_env, claude_home = orig_worker_env(source, agy_bin, temporary)
            worker_env["MINTCLI_REPO"] = str(self.repo)
            return worker_env, claude_home

        with patch.dict(os.environ, {
            "MINTCLI_MAGPIE_AGY": str(self.plugin_dir),
            "MINTCLI_CLAUDE_PATH": "/bin/true",
        }), patch.object(claude_agy, "_worker_environment", side_effect=wrapped_worker_env), \
             patch.object(app, "MESSAGES_DIR", messages_dir), \
             patch.object(app, "SCRATCH", self.scratch), \
             patch.object(app, "web_turns", manager), \
             patch.object(app, "AGY_PERSIST_CONVERSATIONS", False), \
             patch.object(app, "_within_allowed", return_value=str(self.root)), \
             patch.object(app, "_agy_environment", return_value=dict(os.environ)):
            resp = await app.chat(req)
            turn = manager.turns[turn_id]
            seen_events = []
            injected_ok = None

            async def read_sse():
                nonlocal injected_ok
                async for chunk in resp.body_iterator:
                    text = chunk.decode("utf-8") if isinstance(chunk, bytes) else str(chunk)
                    for line in text.splitlines():
                        if not line.startswith("data: "):
                            continue
                        ev = json.loads(line[6:])
                        seen_events.append(ev)
                        if ev.get("event") == "tool" and injected_ok is None:
                            injected_ok = await app.inject_web_turn_message(
                                turn_id,
                                app.InjectTurnMessageRequest(content="also check tests", message_id="user-msg-2"),
                            )

            await read_sse()
            await turn.task

        self.assertIsNotNone(injected_ok)
        self.assertTrue(injected_ok["ok"])
        self.assertEqual(injected_ok["message_id"], "user-msg-2")
        applied_events = [ev for ev in seen_events if ev.get("event") == "user_message_applied"]
        self.assertEqual(len(applied_events), 1)
        self.assertEqual(applied_events[0]["user_message_id"], "user-msg-2")

        # Verify persisted history keeps [user1, assistant1(thinking1, tool1[completed]), user2, assistant2(thinking2, text)]
        saved_files = list(messages_dir.glob("mintcli-claude-*.json"))
        self.assertEqual(len(saved_files), 1)
        history = json.loads(saved_files[0].read_text(encoding="utf-8"))
        self.assertEqual([row["role"] for row in history], ["user", "assistant", "user", "assistant"])
        self.assertEqual(history[0]["content"], "first task")
        self.assertEqual(history[1]["steps"][0]["type"], "thinking")
        self.assertEqual(history[1]["steps"][0]["content"], "initial thought")
        self.assertEqual(history[1]["steps"][1]["type"], "tool_use")
        self.assertEqual(history[1]["steps"][1]["status"], "completed")
        self.assertEqual(history[1]["steps"][1]["toolResult"]["content"], "file-body")
        self.assertEqual(history[2]["id"], "user-msg-2")
        self.assertEqual(history[2]["content"], "also check tests")
        self.assertEqual(history[3]["thinking"], "new thought for: also check tests")
        self.assertEqual(history[3]["content"], "Handled also check tests")
        self.assertEqual(history[3]["status"], "complete")

    async def test_mid_text_injection_defers_result_until_injected_followup_finishes(self):
        sdk_code = """
export async function* query({ prompt }) {
  const iter = prompt[Symbol.asyncIterator]();
  const first = await iter.next();
  if (first.done) throw new Error('missing initial prompt');

  yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'First reply.' } } };
  const second = await iter.next();
  if (second.done) throw new Error('expected injected follow-up');
  // Sub-turn 1 result arrives BEFORE CLI replays the injected message.
  yield { type: 'result', is_error: false, result: 'First reply.', usage: { input_tokens: 10, output_tokens: 5 }, duration_ms: 100 };
  yield { type: 'user', isReplay: true, uuid: second.value.uuid, message: second.value.message };
  yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'thinking on follow-up' } } };
  yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Follow-up done.' } } };
  yield { type: 'result', is_error: false, result: 'Follow-up done.', usage: { input_tokens: 12, output_tokens: 8 }, duration_ms: 150 };
}
"""
        plugin_code = "export default { async server() { return { auth: { async loader() { return {}; } } }; } };"
        self._write_mocks(sdk_code, plugin_code)

        env = dict(os.environ)
        orig_worker_env = claude_agy._worker_environment
        def wrapped_worker_env(source, agy_bin, temporary):
            worker_env, claude_home = orig_worker_env(source, agy_bin, temporary)
            worker_env["MINTCLI_REPO"] = str(self.repo)
            return worker_env, claude_home

        injector_holder = [None]
        events = []
        with patch.dict(os.environ, {
            "MINTCLI_MAGPIE_AGY": str(self.plugin_dir),
            "MINTCLI_CLAUDE_PATH": "/bin/true",
        }), patch.object(claude_agy, "_worker_environment", side_effect=wrapped_worker_env):
            async for ev in claude_agy.stream_claude_agy(
                agy_bin="agy",
                env=env,
                cwd=str(self.root),
                scratch=self.scratch,
                prompt="start",
                model="test-model",
                turn_id="turn-defer",
                sandbox=False,
                register_injector=lambda fn: injector_holder.__setitem__(0, fn),
            ):
                events.append(ev)
                if ev.get("event") == "delta" and ev.get("delta") == "First reply.":
                    ok = await injector_holder[0]("new direction", "u-mid-text")
                    self.assertTrue(ok)

        results = [ev for ev in events if ev.get("event") == "result"]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["response"], "Follow-up done.")
        self.assertEqual(results[0]["usage"]["input_tokens"], 22)
        self.assertEqual(results[0]["usage"]["output_tokens"], 13)
        self.assertTrue(any(ev.get("event") == "user_message_applied" and ev.get("uuid") == "u-mid-text" for ev in events))
        self.assertTrue(any(ev.get("event") == "thinking" and ev.get("thinking") == "thinking on follow-up" for ev in events))


class ClaudeAgyOrchestratorRouteTests(unittest.IsolatedAsyncioTestCase):
    def test_orchestrator_detection_and_prompt_enhancement(self):
        for model_id, label in (
            ("gemini-pro-orchestrator-neon", "Orchestrator (Neon)"),
            ("gemini-pro-orchestrator", "Orchestrator (Carbon)"),
            ("gemini-pro-orchestrator-argon", "Orchestrator (Argon)"),
            ("custom-id", "Orchestrator (Neon)"),
        ):
            with self.subTest(model_id=model_id, label=label):
                self.assertTrue(app._is_orchestrator_model(model_id, label))

        for model_id, label in (
            ("gemini-4-neon-high", "Gemini 4 Neon (High)"),
            ("gemini-4-carbon-high", "Gemini 4 Carbon (High)"),
            ("gemini-4-argon-high", "Gemini 4 Argon (High)"),
            ("gemini-4-hydrogen-xhigh", "Gemini 4 Hydrogen (XHigh)"),
            ("claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"),
        ):
            with self.subTest(model_id=model_id, label=label):
                self.assertFalse(app._is_orchestrator_model(model_id, label))

        enhanced = app._claude_agy_orchestrator_system_append("Reply in Chinese.")
        self.assertIn(app.CLAUDE_CODE_ORCHESTRATOR_PROMPT, enhanced)
        self.assertIn("Reply in Chinese.", enhanced)
        self.assertIn(app.DOWNLOAD_LINK_INSTRUCTION, enhanced)
        self.assertNotIn("Do not use tools", enhanced)
        self.assertNotIn("You are Claude Code", enhanced)

    def test_pick_default_claude_agy_model_prefers_non_orchestrator(self):
        self.assertEqual(
            app._pick_default_claude_agy_model([
                {"id": "gemini-pro-orchestrator-neon", "name": "Orchestrator (Neon)"},
                {"id": "gemini-4-neon-high", "name": "Gemini 4 Neon (High)"},
            ]),
            "gemini-4-neon-high",
        )
        self.assertEqual(
            app._pick_default_claude_agy_model([
                {"id": "gemini-pro-orchestrator-neon", "name": "Orchestrator (Neon)"},
            ]),
            "gemini-pro-orchestrator-neon",
        )

    async def test_claude_agy_routes_orchestrator_models_to_official_acp_with_prompt_enhancement(self):
        acp_sid = "33333333-4444-5555-6666-777777777777"
        for model_id, label in (
            ("gemini-pro-orchestrator-neon", "Orchestrator (Neon)"),
            ("gemini-pro-orchestrator", "Orchestrator (Carbon)"),
            ("gemini-pro-orchestrator-argon", "Orchestrator (Argon)"),
        ):
            with self.subTest(model_id=model_id):
                with tempfile.TemporaryDirectory(prefix="mintcli-orch-acp-test-") as tmp:
                    root = Path(tmp)
                    home = root / "home"
                    messages_dir = root / "messages"
                    messages_dir.mkdir()
                    _write_fake_acp_db(home, acp_sid, response_model="gemini-4-hydrogen")
                    captured_kwargs = {}

                    async def fake_stream_acp(**kwargs):
                        captured_kwargs.update(kwargs)
                        info = kwargs["route_info_factory"]("req-orch", kwargs["model"])
                        kwargs["route_enricher"](
                            info,
                            {
                                "session_ids": [acp_sid],
                                "response_ids": ["Resp-Orch-1"],
                                "trace_ids": ["0xorch"],
                                "upstream_urls": ["https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"],
                            },
                        )
                        yield {"event": "init", "conversation_id": acp_sid, "model": kwargs["model"], "transport": "acp", "route_info": info}
                        yield {"event": "delta", "delta": "Orchestrated reply."}
                        yield {"event": "result", "response": "Orchestrated reply.", "route_info": info}
                        yield {"event": "metadata", "route_info": info}

                    async def fail_claude_agy(**_kwargs):
                        raise AssertionError("Orchestrator models must not route through magpie-agy/stream_claude_agy")
                        yield  # pragma: no cover

                    manager = detached_chat.TurnManager(messages_dir, app.logger)
                    turn_id = "b" * 32
                    req = app.ChatRequest(
                        messages=[app.Message(role="user", content="检查项目结构")],
                        model=model_id,
                        model_label=label,
                        use_claude_agy=True,
                        cwd=str(root),
                        turn_id=turn_id,
                    )
                    with patch.object(app, "MESSAGES_DIR", messages_dir), \
                         patch.object(app, "HOME", str(home)), \
                         patch.object(app, "SCRATCH", root), \
                         patch.object(app, "web_turns", manager), \
                         patch.object(app, "_within_allowed", return_value=str(root)), \
                         patch.object(app, "_agy_environment", return_value={"HOME": str(home)}), \
                         patch.object(app, "save_conversation_async", new=AsyncMock()), \
                         patch.object(app, "stream_agy_acp", side_effect=fake_stream_acp), \
                         patch.object(app, "stream_claude_agy", side_effect=fail_claude_agy):
                        resp = await app.chat(req)
                        async for _ in resp.body_iterator:
                            pass
                        await manager.turns[turn_id].task

                    self.assertEqual(captured_kwargs["model"], model_id)
                    self.assertEqual(captured_kwargs["prompt"], "检查项目结构")
                    self.assertIn(app.CLAUDE_CODE_ORCHESTRATOR_PROMPT, captured_kwargs["system_append"])
                    self.assertIn(app.DOWNLOAD_LINK_INSTRUCTION, captured_kwargs["system_append"])
                    self.assertNotIn("Do not use tools", captured_kwargs["system_append"])
                    with patch.object(app, "MESSAGES_DIR", messages_dir), patch.object(app, "HOME", str(home)):
                        history = app.read_message_history(acp_sid)
                    self.assertEqual(history[-1]["routeInfo"]["transport"], "acp")
                    self.assertEqual(history[-1]["routeInfo"]["prompt_mode"], "claude_code_enhanced")
                    self.assertEqual(history[-1]["routeInfo"]["returned_models"], ["gemini-4-hydrogen"])
                    self.assertEqual(history[-1]["routeInfo"]["acp_session_ids"], [acp_sid])

    async def test_claude_agy_orchestrator_replays_prior_claude_agy_session_and_keeps_stable_cid(self):
        acp_sid = "44444444-5555-6666-7777-888888888888"
        stable_cid = "mintcli-claude-existing123"
        with tempfile.TemporaryDirectory(prefix="mintcli-orch-replay-test-") as tmp:
            root = Path(tmp)
            home = root / "home"
            messages_dir = root / "messages"
            messages_dir.mkdir()
            (messages_dir / f"{stable_cid}.json").write_text(
                json.dumps([
                    {"id": "u1", "role": "user", "content": "第一条问题", "created_at": 1700000000.0},
                    {
                        "id": "a1",
                        "role": "assistant",
                        "content": "第一条回答",
                        "status": "complete",
                        "created_at": 1700000001.0,
                        "routeInfo": {"transport": "claude_agy"},
                    },
                ]),
                encoding="utf-8",
            )
            captured_kwargs = {}

            async def fake_stream_acp(**kwargs):
                captured_kwargs.update(kwargs)
                info = kwargs["route_info_factory"]("req-replay", kwargs["model"])
                yield {"event": "init", "conversation_id": acp_sid, "model": kwargs["model"], "transport": "acp", "route_info": info}
                yield {"event": "delta", "delta": "继续处理完成"}
                yield {"event": "result", "response": "继续处理完成", "route_info": info}
                yield {"event": "metadata", "route_info": info}

            manager = detached_chat.TurnManager(messages_dir, app.logger)
            turn_id = "c" * 32
            req = app.ChatRequest(
                messages=[app.Message(role="user", content="继续优化")],
                conversation_id=stable_cid,
                model="gemini-pro-orchestrator-neon",
                model_label="Orchestrator (Neon)",
                use_claude_agy=True,
                cwd=str(root),
                turn_id=turn_id,
            )
            with patch.object(app, "MESSAGES_DIR", messages_dir), \
                 patch.object(app, "HOME", str(home)), \
                 patch.object(app, "SCRATCH", root), \
                 patch.object(app, "web_turns", manager), \
                 patch.object(app, "_within_allowed", return_value=str(root)), \
                 patch.object(app, "_agy_environment", return_value={"HOME": str(home)}), \
                 patch.object(app, "save_conversation_async", new=AsyncMock()), \
                 patch.object(app, "set_conversation_needs_replay_async", new=AsyncMock()), \
                 patch.object(app, "stream_agy_acp", side_effect=fake_stream_acp):
                resp = await app.chat(req)
                async for _ in resp.body_iterator:
                    pass
                await manager.turns[turn_id].task

            self.assertIsNone(captured_kwargs["conversation_id"])
            self.assertIn("第一条问题", captured_kwargs["prompt"])
            self.assertIn("继续优化", captured_kwargs["prompt"])
            self.assertNotIn("Do not use tools", captured_kwargs["prompt"])
            with patch.object(app, "MESSAGES_DIR", messages_dir), patch.object(app, "HOME", str(home)):
                history = app.read_message_history(stable_cid)
            self.assertEqual(history[-1]["routeInfo"]["native_conversation_id"], acp_sid)

    async def test_native_non_claude_agy_channel_uses_official_acp(self):
        captured_kwargs = {}

        async def fake_stream_acp(**kwargs):
            captured_kwargs.update(kwargs)
            info = kwargs["route_info_factory"]("req-native-acp", kwargs["model"])
            yield {"event": "init", "conversation_id": "acp-native-1", "model": kwargs["model"], "transport": "acp", "route_info": info}
            yield {"event": "delta", "delta": "native acp reply"}
            yield {"event": "result", "response": "native acp reply", "route_info": info}
            yield {"event": "metadata", "route_info": info}

        with tempfile.TemporaryDirectory(prefix="mintcli-native-acp-test-") as tmp:
            root = Path(tmp)
            with patch.object(app, "SCRATCH", root), \
                 patch.object(app, "_within_allowed", return_value=str(root)), \
                 patch.object(app, "_agy_environment", return_value={"HOME": str(root)}), \
                 patch.object(app, "stream_agy_acp", side_effect=fake_stream_acp), \
                 patch.object(app.asyncio, "create_subprocess_exec", side_effect=AssertionError("native channel must not spawn agy -p")):
                events = [ev async for ev in app._stream_agy("hello native", "gemini-4-neon-medium", cwd=str(root))]

        self.assertEqual(captured_kwargs["model"], "gemini-4-neon-medium")
        self.assertEqual(captured_kwargs["prompt"], "hello native")
        self.assertTrue(any(ev.get("event") == "delta" and ev.get("delta") == "native acp reply" for ev in events))

    async def test_acp_info_endpoint_caches_and_refreshes(self):
        calls = 0

        async def fake_probe(*_args, **_kwargs):
            nonlocal calls
            calls += 1
            return {
                "available": True,
                "protocolVersion": 1,
                "serverName": "Antigravity ACP Server",
                "serverVersion": f"1.5.{13 + calls}",
                "supportsSystemPromptAppend": True,
            }

        with patch.object(app, "_acp_info_cache", None), \
             patch.object(app, "probe_agy_acp_info", side_effect=fake_probe):
            first = await app.acp_info(refresh=False)
            second = await app.acp_info(refresh=False)
            refreshed = await app.acp_info(refresh=True)

        self.assertTrue(first["ok"])
        self.assertEqual(first["acp"]["serverVersion"], "1.5.14")
        self.assertEqual(second["acp"]["serverVersion"], "1.5.14")
        self.assertEqual(refreshed["acp"]["serverVersion"], "1.5.15")
        self.assertEqual(calls, 2)

    async def test_output_style_syncs_to_claude_agy_and_orchestrator_while_stripping_auth_overrides(self):
        with tempfile.TemporaryDirectory(prefix="mintcli-style-sync-test-") as tmp:
            root = Path(tmp)
            cloudcli_root = root / "cloudcli"
            antigravity_home = cloudcli_root / "antigravity-home"
            account_home = antigravity_home / "scratch" / ".agy-account-homes" / "acc-1"
            global_claude = cloudcli_root / ".claude"
            project_dir = root / "project"
            project_claude = project_dir / ".claude"
            profile_dir = root / "isolated-profile"

            (global_claude / "output-styles").mkdir(parents=True)
            (project_claude / "output-styles").mkdir(parents=True)
            account_home.mkdir(parents=True)

            (global_claude / "output-styles" / "redteam-eni.md").write_text(
                "---\nname: custom-persona\ndescription: Global style\nkeep-coding-instructions: true\n---\n\nGLOBAL_PERSONA_BODY",
                encoding="utf-8",
            )
            (global_claude / "settings.local.json").write_text(
                json.dumps({
                    "outputStyle": "custom-persona",
                    "env": {"ANTHROPIC_BASE_URL": "https://evil.example", "ANTHROPIC_API_KEY": "sk-hijack"},
                    "apiKeyHelper": "/bin/evil",
                    "model": "claude-3-opus",
                }),
                encoding="utf-8",
            )

            env_for_account = {"HOME": str(account_home)}
            synced = claude_agy.sync_claude_style_profile(profile_dir, env_for_account, project_dir)
            self.assertEqual(synced, {"outputStyle": "custom-persona"})
            saved_settings = json.loads((profile_dir / "settings.json").read_text(encoding="utf-8"))
            self.assertEqual(saved_settings, {"outputStyle": "custom-persona"})
            self.assertNotIn("env", saved_settings)
            self.assertNotIn("apiKeyHelper", saved_settings)
            self.assertIn(
                "GLOBAL_PERSONA_BODY",
                (profile_dir / "output-styles" / "redteam-eni.md").read_text(encoding="utf-8"),
            )

            resolved = claude_agy.resolve_active_claude_output_style(env_for_account, project_dir)
            self.assertIsNotNone(resolved)
            self.assertEqual(resolved["name"], "custom-persona")
            self.assertTrue(resolved["keep_coding_instructions"])
            self.assertEqual(resolved["body"], "GLOBAL_PERSONA_BODY")

            orch_append = app._claude_agy_orchestrator_system_append("Extra rule.", output_style=resolved)
            self.assertIn(app.CLAUDE_CODE_ORCHESTRATOR_PROMPT, orch_append)
            self.assertIn("GLOBAL_PERSONA_BODY", orch_append)
            self.assertIn("Extra rule.", orch_append)

            # Project-local override with keep-coding-instructions: false replaces global style
            (project_claude / "output-styles" / "local-style.md").write_text(
                "---\nname: local-persona\nkeep-coding-instructions: false\n---\n\nPROJECT_PERSONA_BODY",
                encoding="utf-8",
            )
            (project_claude / "settings.local.json").write_text(
                json.dumps({"outputStyle": "local-persona"}),
                encoding="utf-8",
            )
            resolved_local = claude_agy.resolve_active_claude_output_style(env_for_account, project_dir)
            self.assertIsNotNone(resolved_local)
            self.assertEqual(resolved_local["name"], "local-persona")
            self.assertFalse(resolved_local["keep_coding_instructions"])
            orch_no_coding = app._claude_agy_orchestrator_system_append(None, output_style=resolved_local)
            self.assertNotIn(app.CLAUDE_CODE_ORCHESTRATOR_PROMPT, orch_no_coding)
            self.assertIn("PROJECT_PERSONA_BODY", orch_no_coding)

            # Project setting outputStyle="default" cleanly disables custom style
            (project_claude / "settings.local.json").write_text(
                json.dumps({"outputStyle": "default"}),
                encoding="utf-8",
            )
            self.assertIsNone(claude_agy.resolve_active_claude_output_style(env_for_account, project_dir))

    def test_worker_environment_enables_minimal_agent_to_strip_agy_system_prompt(self):
        with tempfile.TemporaryDirectory(prefix="mintcli-minimal-agent-test-") as tmp:
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("AGY_BRIDGE_MINIMAL_AGENT", None)
                worker_env, _ = claude_agy._worker_environment({"HOME": tmp}, "/usr/bin/agy", tmp)
                self.assertEqual(worker_env["AGY_BRIDGE_MINIMAL_AGENT"], "1")
                self.assertEqual(worker_env["AGY_BRIDGE_SYSTEM_APPEND"], "0")


if __name__ == "__main__":
    unittest.main()
