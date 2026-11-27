"""Tests for think_translate_engine configuration persistence, parsing, and caching."""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
from pathlib import Path
from unittest import TestCase

sys.path.insert(0, str(Path(__file__).resolve().parent))

from think_translate_engine import (  # noqa: E402
    TranslateCallError,
    build_translation_prompt,
    clear_translation_cache,
    extract_text_from_stream_json,
    extract_translate_stream_details,
    get_translate_cooldown_reason,
    load_think_translate_config,
    parse_agy_error_detail,
    save_think_translate_config,
    translate_thinking_text,
)


class ThinkTranslateEngineTests(TestCase):
    def setUp(self) -> None:
        clear_translation_cache()

    def test_config_roundtrip_persists_account_and_model(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = Path(tmp) / "think_translate_config.json"
            initial = load_think_translate_config(cfg_path)
            self.assertEqual(initial["account_id"], "")
            self.assertEqual(initial["model"], "")
            self.assertEqual(initial["target_lang"], "zh-CN")

            saved = save_think_translate_config(
                cfg_path,
                account_id="acc-alpha",
                model="gemini-3-flash",
                target_lang="zh-CN",
            )
            self.assertEqual(saved["account_id"], "acc-alpha")
            self.assertEqual(saved["model"], "gemini-3-flash")
            self.assertTrue(saved["updated_at"])

            reloaded = load_think_translate_config(cfg_path)
            self.assertEqual(reloaded["account_id"], "acc-alpha")
            self.assertEqual(reloaded["model"], "gemini-3-flash")

            # Partial update preserves existing account_id
            updated = save_think_translate_config(cfg_path, model="gemini-4-neon-low")
            self.assertEqual(updated["account_id"], "acc-alpha")
            self.assertEqual(updated["model"], "gemini-4-neon-low")

    def test_extract_text_skips_thinking_events(self) -> None:
        lines = [
            json.dumps({"type": "thinking", "text": "Internal thought should be ignored"}),
            json.dumps({"type": "delta", "delta": "第一步："}),
            json.dumps({"type": "delta", "delta": "检查 `app.py` 路由。"}),
            json.dumps({"type": "result", "response": "fallback"}),
        ]
        extracted = extract_text_from_stream_json("\n".join(lines))
        self.assertEqual(extracted, "第一步：检查 `app.py` 路由。")

    def test_extract_text_from_assistant_message_event(self) -> None:
        lines = [
            json.dumps({"type": "message", "role": "user", "content": "ignored"}),
            json.dumps({"type": "message", "role": "assistant", "content": "已翻译的思考过程"}),
        ]
        self.assertEqual(extract_text_from_stream_json("\n".join(lines)), "已翻译的思考过程")

    def test_extract_text_from_agy_step_update_stream_json(self) -> None:
        lines = [
            json.dumps({"event": "init", "conversation_id": "cid-1", "init": {"model": "gemini-4-hydrogen-medium"}}),
            json.dumps({"event": "step_update", "step_update": {"step_index": 0, "state": "DONE", "step_type": "user_input"}}),
            json.dumps({"event": "step_update", "step_update": {"step_index": 1, "state": "ACTIVE", "step_type": "thinking", "text_delta": "Internal thought"}}),
            json.dumps({"event": "step_update", "step_update": {"step_index": 2, "state": "ACTIVE", "step_type": "agent_response", "text_delta": "你好，"}}),
            json.dumps({"event": "step_update", "step_update": {"step_index": 2, "state": "ACTIVE", "step_type": "agent_response", "text_delta": "世界。"}}),
            json.dumps({"event": "step_update", "step_update": {"step_index": 2, "state": "DONE", "step_type": "agent_response"}}),
            json.dumps({"event": "result", "result": {"status": "COMPLETED", "response": "fallback"}}),
        ]
        self.assertEqual(extract_text_from_stream_json("\n".join(lines)), "你好，世界。")

    def test_extract_text_from_nested_result_dict(self) -> None:
        lines = [
            json.dumps({"event": "result", "result": {"status": "COMPLETED", "response": "嵌套结果译文"}}),
        ]
        self.assertEqual(extract_text_from_stream_json("\n".join(lines)), "嵌套结果译文")

    def test_translate_uses_fake_cli_and_caches_result(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            counter_file = tmp_path / "calls.txt"
            fake_cli = tmp_path / "fake_agy.py"
            fake_cli.write_text(
                "#!/usr/bin/env python3\n"
                "import json, sys\n"
                f"with open({str(counter_file)!r}, 'a', encoding='utf-8') as f: f.write('1\\n')\n"
                "print(json.dumps({'type': 'thinking', 'text': 'ignored'}))\n"
                "print(json.dumps({'type': 'delta', 'delta': '初步评估：检查配置文件。'}))\n",
                encoding="utf-8",
            )
            fake_cli.chmod(0o755)

            res1 = asyncio.run(
                translate_thinking_text(
                    text="Initial assessment: inspect config file.",
                    target_lang="zh-CN",
                    account_id="acc-1",
                    model="gemini-3-flash",
                    agy_bin=str(fake_cli),
                    run_env={"PATH": "/usr/bin:/bin"},
                    scratch_dir=tmp_path,
                )
            )
            self.assertTrue(res1["ok"])
            self.assertFalse(res1["cached"])
            self.assertEqual(res1["translated"], "初步评估：检查配置文件。")

            res2 = asyncio.run(
                translate_thinking_text(
                    text="Initial assessment: inspect config file.",
                    target_lang="zh-CN",
                    account_id="acc-1",
                    model="gemini-3-flash",
                    agy_bin=str(fake_cli),
                    run_env={"PATH": "/usr/bin:/bin"},
                    scratch_dir=tmp_path,
                )
            )
            self.assertTrue(res2["cached"])
            self.assertEqual(res2["translated"], "初步评估：检查配置文件。")
            self.assertEqual(len(counter_file.read_text(encoding="utf-8").splitlines()), 1)

    def test_prompt_contains_strict_rules(self) -> None:
        prompt = build_translation_prompt("Check `app.py`", "zh-CN")
        self.assertIn("Simplified Chinese", prompt)
        self.assertIn("Check `app.py`", prompt)

    def test_isolated_translate_home_prevents_orphan_conversations_and_syncs_refreshed_token(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_home = root / "source-home"
            source_cli = source_home / ".gemini" / "antigravity-cli"
            (source_cli / "conversations").mkdir(parents=True)
            (source_cli / "rules").mkdir(parents=True)
            (source_cli / "rules" / "00-armor.md").write_text("should-not-leak", encoding="utf-8")
            src_token = source_cli / "antigravity-oauth-token"
            src_token.write_text(json.dumps({"access_token": "old-tok", "refresh_token": "ref-1"}), encoding="utf-8")

            scratch = root / "scratch"
            scratch.mkdir()
            fake_cli = root / "fake_agy_iso.py"
            fake_cli.write_text(
                "#!/usr/bin/env python3\n"
                "import json, os, pathlib, sys\n"
                "h = pathlib.Path(os.environ['HOME'])\n"
                "assert not (h / '.gemini' / 'antigravity-cli' / 'rules' / '00-armor.md').exists()\n"
                "mcp = json.loads((h / '.gemini' / 'config' / 'mcp_config.json').read_text())\n"
                "assert mcp == {'mcpServers': {}}\n"
                "assert '--disable-slash-commands' in sys.argv\n"
                "(h / '.gemini' / 'antigravity-cli' / 'conversations' / 'orphan.db').write_text('tmp')\n"
                "(h / '.gemini' / 'antigravity-cli' / 'antigravity-oauth-token').write_text(\n"
                "    json.dumps({'access_token': 'refreshed-tok', 'refresh_token': 'ref-1'})\n"
                ")\n"
                "print(json.dumps({'type': 'delta', 'delta': '隔离翻译成功'}))\n",
                encoding="utf-8",
            )
            fake_cli.chmod(0o755)

            res = asyncio.run(
                translate_thinking_text(
                    text="Verify isolated translation home.",
                    target_lang="zh-CN",
                    account_id="acc-iso",
                    model="",
                    agy_bin=str(fake_cli),
                    run_env={"PATH": "/usr/bin:/bin", "HOME": str(source_home)},
                    scratch_dir=scratch,
                )
            )
            self.assertEqual(res["translated"], "隔离翻译成功")
            # Source conversations dir stays completely clean (zero orphan transcripts)
            self.assertEqual(list((source_cli / "conversations").iterdir()), [])
            # Refreshed OAuth token was safely synced back to source HOME
            synced = json.loads(src_token.read_text(encoding="utf-8"))
            self.assertEqual(synced["access_token"], "refreshed-tok")

    def test_parses_agy_quota_error_and_records_account_cooldown(self) -> None:
        raw_stderr = (
            'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. '
            'Please upgrade your subscription to increase your limits. Resets in 163h9m22s.",'
            '"status":"RESOURCE_EXHAUSTED","error_code":429,"code_kind":"http","retryable":false}'
        )
        parsed = parse_agy_error_detail(raw_stderr, "", 1)
        self.assertEqual(parsed["category"], "quota_exhausted")
        self.assertEqual(parsed["error_code"], 429)
        self.assertTrue(parsed["account_wide"])
        self.assertEqual(parsed["reset_hint"], "163h9m22s")
        self.assertGreater(parsed["reset_seconds"], 163 * 3600)
        self.assertIn("翻译模型额度已耗尽", parsed["message"])
        self.assertNotIn('{"short_error"', parsed["message"])

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            fake_cli = tmp_path / "fake_agy_429.py"
            fake_cli.write_text(
                "#!/usr/bin/env python3\n"
                "import sys\n"
                f"sys.stderr.write({raw_stderr!r} + '\\n')\n"
                "sys.exit(1)\n",
                encoding="utf-8",
            )
            fake_cli.chmod(0o755)
            with self.assertRaises(TranslateCallError) as ctx:
                asyncio.run(
                    translate_thinking_text(
                        text="Translate quota check.",
                        target_lang="zh-CN",
                        account_id="user-a@example.com",
                        model="gemini-4-hydrogen-medium",
                        agy_bin=str(fake_cli),
                        run_env={"PATH": "/usr/bin:/bin"},
                        scratch_dir=tmp_path,
                    )
                )
            self.assertEqual(ctx.exception.category, "quota_exhausted")
            self.assertTrue(ctx.exception.account_wide)
            # Account-wide cooldown blocks any model on that exhausted account immediately
            self.assertIsNotNone(get_translate_cooldown_reason("user-a@example.com", "gemini-3.8-flash-low"))

    def test_extracts_usage_duration_and_reported_model_from_stream_json(self) -> None:
        lines = [
            json.dumps({"event": "init", "conversation_id": "c-1", "init": {"model": "gemini-3.8-flash-low"}}),
            json.dumps({"event": "step_update", "step_update": {"step_index": 1, "state": "ACTIVE", "step_type": "agent_response", "text_delta": "译文测试"}}),
            json.dumps({
                "event": "result",
                "result": {
                    "status": "SUCCESS",
                    "response": "译文测试",
                    "duration_seconds": 1.82,
                    "usage": {
                        "input_tokens": 9200,
                        "output_tokens": 24,
                        "thinking_tokens": 0,
                        "cache_read_tokens": 4000,
                        "total_tokens": 9224,
                    },
                },
            }),
        ]
        details = extract_translate_stream_details("\n".join(lines))
        self.assertEqual(details["text"], "译文测试")
        self.assertEqual(details["reported_model"], "gemini-3.8-flash-low")
        self.assertEqual(details["duration_ms"], 1820)
        self.assertEqual(
            details["usage"],
            {"input": 9200, "output": 24, "cacheRead": 4000, "cacheWrite": 0, "reasoning": 0, "total": 9224},
        )
