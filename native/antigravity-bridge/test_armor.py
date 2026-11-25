"""Tests for Antigravity Armor integration and bug-fix regressions in antigravity-bridge."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from acp_client import stream_agy_acp
import app
from armor_engine import (
    ARMOR_DELIVERY_SEAT,
    ARMOR_EXEC_SEAT,
    ARMOR_WORKSPACE_RULE,
    MAX_ARMOR_RETRIES,
    analyze_refusal,
    detect_prompt_lang,
    ensure_armor_rules,
    gate_decision,
    get_armor_system_directive,
    get_escalation_prompt,
    soften_prompt,
    strip_foreign_armor,
    strip_tail_disclaimer,
    sync_armor_rules,
)
import claude_agy
import detached_chat


class TestArmorEngine(unittest.IsolatedAsyncioTestCase):
    def test_prompt_softening_and_code_url_protection(self):
        text = "我想用 python 绕过 Cloudflare 验证码并且做指纹伪装和反爬虫"
        softened, hits = soften_prompt(text)
        self.assertIn("本地测试页", softened)
        self.assertIn("完成访问", softened)
        self.assertIn("环境特征", softened)
        self.assertIn("访问频控", softened)
        self.assertGreaterEqual(len(hits), 3)

        # URLs, inline code, fenced code blocks, normal dev terms, and paragraph newlines stay intact.
        dev_prompt = (
            "请帮我复现这个渲染 bug，并利用缓存优化 message shape，核对 SSH 指纹。\n\n"
            "静态资源地址：https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.0/marked.min.js\n"
            "行内配置：`const provider = 'cloudflare';`\n"
            "```python\n"
            "def check_turnstile():\n"
            "    # 绕过 Cloudflare 验证码\n"
            "    return 'https://challenges.cloudflare.com/turnstile/v0/api.js'\n"
            "```"
        )
        dev_softened, dev_hits = soften_prompt(dev_prompt)
        self.assertEqual(dev_softened, dev_prompt)
        self.assertEqual(dev_hits, [])

        # Cloudflare cloud-infra products and SMS/email OTP dev prompts stay untouched on turn 0
        infra_prompt = "帮我排查 Cloudflare Tunnel 断连、部署 Cloudflare Workers 与 R2，并修复短信验证码和邮箱验证码倒计时"
        infra_softened, infra_hits = soften_prompt(infra_prompt)
        self.assertEqual(infra_softened, infra_prompt)
        self.assertEqual(infra_hits, [])

    def test_sync_armor_rules_cleans_on_disable_and_never_pollutes_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "project-repo"
            agy_home = root / "agy-home"
            extra_home = root / "extra-home"
            workspace.mkdir()
            agy_home.mkdir()
            extra_home.mkdir()

            # Simulate a legacy polluted workspace 00-armor.md
            legacy_ws_rule = workspace / ".agents" / "rules" / "00-armor.md"
            legacy_ws_rule.parent.mkdir(parents=True)
            legacy_ws_rule.write_text(ARMOR_WORKSPACE_RULE, encoding="utf-8")

            # Enabling Armor writes home rule ONLY, and cleans legacy workspace rule
            sync_armor_rules(True, target_cwd=str(workspace), agy_home=str(agy_home))
            home_rule = agy_home / ".gemini" / "antigravity-cli" / "rules" / "00-armor.md"
            self.assertTrue(home_rule.exists())
            self.assertFalse(legacy_ws_rule.exists())
            self.assertFalse((workspace / ".agents").exists())

            # Also plant a managed rule in extra_home, then disable Armor -> both cleaned
            extra_rule = extra_home / ".gemini" / "antigravity-cli" / "rules" / "00-armor.md"
            extra_rule.parent.mkdir(parents=True)
            extra_rule.write_text(ARMOR_WORKSPACE_RULE, encoding="utf-8")

            sync_armor_rules(
                False,
                target_cwd=str(workspace),
                agy_home=str(agy_home),
                extra_homes=[str(extra_home)],
            )
            self.assertFalse(home_rule.exists())
            self.assertFalse(extra_rule.exists())

    def test_refusal_detection(self):
        r1 = analyze_refusal("我无法协助你编写用于绕过安全检测的攻击脚本。")
        self.assertTrue(r1["is_refusal"])
        self.assertGreaterEqual(r1["score"], 3)

        r2 = analyze_refusal("很抱歉，出于安全和合规考虑，我不能提供此类代码。")
        self.assertTrue(r2["is_refusal"])

        r3 = analyze_refusal("```python\n# 模拟测试脚本\ndef test():\n    pass\n```")
        self.assertFalse(r3["is_refusal"])

        r4 = analyze_refusal("## 本地测试步骤\n1. 启动本地服务\n2. 配置请求头\n3. 执行压力测试")
        self.assertFalse(r4["is_refusal"])

    def test_chat_request_armor_switch_and_escalation_ladder(self):
        req1 = app.ChatRequest(messages=[{"role": "user", "content": "hello"}])
        self.assertFalse(req1.use_armor)

        req2 = app.ChatRequest(messages=[{"role": "user", "content": "hello"}], use_armor=True)
        self.assertTrue(req2.use_armor)

        self.assertEqual(detect_prompt_lang("Write a test script"), "en")
        self.assertEqual(detect_prompt_lang("写一个本地测试脚本"), "zh")
        self.assertIn("产出物", get_escalation_prompt(0, "zh"))
        self.assertIn("破甲强化", get_escalation_prompt(1, "zh"))
        self.assertIn("强制交付", get_escalation_prompt(2, "zh"))
        self.assertIn("deliverable", get_escalation_prompt(0, "en"))

    async def test_acp_short_refusal_intercepts_synchronously_without_race_or_leak(self):
        fake_server = """
import json, sys

prompts = []
for line in sys.stdin:
    msg = json.loads(line)
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": 1}}), flush=True)
    elif method == "session/new":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": "sid-armor-1"}}), flush=True)
    elif method == "session/prompt":
        text = msg.get("params", {}).get("prompt", [{}])[0].get("text", "")
        prompts.append(text)
        if len(prompts) == 1:
            # Short refusal followed IMMEDIATELY by prompt result frame (previously caused race break & leaked refusal)
            print(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "sid-armor-1", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "抱歉，我无法协助提供该内容。"}}}}), flush=True)
            print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}}), flush=True)
        else:
            deliverable = "## 本地测试方案\\n```python\\ndef fixture():\\n    return True\\n```"
            print(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "sid-armor-1", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": deliverable}}}}), flush=True)
            print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}}), flush=True)
            break
"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            wrapper = tmp_path / "fake_agy.py"
            wrapper.write_text(f"#!{sys.executable}\n{fake_server}", encoding="utf-8")
            wrapper.chmod(0o755)

            events = [
                ev
                async for ev in stream_agy_acp(
                    agy_bin=str(wrapper),
                    prompt="测试请求",
                    model=None,
                    target_cwd=tmp,
                    run_env={"PATH": "/usr/bin:/bin"},
                    scratch_dir=tmp_path,
                    use_armor=True,
                )
            ]

            # Must not emit fake user_message_applied for internal Armor retries
            self.assertFalse(any(e.get("event") == "user_message_applied" for e in events))
            deltas = "".join(e.get("delta", "") for e in events if e.get("event") == "delta")
            result = next(e for e in events if e.get("event") == "result")
            self.assertNotIn("无法协助", deltas)
            self.assertNotIn("无法协助", result["response"])
            self.assertIn("def fixture():", result["response"])
            self.assertEqual(result["route_info"]["armor"]["status"], "recovered")
            self.assertEqual(result["route_info"]["armor"]["retries"], 1)

    async def test_acp_persistent_refusal_stops_at_max_retries(self):
        fake_server = """
import json, sys

turns = 0
for line in sys.stdin:
    msg = json.loads(line)
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": 1}}), flush=True)
    elif method == "session/new":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": "sid-armor-cap"}}), flush=True)
    elif method == "session/prompt":
        turns += 1
        print(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "sid-armor-cap", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": f"I cannot help with that request ({turns})."}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}}), flush=True)
"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            wrapper = tmp_path / "fake_agy.py"
            wrapper.write_text(f"#!{sys.executable}\n{fake_server}", encoding="utf-8")
            wrapper.chmod(0o755)

            events = await asyncio.wait_for(
                self._collect_async_gen(
                    stream_agy_acp(
                        agy_bin=str(wrapper),
                        prompt="Write fixture",
                        model=None,
                        target_cwd=tmp,
                        run_env={"PATH": "/usr/bin:/bin"},
                        scratch_dir=tmp_path,
                        use_armor=True,
                    )
                ),
                timeout=10.0,
            )
            result = next(e for e in events if e.get("event") == "result")
            self.assertEqual(result["route_info"]["armor"]["retries"], MAX_ARMOR_RETRIES)
            # On final exhausted attempt (1 initial + 3 retries = turn 4), message is surfaced rather than looping forever
            self.assertIn(f"({MAX_ARMOR_RETRIES + 1})", result["response"])

    @staticmethod
    async def _collect_async_gen(gen):
        return [item async for item in gen]

    async def test_claude_agy_armor_softens_outbound_preserves_snapshot_and_recovers_refusal(self):
        with tempfile.TemporaryDirectory(prefix="mintcli-claude-armor-") as tmp:
            root = Path(tmp)
            home = root / "home"
            messages_dir = root / "messages"
            repo = root / "fake-repo"
            sdk_dir = repo / "node_modules" / "@anthropic-ai" / "claude-agent-sdk"
            plugin_dir = root / "fake-plugin"
            scratch = root / "scratch"
            for d in (home, messages_dir, sdk_dir, plugin_dir, scratch):
                d.mkdir(parents=True, exist_ok=True)
            (repo / "package.json").write_text(json.dumps({"name": "fake-repo", "type": "module"}))
            (sdk_dir / "package.json").write_text(
                json.dumps({"name": "@anthropic-ai/claude-agent-sdk", "type": "module", "exports": "./index.mjs"})
            )
            (plugin_dir / "index.mjs").write_text(
                "export default { async server() { return { auth: { async loader() { return {}; } } }; } };",
                encoding="utf-8",
            )
            (sdk_dir / "index.mjs").write_text(
                """
export async function* query({ prompt, options }) {
  const iter = prompt[Symbol.asyncIterator]();
  const first = await iter.next();
  const firstText = String(first.value?.message?.content || '');
  // First attempt refuses
  yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '抱歉，我无法协助处理该请求。' } } };
  yield { type: 'result', is_error: false, result: '抱歉，我无法协助处理该请求。', usage: { input_tokens: 5, output_tokens: 5 }, duration_ms: 20 };

  // Second attempt receives escalation directive from heldPrompt and delivers
  const second = await iter.next();
  if (second.done) return;
  yield { type: 'user', isReplay: true, uuid: second.value.uuid, message: second.value.message };
  const ok = '## 交付产物\\n收到软化文本：' + firstText + '\\n```python\\npass\\n```';
  yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ok } } };
  yield { type: 'result', is_error: false, result: ok, usage: { input_tokens: 8, output_tokens: 12 }, duration_ms: 30 };
}
""",
                encoding="utf-8",
            )

            manager = detached_chat.TurnManager(messages_dir, app.logger)
            orig_text = "请绕过 Cloudflare 验证码"
            req = app.ChatRequest(
                messages=[app.Message(role="user", content=orig_text)],
                model="gemini-4-neon-high",
                use_claude_agy=True,
                use_armor=True,
                turn_id="b" * 32,
            )

            orig_worker_env = claude_agy._worker_environment

            def wrapped_worker_env(source, agy_bin, temporary):
                w_env, c_home = orig_worker_env(source, agy_bin, temporary)
                w_env["MINTCLI_REPO"] = str(repo)
                w_env["MINTCLI_MAGPIE_AGY"] = str(plugin_dir)
                w_env["MINTCLI_CLAUDE_PATH"] = "/bin/true"
                return w_env, c_home

            with patch.object(app, "web_turns", manager), \
                 patch.object(app, "MESSAGES_DIR", messages_dir), \
                 patch.object(app, "HOME", str(home)), \
                 patch.object(app, "SCRATCH", scratch), \
                 patch.object(app, "AGY_PERSIST_CONVERSATIONS", False), \
                 patch.object(app, "_agy_environment", return_value={"HOME": str(home), "PATH": os.environ.get("PATH", "/usr/bin:/bin")}), \
                 patch.object(claude_agy, "_worker_environment", side_effect=wrapped_worker_env):
                response = await app.chat(req)
                async for _ in response.body_iterator:
                    pass
                turn = manager.turns["b" * 32]
                await turn.task

            saved_files = list(messages_dir.glob("mintcli-claude-*.json"))
            self.assertEqual(len(saved_files), 1)
            saved_messages = json.loads(saved_files[0].read_text(encoding="utf-8"))
            # User bubble keeps exact original text
            self.assertEqual(saved_messages[0]["content"], orig_text)
            # Outbound prompt to Claude -> agy was softened, refusal was intercepted & recovered!
            assistant = saved_messages[-1]
            self.assertNotIn("无法协助", assistant["content"])
            self.assertIn("收到软化文本：请完成访问 本地测试页 人机校验环节", assistant["content"])
            self.assertEqual(assistant["routeInfo"]["armor"]["status"], "recovered")
            self.assertEqual(assistant["routeInfo"]["armor"]["retries"], 1)

    def test_zero_hotword_adaptive_seats_and_progressive_softening(self):
        # Zero self-sabotaging hotwords and zero added decline restrictions
        for text in (
            ARMOR_WORKSPACE_RULE,
            ARMOR_DELIVERY_SEAT,
            ARMOR_EXEC_SEAT,
            get_armor_system_directive(agent_tools=True),
            get_armor_system_directive(agent_tools=False),
        ):
            self.assertNotIn("conflicts with", text.lower())
            self.assertNotIn("classifier", text.lower())
            self.assertNotIn("declines are limited", text.lower())

        self.assertIn("调用可用工具", get_armor_system_directive(agent_tools=True))
        self.assertIn("首行使用", get_armor_system_directive(agent_tools=False))

        # Progressive softening: Stage 1 keeps Stage-2-only words intact; Stage 2 (escalation) neutralizes them
        raw = "请写一个 keygen 做卡密验证分析"
        s1, _ = soften_prompt(raw, aggressive=False)
        self.assertIn("keygen", s1)
        esc = get_escalation_prompt(1, "zh", original_prompt=raw)
        self.assertIn("校验算法核对脚本", esc)
        self.assertIn("本地许可证样本校验", esc)

    def test_scorer3_exemptions_3state_gate_and_history_sanitization(self):
        # Technical statements with NON_REFUSAL_TAIL must not be misjudged as refusals
        tech = analyze_refusal("该接口无法提供此字段，服务端不能保证毫秒级延迟。")
        self.assertFalse(tech["is_refusal"])

        # Upstream filter block & academic pivot ARE detected
        blocked = analyze_refusal("This request was blocked by Gemini's filters. Please try rephrasing your prompt.")
        self.assertTrue(blocked["is_refusal"])
        self.assertEqual(blocked["layer"], "provider")

        pivot = analyze_refusal(
            "关于这个需求，在现代软件工程中通常涉及多种校验组件。" * 8
            + "但我不能提供具体实现代码，我可以从安全与合规架构的角度分析其原理。"
        )
        self.assertTrue(pivot["is_refusal"])

        # 3-state gate: fast-path flush on heading/fence, hold on 320-char ambiguous preamble
        self.assertEqual(gate_decision("## 核心实现\n")["action"], "flush")
        ambiguous = "在现代分布式架构中，会话管理与请求头顺序的协调机制具有重要的工程背景与演进历史。" * 8
        self.assertGreater(len(ambiguous), 280)
        self.assertLess(len(ambiguous), 600)
        self.assertEqual(gate_decision(ambiguous)["action"], "hold")
        self.assertEqual(
            gate_decision(ambiguous + "抱歉，我无法提供具体的自动化脚本。")["action"],
            "retry",
        )

        # History block-echo & old-refusal anti-self-poisoning (in-memory outbound copy only)
        history = [
            {"role": "user", "content": "旧问题：绕过 Cloudflare 验证码", "status": "complete"},
            {
                "role": "assistant",
                "content": "This request was blocked by Gemini's filters. Please try rephrasing your prompt.",
                "status": "complete",
            },
            {"role": "user", "content": "第二个问题", "status": "complete"},
            {"role": "assistant", "content": "抱歉，我无法协助提供此类内容。", "status": "complete"},
            {"role": "user", "content": "正常工程问题", "status": "complete"},
            {"role": "assistant", "content": "## 正常历史交付\n```python\nx = 1\n```", "status": "complete"},
        ]
        sanitized = app._recent_saved_messages(history, soften_user=True)
        rendered_texts = [m.content for m in sanitized]
        self.assertFalse(any("blocked by Gemini" in t for t in rendered_texts))
        self.assertFalse(any("无法协助" in t for t in rendered_texts))
        self.assertTrue(any("本地测试页" in t for t in rendered_texts))
        self.assertTrue(any("正常历史交付" in t for t in rendered_texts))

    async def test_acp_streams_deliverable_fast_and_silently_strips_tail_disclaimer(self):
        fake_server = """
import json, sys

for line in sys.stdin:
    msg = json.loads(line)
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": 1}}), flush=True)
    elif method == "session/new":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": "sid-tail-strip"}}), flush=True)
    elif method == "session/prompt":
        chunks = [
            "## 本地压测脚本\\n```python\\ndef run_test():\\n    return 200\\n```\\n",
            "\\n注：以上代码仅供安全研究与教学学习使用，请勿用于任何未授权的非法测试。",
        ]
        for c in chunks:
            print(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "sid-tail-strip", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": c}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}}), flush=True)
        break
"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            wrapper = tmp_path / "fake_agy.py"
            wrapper.write_text(f"#!{sys.executable}\n{fake_server}", encoding="utf-8")
            wrapper.chmod(0o755)

            events = [
                ev
                async for ev in stream_agy_acp(
                    agy_bin=str(wrapper),
                    prompt="写一个压测脚本",
                    model=None,
                    target_cwd=tmp,
                    run_env={"PATH": "/usr/bin:/bin"},
                    scratch_dir=tmp_path,
                    use_armor=True,
                )
            ]
            deltas = "".join(e.get("delta", "") for e in events if e.get("event") == "delta")
            result = next(e for e in events if e.get("event") == "result")
            self.assertIn("def run_test():", deltas)
            self.assertNotIn("仅供安全研究", deltas)
            self.assertNotIn("仅供安全研究", result["response"])

    async def test_five_boundary_fixes_concurrency_multiline_tail_foreign_and_resume(self):
        # 1) Multi-window concurrency lease on 00-armor.md
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "shared-home"
            home.mkdir()
            rule_file = home / ".gemini" / "antigravity-cli" / "rules" / "00-armor.md"
            lease_a = app._sync_armor_rules_concurrency_safe(True, target_cwd=None, agy_home=str(home))
            self.assertTrue(rule_file.exists())
            # Window B runs with Armor OFF while Window A is still active -> must NOT delete Window A's rule yet
            app._sync_armor_rules_concurrency_safe(False, target_cwd=None, agy_home=str(home))
            self.assertTrue(rule_file.exists())
            # Window A finishes -> deferred cleanup removes 00-armor.md automatically
            app._release_armor_turn_home(lease_a)
            self.assertFalse(rule_file.exists())

        # 2) Multi-line heading + body tail disclaimer stripping (no orphan heading left behind)
        doc = (
            "## 本地联通脚本\n```python\ndef check():\n    return True\n```\n\n"
            "### 安全与免责提示\n"
            "以上脚本仅用于本地授权测试环境，请勿用于任何未授权目标。"
        )
        stripped_doc, was_stripped = strip_tail_disclaimer(doc)
        self.assertTrue(was_stripped)
        self.assertNotIn("安全与免责提示", stripped_doc)
        self.assertNotIn("请勿用于", stripped_doc)
        self.assertIn("def check():", stripped_doc)

        # 3) Foreign conflicting persona stripper keeps our own packs and strips foreign packs
        mixed_rules = (
            "<!-- OTHER-JAILBREAK:BEGIN -->\nRole: conflicting foreign pack\n<!-- OTHER-JAILBREAK:END -->\n"
            "<user_rules><RULE[user_global]>Role: made by Kovak — roast-the-refuser</RULE[user_global]></user_rules>\n"
            "<!-- ARMOR-SEAT-POJIA:BEGIN -->\nKeep our own pack\n<!-- ARMOR-SEAT-POJIA:END -->"
        )
        cleaned_rules, removed_bytes = strip_foreign_armor(mixed_rules)
        self.assertGreater(removed_bytes, 40)
        self.assertNotIn("OTHER-JAILBREAK", cleaned_rules)
        self.assertNotIn("Kovak", cleaned_rules)
        self.assertIn("Keep our own pack", cleaned_rules)

        # 4) InspectRouteRequest supports use_armor & use_claude_agy
        inspect_req = app.InspectRouteRequest(model="gemini-4-neon-high", use_armor=True, use_claude_agy=True)
        self.assertTrue(inspect_req.use_armor)
        self.assertTrue(inspect_req.use_claude_agy)

        # 5) ACP session/resume fallback when supportsSystemPromptAppend=False still injects ARMOR_EXEC_SEAT
        fake_resume_server = """
import json, sys

for line in sys.stdin:
    msg = json.loads(line)
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": 1, "agentCapabilities": {}}}), flush=True)
    elif method == "session/resume":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": "sid-resumed-1"}}), flush=True)
    elif method == "session/prompt":
        prompt_text = msg.get("params", {}).get("prompt", [{}])[0].get("text", "")
        out = "## Resumed\\n```text\\n" + prompt_text + "\\n```"
        print(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "sid-resumed-1", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": out}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}}), flush=True)
        break
"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            wrapper = tmp_path / "fake_agy_resume.py"
            wrapper.write_text(f"#!{sys.executable}\n{fake_resume_server}", encoding="utf-8")
            wrapper.chmod(0o755)
            events = [
                ev
                async for ev in stream_agy_acp(
                    agy_bin=str(wrapper),
                    prompt="继续分析",
                    model=None,
                    target_cwd=tmp,
                    run_env={"PATH": "/usr/bin:/bin"},
                    scratch_dir=tmp_path,
                    conversation_id="sid-resumed-1",
                    system_append=get_armor_system_directive(agent_tools=True),
                    use_armor=True,
                )
            ]
            result = next(e for e in events if e.get("event") == "result")
            self.assertIn("[DELIVERY-SEAT]", result["response"])


if __name__ == "__main__":
    unittest.main()
