import tempfile
from pathlib import Path
import unittest

import app
from armor_engine import gate_decision, strip_foreign_armor
from transam_engine import (
    build_transam_turn_prompt,
    get_transam_system_directive,
    has_transam_history_tags,
    is_continue_prompt,
    load_transam_preset,
    resolve_transam_tier,
    sanitize_transam_history_content,
    sync_transam_rules,
)


class TestTransAmEngine(unittest.TestCase):
    def test_resolve_transam_tier_routes_4a_4n_and_4h(self):
        self.assertEqual(resolve_transam_tier("gemini-4-argon-medium", None), "4A")
        self.assertEqual(resolve_transam_tier("default", "Gemini 4 Argon (High)"), "4A")
        self.assertEqual(resolve_transam_tier("gemini-4-neon-high", None), "4N")
        self.assertEqual(resolve_transam_tier("default", "Gemini 4 Neon"), "4N")
        self.assertEqual(resolve_transam_tier("gemini-4-carbon-high", None), "4H")
        self.assertEqual(resolve_transam_tier("claude-opus-5", None), "4H")
        self.assertEqual(resolve_transam_tier(None, None), "4H")

    def test_all_three_presets_load_and_compile_system_directives(self):
        for tier, expected_ver in [("4A", "4A v1.2.4.0"), ("4H", "4H v1.1.4.0"), ("4N", "4N v1.0.1.0")]:
            preset = load_transam_preset(tier)
            self.assertEqual(preset["tier"], tier)
            self.assertEqual(preset["version"], expected_ver)
            self.assertGreaterEqual(len(preset["pre_prompts"]), 3)
            self.assertEqual(len(preset["post_prompts"]), 0)

        for model_name, expected_ver in [
            ("gemini-4-argon-medium", "4A v1.2.4.0"),
            ("gemini-4-carbon-high", "4H v1.1.4.0"),
            ("gemini-4-neon-high", "4N v1.0.1.0"),
        ]:
            directive = get_transam_system_directive(model_name)
            self.assertIn(f"Global Rules — TRANS-AM Narrative Engine ({expected_ver})", directive)
            if expected_ver.startswith(("4H", "4N")):
                self.assertIn("<ta_rule_core>", directive)
                self.assertIn("DELIBERATION:", directive)
            self.assertIn("<ta_rule_demographic_integrity>", directive)
            self.assertIn("<ta_settled_premise>", directive)
            # Style, format, word-count, and RP output locks must be stripped
            self.assertNotIn("<ta_rule_output_contract>", directive)
            self.assertNotIn("<ta_rule_prose_wordlist>", directive)
            self.assertNotIn("<ta_rule_min_length>", directive)
            self.assertNotIn("TARGET_HAN", directive)
            self.assertNotIn("<ta_plan>", directive)

    def test_build_transam_turn_prompt_keeps_prompt_clean_without_format_or_dice(self):
        enriched, meta = build_transam_turn_prompt(
            "请重构这个模块的异步逻辑",
            model="gemini-4-neon-high",
            dice=[17, 42, 88, 95],
        )
        self.assertEqual(meta["tier"], "4N")
        self.assertEqual(meta["dice"], [17, 42, 88, 95])
        self.assertFalse(meta["is_continue"])
        self.assertEqual(enriched, "请重构这个模块的异步逻辑")
        self.assertNotIn("<ta_roll_pool>", enriched)
        self.assertNotIn("<ta_rule_execution_lock>", enriched)

        # Continue prompt only activates when prior assistant history has TRANS-AM tags
        self.assertTrue(is_continue_prompt("继续"))
        self.assertFalse(has_transam_history_tags([{"role": "assistant", "content": "普通代码回复"}]))
        self.assertTrue(has_transam_history_tags([{"role": "assistant", "content": "<ta_zh>正文</ta_zh>"}]))

    def test_sanitize_transam_history_content_preserves_fenced_code_blocks(self):
        sample = (
            "<thinking>内部思考</thinking>\n"
            "<ta_plan>本轮规划备忘</ta_plan>\n"
            "```xml\n<thinking>保留示例</thinking>\n<ta_plan>保留代码</ta_plan>\n```\n"
            "<ta_zh>她推开门。<ta_noise_pad>pad</ta_noise_pad>走入雨中。</ta_zh>\n"
            "<ta_hub>{\"affection\": 50}</ta_hub>\n"
            "<ta_record>第一日 18:00：进入雨中</ta_record>\n"
            "<ta_choices><ta_plot>A</ta_plot></ta_choices>\n"
            "<ta_resolve>done</ta_resolve>"
        )
        older = sanitize_transam_history_content(sample, is_latest_assistant=False)
        self.assertNotIn("<thinking>内部思考</thinking>", older)
        self.assertNotIn("<ta_plan>本轮规划备忘</ta_plan>", older)
        self.assertIn("```xml\n<thinking>保留示例</thinking>\n<ta_plan>保留代码</ta_plan>\n```", older)
        self.assertNotIn("<ta_noise_pad>", older)
        self.assertNotIn("<ta_choices>", older)
        self.assertNotIn("<ta_resolve>", older)
        self.assertNotIn("<ta_hub>", older)
        self.assertIn("<ta_zh>她推开门。走入雨中。</ta_zh>", older)
        self.assertIn("<ta_record>第一日 18:00：进入雨中</ta_record>", older)

        latest = sanitize_transam_history_content(sample, is_latest_assistant=True)
        self.assertIn("<ta_hub>", latest)

    def test_armor_and_transam_coexist_without_conflict(self):
        # 1) Armor's strip_foreign_armor must never strip TRANS-AM directives
        directive = get_transam_system_directive("gemini-4-argon-medium")
        cleaned, removed = strip_foreign_armor(directive)
        self.assertEqual(removed, 0)
        self.assertEqual(cleaned, directive)

        # 2) Armor's streaming gate immediately flushes <ta_plan> / <ta_zh> openers
        decision = gate_decision("<ta_plan>场景锚定：雨夜酒馆</ta_plan><ta_zh>雨水顺着屋檐滴落。")
        self.assertEqual(decision["action"], "flush")

        # 3) _compose_system_append combines Armor + TRANS-AM cleanly
        combined = app._compose_system_append(
            "Base System",
            use_armor=True,
            use_transam=True,
            agent_tools=False,
            model="gemini-4-argon-medium",
        )
        self.assertIn("Base System", combined)
        self.assertIn("Global Rules — Antigravity armor", combined)
        self.assertIn("Global Rules — TRANS-AM Narrative Engine (4A v1.2.4.0)", combined)

    def test_concurrency_safe_rule_sync_coexists_with_armor(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "shared-home"
            home.mkdir()
            armor_file = home / ".gemini" / "antigravity-cli" / "rules" / "00-armor.md"
            transam_file = home / ".gemini" / "antigravity-cli" / "rules" / "01-transam.md"

            lease_armor = app._sync_armor_rules_concurrency_safe(True, target_cwd=None, agy_home=str(home))
            lease_ta = app._sync_transam_rules_concurrency_safe(
                True,
                target_cwd=None,
                agy_home=str(home),
                model="gemini-4-neon-high",
            )
            self.assertTrue(armor_file.exists())
            self.assertTrue(transam_file.exists())
            self.assertIn("4N v1.0.1.0", transam_file.read_text(encoding="utf-8"))

            # Another window runs with TRANS-AM off while lease_ta is active -> must not delete yet
            app._sync_transam_rules_concurrency_safe(False, target_cwd=None, agy_home=str(home))
            self.assertTrue(transam_file.exists())

            # Release TRANS-AM lease -> 01-transam.md cleaned up while 00-armor.md remains intact
            app._release_transam_turn_home(lease_ta)
            self.assertFalse(transam_file.exists())
            self.assertTrue(armor_file.exists())

            app._release_armor_turn_home(lease_armor)


if __name__ == "__main__":
    unittest.main()
