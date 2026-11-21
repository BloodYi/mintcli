"""Regression checks using real, isolated fake CLI processes; no model requests."""
from __future__ import annotations

import asyncio
import os
import signal
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
import app
import acp_client


class CliLifecycleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mintcli-lifecycle-test-")
        self.root = Path(self.temp.name)
        self.pid_log = self.root / "pids"
        self.wrapper = self.root / "fake-agy"
        self.patches = [
            patch.object(app, "AGY_BIN", str(self.wrapper)),
            patch.object(app, "SCRATCH", self.root),
            patch.object(app, "ACTIVE_TOKEN_FILE", self.root / "missing-token"),
            patch.object(app, "_quota_cache", {"data": None, "timestamp": 0.0, "retry_at": 0.0}),
            patch.object(app, "_quota_lock", asyncio.Lock()),
            patch.object(app, "QUOTA_TIMEOUT_SECONDS", 0.2, create=True),
            patch.object(acp_client, "ACP_SETUP_TIMEOUT_SECONDS", 0.15, create=True),
            patch.object(app, "_agy_environment", lambda: dict(os.environ)),
            patch.dict(os.environ, {"FAKE_PID_LOG": str(self.pid_log)}),
        ]
        for item in self.patches:
            item.start()

    async def asyncTearDown(self):
        # Also clean up when this suite is deliberately run against the old code.
        for pid in self.pids():
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        await asyncio.sleep(0.05)
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def fake(self, body):
        prefix = f"#!{sys.executable}\nimport os, sys, time, signal, json\n"
        prefix += "with open(os.environ['FAKE_PID_LOG'], 'a') as f: f.write(str(os.getpid())+'\\n')\n"
        self.wrapper.write_text(prefix + body)
        self.wrapper.chmod(0o755)

    def pids(self):
        return [int(x) for x in self.pid_log.read_text().split()] if self.pid_log.exists() else []

    async def wait_pids(self, count):
        deadline = time.monotonic() + 2
        while len(self.pids()) < count and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        self.assertEqual(len(self.pids()), count)

    def assert_stopped(self, pids):
        for pid in pids:
            stat = Path(f"/proc/{pid}/stat")
            self.assertTrue(not stat.exists() or stat.read_text().split(") ", 1)[1].startswith("Z"),
                            f"CLI process {pid} was left running")

    async def quota(self):
        return await asyncio.wait_for(app._fetch_quota_from_agy(), timeout=4)

    async def test_quota_timeout_reaps_both_and_backs_off(self):
        self.fake("signal.signal(signal.SIGTERM, signal.SIG_IGN)\ntime.sleep(60)\n")
        original_wait = asyncio.wait_for

        async def short_legacy_timeout(awaitable, timeout):
            return await original_wait(awaitable, 0.2 if timeout == 25.0 else timeout)

        with patch.object(asyncio, "wait_for", short_legacy_timeout):
            with self.assertRaises(HTTPException) as raised:
                await self.quota()
        self.assertEqual(raised.exception.status_code, 504)
        self.assertEqual(len(self.pids()), 2)
        self.assert_stopped(self.pids())
        with self.assertRaises(HTTPException) as cached:
            await app._fetch_quota_from_agy(force=True)
        self.assertIn("Retry-After", cached.exception.headers)
        self.assertEqual(len(self.pids()), 2)

    async def test_quota_cancellation_reaps_both(self):
        self.fake("signal.signal(signal.SIGTERM, signal.SIG_IGN)\ntime.sleep(60)\n")
        with patch.object(app, "QUOTA_TIMEOUT_SECONDS", 10, create=True):
            task = asyncio.create_task(app._fetch_quota_from_agy())
            await self.wait_pids(2)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assert_stopped(self.pids())

    async def test_partial_spawn_failure_reaps_started_cli(self):
        self.fake("signal.signal(signal.SIGTERM, signal.SIG_IGN)\ntime.sleep(60)\n")
        original_spawn = asyncio.create_subprocess_exec
        started = []

        async def spawn(*args, **kwargs):
            if started:
                raise OSError("injected second spawn failure")
            proc = await original_spawn(*args, **kwargs)
            started.append(proc)
            await self.wait_pids(1)
            return proc

        with patch.object(asyncio, "create_subprocess_exec", spawn):
            with self.assertRaises(HTTPException) as raised:
                await self.quota()
        self.assertEqual(raised.exception.status_code, 500)
        self.assert_stopped(self.pids())

    async def test_quota_success_and_account_cache_reset(self):
        self.fake("if '-p=/usage' in sys.argv:\n print('Gemini 4 Argon\\tWeekly Limit Remaining\\t90%\\tTomorrow')\nelse:\n print('Remaining credits 7')\n")
        app._quota_cache.update(retry_at=time.monotonic() + 60, error_status=504)
        app._clear_quota_cache()
        result = await self.quota()
        self.assertEqual(result["credits"], 7)
        self.assertEqual(result["quotas"][0]["percentage"], 90)
        self.assertEqual(len(self.pids()), 2)
        cached = await self.quota()
        self.assertTrue(cached["cached"])
        self.assertEqual(len(self.pids()), 2)

    async def collect_acp(self):
        return [event async for event in acp_client.stream_agy_acp(
            agy_bin=str(self.wrapper), prompt="test", model=None,
            target_cwd=str(self.root), run_env=dict(os.environ), scratch_dir=self.root,
            persist_conversation=False,
        )]

    async def test_acp_setup_has_deadline_with_unlimited_turn(self):
        self.fake("for line in sys.stdin:\n time.sleep(60)\n")
        events = await asyncio.wait_for(self.collect_acp(), timeout=3)
        error = next(event["error"] for event in events if event["event"] == "error")
        self.assertIn("initialize timed out", error)
        self.assertNotIn("after 0s", error)
        self.assert_stopped(self.pids())

    async def test_acp_replies_method_not_found_to_unsupported_requests(self):
        self.fake("""
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); mid=m.get('id')
 if method=='initialize':
  print(json.dumps({'jsonrpc':'2.0','id':900,'method':'fs/read_text_file','params':{}}),flush=True)
  answer=json.loads(sys.stdin.readline())
  if answer.get('error',{}).get('code')!=-32601: sys.exit(3)
  print(json.dumps({'jsonrpc':'2.0','id':mid,'result':{'protocolVersion':1}}),flush=True)
 elif method=='session/new':
  print(json.dumps({'jsonrpc':'2.0','id':mid,'result':{'sessionId':'fake-session'}}),flush=True)
 elif method=='session/prompt':
  print(json.dumps({'jsonrpc':'2.0','id':mid,'result':{'stopReason':'end_turn'}}),flush=True)
  break
""")
        events = await asyncio.wait_for(self.collect_acp(), timeout=3)
        self.assertTrue(any(event["event"] == "result" for event in events))
        self.assert_stopped(self.pids())

    async def test_acp_accepts_stream_chunks_over_64k(self):
        self.fake("""
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); mid=m.get('id')
 if method=='initialize': result={'protocolVersion':1}
 elif method=='session/new': result={'sessionId':'fake-session'}
 elif method=='session/prompt':
  print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'fake-session','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'x'*100000}}}}),flush=True)
  result={'stopReason':'end_turn'}
 else: continue
 print(json.dumps({'jsonrpc':'2.0','id':mid,'result':result}),flush=True)
 if method=='session/prompt': break
""")
        events = await asyncio.wait_for(self.collect_acp(), timeout=3)
        self.assertEqual(len(next(event["response"] for event in events if event["event"] == "result")), 100000)

    async def test_acp_generator_close_reaps_descendants(self):
        self.fake("""
import subprocess
child=subprocess.Popen([sys.executable,'-c',"import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)"])
with open(os.environ['FAKE_PID_LOG'],'a') as f:f.write(str(child.pid)+'\\n')
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); mid=m.get('id')
 if method=='initialize': result={'protocolVersion':1}
 elif method=='session/new': result={'sessionId':'fake-session'}
 else: continue
 print(json.dumps({'jsonrpc':'2.0','id':mid,'result':result}),flush=True)
""")
        stream = acp_client.stream_agy_acp(
            agy_bin=str(self.wrapper), prompt="test", model=None,
            target_cwd=str(self.root), run_env=dict(os.environ), scratch_dir=self.root,
            persist_conversation=False,
        )
        self.assertEqual((await asyncio.wait_for(anext(stream), 3))["event"], "init")
        await self.wait_pids(2)
        await asyncio.wait_for(stream.aclose(), 3)
        self.assert_stopped(self.pids())


if __name__ == "__main__":
    unittest.main()
