import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app


class ApiConnectionTests(unittest.TestCase):
    def test_child_environment_pins_api_key_and_replaces_stale_proxy(self):
        api = app.ApiConnection(base_url="http://127.0.0.1:12345", api_key="private-api-key", proxy_port=0)
        source = {"HTTPS_PROXY": "http://old-proxy", "http_proxy": "http://old-proxy", "GOOGLE_API_KEY": "wrong-key", "AGY_ADC_AUTH": "true", "OTHER_SETTING": "kept"}
        env = app._api_environment(source, api)
        self.assertNotIn("HTTPS_PROXY", env)
        self.assertNotIn("http_proxy", env)
        self.assertNotIn("GOOGLE_API_KEY", env)
        self.assertNotIn("AGY_ADC_AUTH", env)
        self.assertEqual(env["GEMINI_API_KEY"], "private-api-key")
        self.assertEqual(env["GOOGLE_GEMINI_BASE_URL"], "http://127.0.0.1:12345")
        self.assertEqual(env["OTHER_SETTING"], "kept")
        self.assertEqual(source["GOOGLE_API_KEY"], "wrong-key")
        self.assertNotIn("private-api-key", repr(api))

    def test_chat_conversion_uses_transient_cli_settings_and_keeps_credentials_out_of_argv(self):
        async def check():
            captured = {}

            async def spawn(*args, **kwargs):
                captured.update(args=args, env=kwargs["env"])
                raise RuntimeError("stop before spawning")

            with tempfile.TemporaryDirectory() as directory:
                api = app.ApiConnection(base_url="http://127.0.0.1:12345", api_key="private-api-key", chat_compat=True)
                with patch.object(app, "SCRATCH", Path(directory)), patch.object(app, "_agy_environment", return_value={}), patch.object(app.asyncio, "create_subprocess_exec", side_effect=spawn):
                    with self.assertRaisesRegex(RuntimeError, "stop before spawning"):
                        async for _event in app._stream_agy("prompt", "custom-chat-model", api_connection=api):
                            pass
                args = captured["args"]
                self.assertEqual(args[args.index("--model") + 1], "gemini-3.1-pro")
                self.assertEqual(json.loads(args[args.index("--settings") + 1]), {"modelProvider": "gemini"})
                self.assertNotIn("private-api-key", json.dumps(args))
                self.assertEqual(captured["env"]["GEMINI_API_KEY"], "private-api-key")

        asyncio.run(check())

    def test_turn_redacts_before_persistence_and_does_not_serialize_api_configuration(self):
        async def check():
            captured = {}
            secret = "private-api-key"

            async def resolve(_req):
                return "prompt", None, False, "default"

            async def upstream(**_kwargs):
                yield {"event": "delta", "delta": "echo " + secret}
                raise RuntimeError("failure with " + secret)

            def start(factory, *args):
                captured.update(factory=factory, saved=args)
                return "test-turn"

            request = app.ChatRequest(messages=[app.Message(role="user", content="prompt")], model="custom-model", api_connection=app.ApiConnection(base_url="http://127.0.0.1", api_key=secret, chat_compat=True))
            with patch.object(app, "_resolve_prompt_and_session", side_effect=resolve), patch.object(app, "_stream_agy", side_effect=upstream), patch.object(app.web_turns, "start", side_effect=start), patch.object(app, "_turn_response", return_value="response"):
                self.assertEqual(await app.chat(request), "response")
                self.assertNotIn(secret, json.dumps(captured["saved"]))
                self.assertNotIn("api_connection", json.dumps(captured["saved"]))
                events = []
                with self.assertRaisesRegex(RuntimeError, "连接或返回格式异常"):
                    async for event in captured["factory"]():
                        events.append(event)
                self.assertNotIn(secret, json.dumps(events))
                self.assertIn("密钥已隐藏", events[0]["delta"])

        asyncio.run(check())


if __name__ == "__main__":
    unittest.main()
