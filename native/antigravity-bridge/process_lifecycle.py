"""Bounded cleanup for CLI subprocesses started in their own process session."""
from __future__ import annotations

import asyncio
import logging
import os
import signal

logger = logging.getLogger("antigravity-chat.process")


async def reap_cli_process(proc: asyncio.subprocess.Process | None, grace: float = 1.0) -> None:
    """Stop an owned CLI session, including children that keep its pipes open.

    POSIX callers must spawn with ``start_new_session=True``. Never use this
    helper for an inherited process group containing the web server itself.
    """
    if proc is None:
        return
    if proc.stdin is not None and not proc.stdin.is_closing():
        try:
            proc.stdin.close()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send(sig: signal.Signals) -> None:
        try:
            if os.name == "posix":
                os.killpg(proc.pid, sig)
            elif proc.returncode is None:
                proc.terminate() if sig == signal.SIGTERM else proc.kill()
        except ProcessLookupError:
            pass

    try:
        send(signal.SIGTERM)
        if proc.returncode is None:
            try:
                await asyncio.wait_for(proc.wait(), timeout=grace)
            except asyncio.TimeoutError:
                pass
    finally:
        # The parent may already have exited while a child still owns a pipe.
        send(getattr(signal, "SIGKILL", signal.SIGTERM))
        try:
            await asyncio.wait_for(proc.wait(), timeout=grace)
        except asyncio.TimeoutError:
            logger.warning("CLI process %s did not finish reaping within the cleanup deadline", proc.pid)
