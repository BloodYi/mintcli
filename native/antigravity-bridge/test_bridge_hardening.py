"""Regression tests for Antigravity bridge security, Unicode downloads, and streaming perf."""
from __future__ import annotations

import asyncio
import base64
import json
import tempfile
import time
import unittest
import urllib.parse
from pathlib import Path
from unittest.mock import patch

import app
import detached_chat


async def _asgi_call(
    asgi_app,
    method: str,
    path: str,
    *,
    query: dict[str, str] | None = None,
    headers: dict[str, str] | None = None,
    json_body: dict | None = None,
) -> tuple[int, dict[str, str], bytes]:
    raw_body = json.dumps(json_body).encode("utf-8") if json_body is not None else b""
    req_headers: list[tuple[bytes, bytes]] = [(b"host", b"127.0.0.1:3131")]
    if json_body is not None:
        req_headers.append((b"content-type", b"application/json"))
        req_headers.append((b"content-length", str(len(raw_body)).encode("ascii")))
    for k, v in (headers or {}).items():
        req_headers.append((k.lower().encode("latin-1"), v.encode("latin-1")))

    query_string = urllib.parse.urlencode(query or {}).encode("ascii")
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method.upper(),
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("utf-8"),
        "query_string": query_string,
        "headers": req_headers,
        "client": ("127.0.0.1", 54321),
        "server": ("127.0.0.1", 3131),
    }

    sent = False

    async def receive():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": raw_body, "more_body": False}
        return {"type": "http.disconnect"}

    status_code = 500
    resp_headers: dict[str, str] = {}
    chunks: list[bytes] = []

    async def send(message):
        nonlocal status_code
        if message["type"] == "http.response.start":
            status_code = message["status"]
            for hk, hv in message.get("headers", []):
                # Verify ASGI header bytes are valid latin-1 just like Uvicorn enforces.
                key_s = hk.decode("latin-1").lower()
                val_s = hv.decode("latin-1")
                resp_headers[key_s] = val_s
        elif message["type"] == "http.response.body":
            chunks.append(message.get("body", b""))

    await asgi_app(scope, receive, send)
    return status_code, resp_headers, b"".join(chunks)


class BridgeHardeningTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mintcli-bridge-hardening-")
        self.root = Path(self.temp.name)
        self.uploads = self.root / "uploads"
        self.scratch = self.root / "scratch"
        self.uploads.mkdir(parents=True, exist_ok=True)
        self.scratch.mkdir(parents=True, exist_ok=True)
        self.patches = [
            patch.object(app, "UPLOADS", self.uploads),
            patch.object(app, "SCRATCH", self.scratch),
            patch.object(app, "ALLOWED_ROOTS", [str(self.root.resolve()), str(self.uploads.resolve())]),
            patch.object(app, "_sessions", {}),
            patch.object(app, "_login_failures", {}),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    async def test_download_non_ascii_chinese_filename_returns_200(self):
        target = self.scratch / "测试报告_🚀_v1.pdf"
        target.write_bytes(b"%PDF-1.4 fake content")
        with patch.object(app, "_AUTH_ENABLED", False):
            status, headers, body = await _asgi_call(
                app.app, "GET", "/api/download", query={"path": str(target)}
            )
            self.assertEqual(status, 200)
            self.assertEqual(body, b"%PDF-1.4 fake content")
            self.assertIn("filename*=UTF-8''", headers.get("content-disposition", ""))
            self.assertEqual(headers.get("x-content-type-options"), "nosniff")

    async def test_download_blocks_sensitive_credentials_and_dotfiles(self):
        ssh_dir = self.root / ".ssh"
        ssh_dir.mkdir()
        ssh_key = ssh_dir / "id_rsa"
        ssh_key.write_text("PRIVATE KEY")

        cloudcli_dir = self.root / ".cloudcli"
        cloudcli_dir.mkdir()
        auth_db = cloudcli_dir / "auth.db"
        auth_db.write_text("sqlite secret")
        safe_asset = cloudcli_dir / "assets" / "photo.png"
        safe_asset.parent.mkdir()
        safe_asset.write_bytes(b"PNGDATA")

        env_file = self.root / ".agychat.env"
        env_file.write_text("BASIC_AUTH_PASS=secret")

        with patch.object(app, "_AUTH_ENABLED", False):
            for forbidden in (ssh_key, auth_db, env_file):
                status, _, _ = await _asgi_call(
                    app.app, "GET", "/api/download", query={"path": str(forbidden)}
                )
                self.assertEqual(status, 403, f"Expected 403 for {forbidden}")

            ok_status, _, ok_body = await _asgi_call(
                app.app, "GET", "/api/download", query={"path": str(safe_asset)}
            )
            self.assertEqual(ok_status, 200)
            self.assertEqual(ok_body, b"PNGDATA")

    async def test_uploads_require_auth_and_sandbox_active_documents(self):
        svg_file = self.uploads / "xss.svg"
        svg_file.write_text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
        png_file = self.uploads / "safe.png"
        png_file.write_bytes(b"\x89PNG\r\n\x1a\n")

        with (
            patch.object(app, "_AUTH_ENABLED", True),
            patch.object(app, "BASIC_AUTH_USER", "admin"),
            patch.object(app, "BASIC_AUTH_PASS", "pass123"),
        ):
            unauth_status, _, _ = await _asgi_call(app.app, "GET", "/uploads/xss.svg")
            self.assertIn(unauth_status, (302, 401))

            login_status, login_headers, _ = await _asgi_call(
                app.app, "POST", "/api/login", json_body={"username": "admin", "password": "pass123"}
            )
            self.assertEqual(login_status, 200)
            set_cookie_http = login_headers.get("set-cookie", "")
            self.assertNotIn("Secure", set_cookie_http)
            cookie_pair = set_cookie_http.split(";", 1)[0]

            _, https_headers, _ = await _asgi_call(
                app.app,
                "POST",
                "/api/login",
                headers={"x-forwarded-proto": "https"},
                json_body={"username": "admin", "password": "pass123"},
            )
            self.assertIn("Secure", https_headers.get("set-cookie", ""))

            svg_status, svg_headers, _ = await _asgi_call(
                app.app, "GET", "/uploads/xss.svg", headers={"cookie": cookie_pair}
            )
            self.assertEqual(svg_status, 200)
            self.assertEqual(svg_headers.get("x-content-type-options"), "nosniff")
            self.assertIn("sandbox", svg_headers.get("content-security-policy", ""))
            self.assertIn("attachment", svg_headers.get("content-disposition", ""))

            png_status, png_headers, _ = await _asgi_call(
                app.app, "GET", "/uploads/safe.png", headers={"cookie": cookie_pair}
            )
            self.assertEqual(png_status, 200)
            self.assertNotIn("attachment", png_headers.get("content-disposition", ""))

    async def test_login_rate_limiting_and_upload_size_limit(self):
        with (
            patch.object(app, "_AUTH_ENABLED", True),
            patch.object(app, "BASIC_AUTH_USER", "admin"),
            patch.object(app, "BASIC_AUTH_PASS", "pass123"),
            patch.object(app, "_LOGIN_MAX_FAILURES", 3),
        ):
            for _ in range(3):
                st, _, _ = await _asgi_call(
                    app.app, "POST", "/api/login", json_body={"username": "admin", "password": "wrong"}
                )
                self.assertEqual(st, 401)
            blocked_st, blocked_headers, _ = await _asgi_call(
                app.app, "POST", "/api/login", json_body={"username": "admin", "password": "wrong"}
            )
            self.assertEqual(blocked_st, 429)
            self.assertIn("retry-after", blocked_headers)

        with (
            patch.object(app, "_AUTH_ENABLED", False),
            patch.object(app, "MAX_UPLOAD_BYTES", 1024),
        ):
            big_b64 = base64.b64encode(b"x" * 2048).decode("ascii")
            up_st, _, _ = await _asgi_call(
                app.app, "POST", "/api/upload", json_body={"filename": "big.bin", "data": big_b64}
            )
            self.assertEqual(up_st, 413)

    def test_extract_correctness_and_linear_speed(self):
        sample = (
            "<think>\nPlanning step 1\n</think>\n"
            "Here is literal `<think>inline</think>` and fenced:\n"
            "```xml\n<think>inside fence</think>\n```\n"
            "> ```\n> <think>quoted fence</think>\n> ```\n"
            "Final paragraph."
        )
        parsed = detached_chat._extract(sample, streaming=False)
        self.assertEqual(parsed["thinking"], "Planning step 1")
        self.assertIn("`<think>inline</think>`", parsed["content"])
        self.assertIn("<think>inside fence</think>", parsed["content"])
        self.assertIn("<think>quoted fence</think>", parsed["content"])

        streaming_partial = detached_chat._extract("Hello world <thi", streaming=True)
        self.assertEqual(streaming_partial["content"], "Hello world ")

        large_text = "<think>thought</think>\n" + ("Plain markdown line with `code` and text.\n" * 2000)
        start = time.perf_counter()
        res = detached_chat._extract(large_text, streaming=True)
        elapsed = time.perf_counter() - start
        self.assertEqual(res["thinking"], "thought")
        self.assertLess(elapsed, 0.25)

    async def test_web_turn_flushes_background_save_before_completion(self):
        messages_dir = self.root / "messages"
        messages_dir.mkdir(parents=True, exist_ok=True)
        manager = detached_chat.TurnManager(messages_dir, app.logger)

        async def fake_stream():
            yield {"event": "init", "conversation_id": "conv_async_1"}
            yield {"event": "delta", "delta": "<think>step</think>Hello async world!"}
            yield {"event": "result", "response": "<think>step</think>Hello async world!"}

        turn = manager.start(fake_stream, "conv_async_1", [{"role": "user", "content": "hi"}], "default", "Default")
        await turn.task
        saved_file = messages_dir / "conv_async_1.json"
        self.assertTrue(saved_file.exists())
        content = saved_file.read_text(encoding="utf-8")
        self.assertIn("Hello async world!", content)
        await manager.shutdown(drain_timeout=1.0)


if __name__ == "__main__":
    unittest.main()
