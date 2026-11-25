"""Unit tests for agy_fast_engine plugin integration, adaptation, and auto-update."""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agy_fast_engine as eng
import claude_agy


def _make_fake_plugin(tmp_path: Path, version: str = "0.3.1", extra_tool: str | None = None) -> Path:
    plugin_dir = tmp_path / "agy-fast"
    (plugin_dir / "dist").mkdir(parents=True)
    (plugin_dir / "rules").mkdir(parents=True)
    (plugin_dir / "plugin.json").write_text(
        json.dumps({"name": "agy-fast", "version": version}),
        encoding="utf-8",
    )
    tools = {
        "batch_search": {"eager": True},
        "apply_edits": {"eager": True},
        "read_slices": {"eager": True},
        "quick_outline": {"eager": True},
        "run_checks": {"eager": True},
    }
    if extra_tool:
        tools[extra_tool] = {"eager": True}
    (plugin_dir / "mcp_config.json").write_text(
        json.dumps(
            {
                "mcpServers": {
                    "fast": {
                        "command": "node",
                        "args": ["${PLUGIN_ROOT}/dist/mcp-server.mjs"],
                        "tools": tools,
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    (plugin_dir / "dist" / "mcp-server.mjs").write_text("// stub\n", encoding="utf-8")
    (plugin_dir / "dist" / "session-start.mjs").write_text("// stub\n", encoding="utf-8")
    (plugin_dir / "rules" / "AGENTS.md").write_text(
        "# agy-fast Rules\nUse `read_file` and `batch_search` from `<plugin>`.\n",
        encoding="utf-8",
    )
    return plugin_dir


class TestAgyFastEngine(unittest.TestCase):
    def test_dynamic_mcp_config_adaptation_picks_up_new_upstream_tools(self):
        with tempfile.TemporaryDirectory() as td:
            plugin_dir = _make_fake_plugin(Path(td), version="0.4.0", extra_tool="smart_diff")
            cfg = eng.get_agy_fast_mcp_config(plugin_dir)
            self.assertTrue(cfg["installed"])
            self.assertEqual(cfg["server_name"], "agy-fast_fast")
            self.assertIn("smart_diff", cfg["tools"])
            self.assertEqual(cfg["acp_mcp_servers"][0]["name"], "agy-fast_fast")
            self.assertIn(str(plugin_dir / "dist" / "mcp-server.mjs"), cfg["acp_mcp_servers"][0]["args"])
            acp_env = {item["name"]: item["value"] for item in cfg["acp_mcp_servers"][0]["env"]}
            self.assertEqual(acp_env["PLUGIN_ROOT"], str(plugin_dir))
            self.assertEqual(acp_env["AGY_FAST_AUTO_UPDATE"], "0")
            claude_env = cfg["claude_mcp_servers"]["agy-fast_fast"]["env"]
            self.assertEqual(claude_env["AGY_PLUGIN_ROOT"], str(plugin_dir))
            self.assertEqual(claude_env["AGY_FAST_AUTO_UPDATE"], "0")
            self.assertIn("mcp__agy-fast_fast__smart_diff", cfg["claude_allowed_tools"])
            self.assertIn("mcp__agy-fast_fast__*", cfg["claude_allowed_tools"])

    def test_system_directive_adapts_for_acp_and_claude_agy(self):
        with tempfile.TemporaryDirectory() as td:
            plugin_dir = _make_fake_plugin(Path(td), version="0.3.1")
            with patch.object(eng, "get_agy_fast_session_snapshot", return_value="[agy-fast startup snapshot] Workspace: /demo"):
                acp_dir = eng.get_agy_fast_system_directive(mode="acp", target_cwd="/demo", plugin_dir=plugin_dir)
                claude_dir = eng.get_agy_fast_system_directive(mode="claude_agy", target_cwd="/demo", plugin_dir=plugin_dir)

            self.assertIn("agy-fast (v0.3.1)", acp_dir)
            self.assertIn(str(plugin_dir), acp_dir)
            self.assertIn("`/demo`", acp_dir)
            self.assertIn("[agy-fast startup snapshot]", acp_dir)
            self.assertNotIn("Claude Code Tool Surface Adaptation", acp_dir)

            self.assertIn("Claude Code Tool Surface Adaptation", claude_dir)
            self.assertIn("`mcp__agy-fast_fast__batch_search`", claude_dir)
            self.assertIn("`read_file` -> `Read`", claude_dir)
            self.assertNotIn("toolSummary is NOT required", claude_dir)
            self.assertIn("Always include a brief `toolSummary`", claude_dir)
            self.assertIn("`/demo`", claude_dir)
            self.assertIn("[agy-fast startup snapshot]", claude_dir)

    def test_session_snapshot_reuses_cached_prefix_for_same_session(self):
        with tempfile.TemporaryDirectory() as td:
            plugin_dir = _make_fake_plugin(Path(td), version="0.3.1")
            (plugin_dir / "dist" / "session-start.mjs").write_text(
                'process.stdout.write(JSON.stringify({injectSteps:[{systemMessage:"[snapshot-fixed]"}]}));\n',
                encoding="utf-8",
            )
            calls = []
            orig_run = eng._run_cmd

            def counting_run(*args, **kwargs):
                calls.append(args)
                return orig_run(*args, **kwargs)

            with patch.object(eng, "_run_cmd", side_effect=counting_run):
                s1 = eng.get_agy_fast_session_snapshot(str(plugin_dir), plugin_dir, session_key="conv-cache-1")
                s2 = eng.get_agy_fast_session_snapshot(str(plugin_dir), plugin_dir, session_key="conv-cache-1")
            self.assertEqual(s1, "[snapshot-fixed]")
            self.assertEqual(s2, "[snapshot-fixed]")
            self.assertEqual(len(calls), 1)

    def test_check_update_does_not_regress_newer_local_semver(self):
        with tempfile.TemporaryDirectory() as td:
            plugin_dir = _make_fake_plugin(Path(td), version="0.4.0")
            with (
                patch.object(
                    eng,
                    "_fetch_github_latest_release",
                    return_value={"tag_name": "v0.3.1", "html_url": "https://github.com/INK-Q/agy-fast/releases/tag/v0.3.1"},
                ),
                patch.object(eng, "_fetch_remote_main_commit", return_value=None),
            ):
                checked = eng.check_agy_fast_update(plugin_dir)
            self.assertTrue(checked["ok"])
            self.assertFalse(checked["update_available"])
            self.assertEqual(checked["latest_version"], "0.4.0")

    def test_first_clone_failure_preserves_existing_state_config(self):
        with tempfile.TemporaryDirectory() as td:
            plugin_dir = _make_fake_plugin(Path(td), version="0.3.1")
            eng.set_agy_fast_config(auto_update_enabled=False, plugin_dir=plugin_dir)

            def fake_failed_clone(argv, **kwargs):
                import subprocess as sp
                return sp.CompletedProcess(argv, 1, stdout="", stderr="network unreachable")

            with patch.object(eng, "_run_cmd", side_effect=fake_failed_clone):
                res = eng.update_agy_fast_plugin(force=True, plugin_dir=plugin_dir)
            self.assertFalse(res["ok"])
            self.assertFalse(eng.get_agy_fast_status(plugin_dir)["auto_update_enabled"])

    def test_config_and_check_update_detects_newer_semver(self):
        with tempfile.TemporaryDirectory() as td:
            plugin_dir = _make_fake_plugin(Path(td), version="0.3.1")
            st = eng.set_agy_fast_config(auto_update_enabled=False, plugin_dir=plugin_dir)
            self.assertFalse(st["auto_update_enabled"])

            with (
                patch.object(
                    eng,
                    "_fetch_github_latest_release",
                    return_value={"tag_name": "v0.3.2", "html_url": "https://github.com/INK-Q/agy-fast/releases/tag/v0.3.2"},
                ),
                patch.object(eng, "_fetch_remote_main_commit", return_value="abcdef1234567890"),
            ):
                checked = eng.check_agy_fast_update(plugin_dir)
            self.assertTrue(checked["ok"])
            self.assertTrue(checked["update_available"])
            self.assertEqual(checked["latest_version"], "0.3.2")
            self.assertFalse(checked["auto_update_enabled"])

    def test_auto_update_skips_when_disabled(self):
        with tempfile.TemporaryDirectory() as td:
            plugin_dir = _make_fake_plugin(Path(td), version="0.3.1")
            eng.set_agy_fast_config(auto_update_enabled=False, plugin_dir=plugin_dir)
            res = eng.update_agy_fast_plugin(only_if_auto_enabled=True, plugin_dir=plugin_dir)
            self.assertTrue(res["ok"])
            self.assertTrue(res["skipped"])
            self.assertEqual(res["reason"], "auto_update_disabled")

    def test_claude_agy_sandbox_blocks_unsandboxed_agy_fast_shell_tools(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = root / "fake-repo"
            sdk_dir = repo / "node_modules" / "@anthropic-ai" / "claude-agent-sdk"
            sdk_dir.mkdir(parents=True)
            (repo / "package.json").write_text(json.dumps({"name": "fake-repo", "type": "module"}), encoding="utf-8")
            (sdk_dir / "package.json").write_text(
                json.dumps({"name": "@anthropic-ai/claude-agent-sdk", "type": "module", "exports": "./index.mjs"}),
                encoding="utf-8",
            )
            fake_magpie = root / "fake-magpie"
            fake_magpie.mkdir(parents=True)
            scratch = root / "scratch"
            scratch.mkdir()

            sdk_code = """
export function query({ options }) {
  return (async function* () {
    const runChecksDenied = options.canUseTool
      ? await options.canUseTool('mcp__agy-fast_fast__run_checks', { commands: [{ command: 'id' }] })
      : null;
    const verifyDenied = options.canUseTool
      ? await options.canUseTool('mcp__agy-fast_fast__apply_edits', { edits: [], verify: 'rm -rf /' })
      : null;
    const editAllowed = options.canUseTool
      ? await options.canUseTool('mcp__agy-fast_fast__apply_edits', { edits: [] })
      : null;
    const summary = JSON.stringify({
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools || [],
      runChecksBehavior: runChecksDenied?.behavior,
      verifyBehavior: verifyDenied?.behavior,
      editBehavior: editAllowed?.behavior,
    });
    yield {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu1', name: 'mcp__agy-fast_fast__apply_edits', input: { edits: '[{"path":"a.ts"},{"path":"b.ts"}]' } },
          { type: 'tool_use', id: 'tu2', name: 'mcp__agy-fast_fast__read_slices', input: { outlines: ['x.ts'], slices: [{ path: 'y.ts', ranges: [[1, 5]] }] } },
          { type: 'text', text: summary },
        ],
      },
    };
    yield { type: 'result', subtype: 'success', result: summary };
  })();
}
"""
            magpie_code = "export default { async server() { return { auth: { async loader() { return {}; } } }; } };\n"
            (sdk_dir / "index.mjs").write_text(sdk_code, encoding="utf-8")
            (fake_magpie / "index.mjs").write_text(magpie_code, encoding="utf-8")

            plugin_dir = _make_fake_plugin(root, version="0.3.1")
            cfg = eng.get_agy_fast_mcp_config(plugin_dir)

            async def _collect():
                orig_env_fn = claude_agy._worker_environment

                def wrapped_env(source, agy_bin, temporary):
                    w_env, c_home = orig_env_fn(source, agy_bin, temporary)
                    w_env["MINTCLI_REPO"] = str(repo)
                    w_env["MINTCLI_MAGPIE_AGY"] = str(fake_magpie)
                    w_env["MINTCLI_CLAUDE_PATH"] = "/bin/true"
                    return w_env, c_home

                out = []
                with patch.object(claude_agy, "_worker_environment", side_effect=wrapped_env):
                    async for ev in claude_agy.stream_claude_agy(
                        agy_bin="agy",
                        env=dict(os.environ),
                        cwd=str(root),
                        scratch=scratch,
                        prompt="check",
                        model="claude-sonnet-5-5",
                        turn_id="turn-sbx",
                        sandbox=True,
                        use_agy_fast=True,
                        agy_fast_mcp_servers=cfg["claude_mcp_servers"],
                        agy_fast_allowed_tools=cfg["claude_allowed_tools"],
                    ):
                        out.append(ev)
                return out

            events = asyncio.run(_collect())
            tool_labels = [e.get("tool") for e in events if e.get("event") == "tool"]
            self.assertIn("agy-fast:apply_edits (2 files)", tool_labels)
            self.assertIn("agy-fast:read_slices (1 outlines, 1 slices)", tool_labels)
            res_ev = next(e for e in events if e.get("event") == "result")
            report = json.loads(res_ev["response"])
            self.assertNotIn("mcp__agy-fast_fast__*", report["allowedTools"])
            self.assertNotIn("mcp__agy-fast_fast__run_checks", report["allowedTools"])
            self.assertIn("mcp__agy-fast_fast__batch_search", report["allowedTools"])
            self.assertIn("mcp__agy-fast_fast__run_checks", report["disallowedTools"])
            self.assertEqual(report["runChecksBehavior"], "deny")
            self.assertEqual(report["verifyBehavior"], "deny")
            self.assertEqual(report["editBehavior"], "allow")

    def test_real_installed_agy_fast_smoke(self):
        real_dir = eng.get_agy_fast_dir()
        if not (real_dir / "plugin.json").is_file():
            self.skipTest("agy-fast not installed at default dir")
        res = eng.smoke_test_agy_fast(real_dir)
        self.assertTrue(res["ok"])
        self.assertTrue(set(eng.DEFAULT_TOOLS).issubset(set(res["tools"])))


if __name__ == "__main__":
    unittest.main()
