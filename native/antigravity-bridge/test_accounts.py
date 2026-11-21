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


if __name__ == "__main__":
    unittest.main()
