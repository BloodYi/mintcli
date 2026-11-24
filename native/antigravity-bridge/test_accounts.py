import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

import app


class AccountStorageTests(unittest.TestCase):
    def test_sync_and_list_ignore_null_or_empty_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            accounts_dir = root / "accounts"
            accounts_dir.mkdir()
            active_file = root / "antigravity-oauth-token"
            active_file.write_text(json.dumps({"token": None}))
            (accounts_dir / "account_74234e98afe7.json").write_text(json.dumps({"token": None}))
            (accounts_dir / "empty_dict.json").write_text(json.dumps({"token": {}}))
            (accounts_dir / "valid@example.com.json").write_text(
                json.dumps({
                    "auth_method": "oauth",
                    "id_token_email": "valid@example.com",
                    "token": {"access_token": "tok-1", "refresh_token": "ref-1"},
                })
            )

            with patch.object(app, "ACCOUNTS_DIR", accounts_dir), patch.object(app, "ACTIVE_TOKEN_FILE", active_file):
                app._sync_active_account_to_storage()
                # Must not create another placeholder file from the null active token.
                self.assertEqual(
                    sorted(p.name for p in accounts_dir.glob("*.json")),
                    ["account_74234e98afe7.json", "empty_dict.json", "valid@example.com.json"],
                )
                accounts = app._list_stored_accounts()
                self.assertEqual(len(accounts), 1)
                self.assertEqual(accounts[0]["email"], "valid@example.com")
                self.assertFalse(accounts[0]["active"])

                with self.assertRaises(HTTPException) as ctx:
                    app._switch_to_account("account_74234e98afe7")
                self.assertEqual(ctx.exception.status_code, 400)

    def test_save_new_account_rejects_empty_token_payloads(self):
        with tempfile.TemporaryDirectory() as directory:
            accounts_dir = Path(directory) / "accounts"
            accounts_dir.mkdir()
            with patch.object(app, "ACCOUNTS_DIR", accounts_dir):
                for bad in ({"token": None}, {"token": ""}, {"token": {}}, {"token": {"access_token": ""}}):
                    with self.assertRaises(HTTPException) as ctx:
                        app._save_new_account(bad)
                    self.assertEqual(ctx.exception.status_code, 400)

    def test_switch_account_allowed_while_another_turn_is_running_with_isolated_homes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_home = root / "home"
            cli_dir = source_home / ".gemini" / "antigravity-cli"
            accounts_dir = cli_dir / "accounts"
            accounts_dir.mkdir(parents=True)
            active_file = cli_dir / "antigravity-oauth-token"
            scratch = root / "scratch"
            scratch.mkdir()

            token_a = {
                "auth_method": "oauth",
                "id_token_email": "alice@example.com",
                "token": {"access_token": "tok-a", "refresh_token": "ref-a"},
            }
            token_b = {
                "auth_method": "oauth",
                "id_token_email": "bob@example.com",
                "token": {"access_token": "tok-b", "refresh_token": "ref-b"},
            }
            (accounts_dir / "alice@example.com.json").write_text(json.dumps(token_a))
            (accounts_dir / "bob@example.com.json").write_text(json.dumps(token_b))
            active_file.write_text(json.dumps(token_a))

            class DummyTurn:
                status = "running"

            with (
                patch.object(app, "HOME", str(source_home)),
                patch.object(app, "SCRATCH", scratch),
                patch.object(app, "ACCOUNTS_DIR", accounts_dir),
                patch.object(app, "ACTIVE_TOKEN_FILE", active_file),
                patch.dict(app.web_turns.turns, {"running-turn": DummyTurn()}, clear=False),
                patch.dict(app._active_account_turns, {"alice@example.com": 1}, clear=True),
            ):
                env_a = app._agy_environment(account_id="alice@example.com")
                home_a = Path(env_a["HOME"])
                token_file_a = home_a / ".gemini" / "antigravity-cli" / "antigravity-oauth-token"
                self.assertTrue(token_file_a.is_file())
                self.assertFalse(token_file_a.is_symlink())
                self.assertEqual(json.loads(token_file_a.read_text())["token"]["access_token"], "tok-a")
                self.assertTrue((home_a / ".gemini" / "antigravity-cli" / "conversations").is_symlink())

                # Switching to account B must succeed even while account A has a running turn.
                result = app._switch_to_account("bob@example.com")
                self.assertTrue(result["ok"])
                self.assertEqual(result["active_account"], "bob@example.com")

                # Account A's isolated token must remain untouched after switching to B.
                self.assertEqual(json.loads(token_file_a.read_text())["token"]["access_token"], "tok-a")

                # Account B gets its own separate isolated HOME with its own token.
                env_b = app._agy_environment(account_id="bob@example.com")
                home_b = Path(env_b["HOME"])
                self.assertNotEqual(home_a, home_b)
                token_file_b = home_b / ".gemini" / "antigravity-cli" / "antigravity-oauth-token"
                self.assertEqual(json.loads(token_file_b.read_text())["token"]["access_token"], "tok-b")

                # Deleting account A while its turn is still active must be rejected.
                with self.assertRaises(HTTPException) as ctx:
                    app._delete_stored_account("alice@example.com")
                self.assertEqual(ctx.exception.status_code, 409)

                # Simulating a token refresh inside A's isolated home syncs back to A's stored file
                # without clobbering B's active token file.
                refreshed_a = {
                    **token_a,
                    "token": {"access_token": "tok-a-refreshed", "refresh_token": "ref-a"},
                }
                token_file_a.write_text(json.dumps(refreshed_a))
                app._sync_account_home_token_to_storage("alice@example.com")
                self.assertEqual(
                    json.loads((accounts_dir / "alice@example.com.json").read_text())["token"]["access_token"],
                    "tok-a-refreshed",
                )
                self.assertEqual(json.loads(active_file.read_text())["token"]["access_token"], "tok-b")

    def test_antigravity_tier_classification_and_cache(self):
        self.assertEqual(
            app._classify_antigravity_tier(
                {"currentTier": {"id": "free-tier"}, "paidTier": {"id": "g1-ultra-tier", "name": "Google AI Ultra"}}
            ),
            "Ultra 20x",
        )
        self.assertEqual(
            app._classify_antigravity_tier(
                {"currentTier": {"id": "free-tier"}, "paidTier": {"id": "g1-ultra-lite-tier", "name": "Google AI Ultra Lite"}}
            ),
            "Ultra 5x",
        )
        self.assertEqual(
            app._classify_antigravity_tier(
                {"currentTier": {"id": "free-tier"}, "paidTier": {"id": "ws-ai-ultra-business-tier"}}
            ),
            "Ultra Business",
        )
        self.assertEqual(
            app._classify_antigravity_tier(
                {"currentTier": {"id": "free-tier"}, "paidTier": {"id": "g1-plus-tier", "name": "Google AI Plus"}}
            ),
            "Plus",
        )
        self.assertEqual(
            app._classify_antigravity_tier(
                {"currentTier": {"id": "free-tier"}, "paidTier": {"id": "g1-pro-tier", "name": "Google AI Pro"}},
                {"models": {"claude-opus-5-5-high": {}, "claude-sonnet-5-5-medium": {}, "gemini-3.8-flash-tiered": {}}},
            ),
            "PaidPro",
        )
        self.assertEqual(
            app._classify_antigravity_tier(
                {"currentTier": {"id": "free-tier"}, "paidTier": {"id": "g1-pro-tier", "name": "Google AI Pro"}},
                {"models": {"claude-opus-4-6-thinking": {}, "claude-sonnet-4-6": {}, "gemini-3.8-flash-tiered": {}}},
            ),
            "FreePro",
        )
        self.assertEqual(
            app._classify_antigravity_tier(
                {"currentTier": {"id": "free-tier"}, "paidTier": {"id": "g1-pro-tier", "name": "Google AI Pro"}},
                None,
            ),
            "Pro",
        )
        self.assertEqual(
            app._classify_antigravity_tier({"currentTier": {"id": "free-tier", "name": "Antigravity"}}),
            "Free",
        )
        self.assertEqual(
            app._classify_antigravity_tier({"currentTier": {"id": "standard-tier", "name": "Antigravity"}}),
            "Standard",
        )
        self.assertEqual(
            app._resolve_cached_tier({"tier": "Ultra", "paid_tier_id": "g1-ultra-tier"}),
            "Ultra 20x",
        )
        self.assertEqual(
            app._resolve_cached_tier({"tier": "Ultra", "paid_tier_id": "g1-ultra-lite-tier"}),
            "Ultra 5x",
        )

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            accounts_dir = root / "accounts"
            accounts_dir.mkdir()
            active_file = root / "antigravity-oauth-token"
            token_a = {
                "token": {"access_token": "tok-a", "refresh_token": "ref-a"},
                "id_token_email": "alice@example.com",
            }
            (accounts_dir / "alice@example.com.json").write_text(json.dumps(token_a))
            active_file.write_text(json.dumps(token_a))

            with patch.object(app, "ACCOUNTS_DIR", accounts_dir), patch.object(
                app, "ACTIVE_TOKEN_FILE", active_file
            ):
                app._save_tier_cache_entry("alice@example.com", {"tier": "PaidPro", "checked_at": 1700000000})
                listed = app._list_stored_accounts()
                self.assertEqual(len(listed), 1)
                self.assertEqual(listed[0]["subscription_tier"], "PaidPro")
                app._remove_tier_cache_entry("alice@example.com")
                self.assertIsNone(app._list_stored_accounts()[0]["subscription_tier"])


if __name__ == "__main__":
    unittest.main()
