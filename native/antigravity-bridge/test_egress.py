"""Routing regressions without touching accounts or sending model requests."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from egress import egress_environment
from agy_client_profile import DesktopProfileProxy


class EgressTests(unittest.TestCase):
    def test_independent_routing_and_explicit_direct(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"MINTCLI_EGRESS_ROOT": directory}):
            root = Path(directory)
            (root / "inventory.json").write_text(json.dumps({"nodes": [{"id": "tokyo", "port": 18080}]}))
            source = {"HTTPS_PROXY": "http://old:1", "all_proxy": "http://old:1", "HOME": "/keep"}
            (root / "selection.json").write_text(json.dumps({"selections": {"codex": "direct", "antigravity": "tokyo"}}))
            self.assertEqual(egress_environment(source)["HTTPS_PROXY"], "http://127.0.0.1:18080")
            (root / "selection.json").write_text(json.dumps({"selections": {"antigravity": "direct"}}))
            direct = egress_environment(source)
            self.assertNotIn("HTTPS_PROXY", direct)
            self.assertNotIn("all_proxy", direct)
            self.assertEqual(direct["HOME"], "/keep")
            self.assertEqual(source["HTTPS_PROXY"], "http://old:1")
            (root / "selection.json").write_text(json.dumps({"selections": {"antigravity": "removed"}}))
            with self.assertRaises(RuntimeError):
                egress_environment(source)

    def test_desktop_profile_captures_explicit_proxy_and_direct(self):
        for selected in ("", "http://127.0.0.1:18080"):
            profile = DesktopProfileProxy(proxy_url=selected)
            try:
                with patch.dict(os.environ, {"HTTPS_PROXY": "http://old:1", "https_proxy": "http://old:1"}):
                    connection = profile.upstream_connection()
                    self.assertEqual(connection.host, "daily-cloudcode-pa.googleapis.com" if not selected else "127.0.0.1")
                    connection.close()
            finally:
                profile.close()


if __name__ == '__main__':
    unittest.main()
