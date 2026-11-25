"""Unit and integration tests for minimal-impact Thinking Language Follower."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

from acp_client import stream_agy_acp
from think_lang_engine import (
    THINK_LANG_SYSTEM_DIRECTIVE,
    append_think_lang_reminder,
    collect_user_history_texts,
    detect_think_target_lang,
)


class ThinkLangEngineTests(unittest.TestCase):
    def test_chinese_prompt_with_heavy_english_stack_trace(self) -> None:
        msg = (
            '收到报错 TypeError: Cannot read properties of undefined (reading "map")\n'
            "    at UserList (src/components/UserList.tsx:42:18)\n"
            "    at renderWithHooks (node_modules/react-dom/cjs/react-dom.development.js:16305:18)\n"
            "    at mountIndeterminateComponent (node_modules/react-dom/cjs/react-dom.development.js:20074:13)\n"
            "```tsx\n"
            "export function UserList({ items }: Props) {\n"
            "  return items.map(item => <div key={item.id}>{item.name}</div>);\n"
            "}\n"
            "```\n"
            "排查"
        )
        lang, switched = detect_think_target_lang(msg)
        self.assertEqual(lang, "zh-CN")
        self.assertFalse(switched)

        enriched, resolved = append_think_lang_reminder(msg)
        self.assertEqual(resolved, "zh-CN")
        self.assertIn("全程使用简体中文逐点分析", enriched)
        self.assertIn("保留代码片段、标识符、路径、报错原文与技术术语原样", enriched)
        # Ensure original code block is completely untouched
        self.assertIn("return items.map(item => <div key={item.id}>{item.name}</div>);", enriched)

    def test_english_prompt_with_cjk_string_literal_adds_zero_tokens(self) -> None:
        msg = 'Why does getProjectFolder("中文项目") return an empty string in desktopWindow.js?'
        lang, switched = detect_think_target_lang(msg)
        self.assertEqual(lang, "en")
        self.assertFalse(switched)

        enriched, resolved = append_think_lang_reminder(msg)
        self.assertEqual(resolved, "en")
        # Zero extra tokens on normal English prompts!
        self.assertEqual(enriched, msg)

    def test_english_prompt_with_unquoted_tiny_cjk_sample_stays_english(self) -> None:
        msg = "Fix the encoding bug when input contains 中文 characters in the parser"
        lang, switched = detect_think_target_lang(msg)
        self.assertEqual(lang, "en")
        self.assertFalse(switched)
        enriched, _ = append_think_lang_reminder(msg)
        self.assertEqual(enriched, msg)

    def test_multilingual_detection_zh_tw_ja_ko_ru(self) -> None:
        self.assertEqual(detect_think_target_lang("請幫我檢查這段程式碼為什麼會報錯")[0], "zh-TW")
        self.assertEqual(detect_think_target_lang("このエラーの原因を調べて修正してください")[0], "ja")
        self.assertEqual(detect_think_target_lang("이 오류가 발생하는 원인을 분석해 주세요")[0], "ko")
        self.assertEqual(detect_think_target_lang("Проверьте почему возникает эта ошибка в коде")[0], "ru")

    def test_pure_stack_trace_inherits_history_language(self) -> None:
        pure_trace = (
            "Traceback (most recent call last):\n"
            '  File "/app/server.py", line 88, in handle\n'
            "    return data.items()\n"
            "AttributeError: 'NoneType' object has no attribute 'items'"
        )
        # Without history: None -> no forced reminder
        lang_no_hist, _ = detect_think_target_lang(pure_trace)
        self.assertIsNone(lang_no_hist)
        unchanged, _ = append_think_lang_reminder(pure_trace)
        self.assertEqual(unchanged, pure_trace)

        # With Chinese history: inherits zh-CN
        history = collect_user_history_texts([{"role": "user", "content": "帮我看下后端接口报错"}])
        enriched, resolved = append_think_lang_reminder(pure_trace, history_user_texts=history)
        self.assertEqual(resolved, "zh-CN")
        self.assertIn("简体中文", enriched)

    def test_switching_from_chinese_history_to_english_adds_switch_reminder(self) -> None:
        history = ["先用中文聊聊架构设计"]
        en_msg = "Now please explain how the WebSocket reconnection backoff works in English."
        enriched, resolved = append_think_lang_reminder(en_msg, history_user_texts=history)
        self.assertEqual(resolved, "en")
        self.assertIn("Conduct your entire internal thinking (thought) in English", enriched)

    def test_attachment_header_alone_does_not_force_chinese_on_english_prompt(self) -> None:
        formatted = "[附带图片: screenshot.png (本地路径: /tmp/s.png)。请使用相应工具查看此图片内容并作答。]\n\nWhat is misaligned in this navbar?"
        lang, _ = detect_think_target_lang(formatted)
        self.assertEqual(lang, "en")

    def test_system_directive_remains_static_for_prompt_cache(self) -> None:
        self.assertIn("Keep code snippets, identifiers, file paths", THINK_LANG_SYSTEM_DIRECTIVE)

    def test_acp_resume_and_mid_turn_injection_carry_transient_reminder(self) -> None:
        fake_server = """
import json, os, sys
from pathlib import Path

capture_file = Path(os.environ["THINK_LANG_CAPTURE"])
captured = []

for line in sys.stdin:
    msg = json.loads(line)
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": 1,
            "agentCapabilities": {"_meta": {"antigravity": {"systemPrompt": {"append": True}}}}
        }}), flush=True)
    elif method == "session/resume":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": msg["params"]["sessionId"]}}), flush=True)
    elif method == "session/set_model":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {}}), flush=True)
    elif method == "session/prompt":
        text = msg["params"]["prompt"][0]["text"]
        captured.append(text)
        capture_file.write_text(json.dumps(captured, ensure_ascii=False), encoding="utf-8")
        if len(captured) == 1:
            print(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {
                "sessionId": "sid-resume-1",
                "update": {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "正在分析..."}}
            }}), flush=True)
            # Wait briefly if a second prompt arrives, else finish when second arrives
        if len(captured) == 2:
            print(json.dumps({"jsonrpc": "2.0", "id": mid - 1, "result": {"stopReason": "end_turn"}}), flush=True)
            print(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {
                "sessionId": "sid-resume-1",
                "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "已修复"}}
            }}), flush=True)
            print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}}), flush=True)
            break
"""

        async def run() -> tuple[list[str], list[dict]]:
            with tempfile.TemporaryDirectory() as tmp:
                tmp_path = Path(tmp)
                wrapper = tmp_path / "fake_agy_resume.py"
                wrapper.write_text(f"#!{sys.executable}\n{fake_server}", encoding="utf-8")
                wrapper.chmod(0o755)

                capture_path = tmp_path / "captured.json"
                env = {**os.environ, "THINK_LANG_CAPTURE": str(capture_path)}
                injector_holder = []
                events = []
                raw_prompt = 'TypeError: x.map is not a function at App.tsx:12，为什么？'
                async for ev in stream_agy_acp(
                    agy_bin=str(wrapper),
                    prompt=raw_prompt,
                    model="gemini-4-neon-high",
                    target_cwd=str(tmp_path),
                    run_env=env,
                    scratch_dir=tmp_path,
                    conversation_id="sid-resume-1",
                    persist_conversation=False,
                    system_append=THINK_LANG_SYSTEM_DIRECTIVE,
                    register_injector=lambda fn: injector_holder.append(fn),
                    use_think_lang=True,
                    think_lang_user_text=raw_prompt,
                ):
                    events.append(ev)
                    if ev.get("event") == "thinking" and injector_holder and injector_holder[0]:
                        ok = await injector_holder[0]("顺便看下 Line 20", "u-inject-1")
                        self.assertTrue(ok)

                captured = json.loads(capture_path.read_text(encoding="utf-8"))
                return captured, events

        captured_prompts, seen_events = asyncio.run(run())
        self.assertEqual(len(captured_prompts), 2)
        self.assertIn("全程使用简体中文逐点分析", captured_prompts[0])
        self.assertIn("全程使用简体中文逐点分析", captured_prompts[1])
        meta_events = [e for e in seen_events if isinstance(e.get("route_info"), dict)]
        self.assertTrue(any(e["route_info"].get("think_lang", {}).get("lang") == "zh-CN" for e in meta_events))


if __name__ == "__main__":
    unittest.main()
