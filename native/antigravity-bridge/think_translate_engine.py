"""Thinking auto-translation engine for Antigravity Bridge.

Persists user-selected translation account + model and translates model thinking
blocks using the selected Antigravity account in an isolated HOME environment.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import tempfile
import time
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger("antigravity-chat.think-translate")

DEFAULT_TARGET_LANG = "zh-CN"
MAX_CACHE_ENTRIES = 256
MAX_TEXT_CHARS = 32000
DEFAULT_TIMEOUT_SECONDS = 60

_LANG_LABELS: dict[str, str] = {
    "zh-CN": "Simplified Chinese (简体中文)",
    "zh-TW": "Traditional Chinese (繁體中文)",
    "en": "English",
    "ja": "Japanese (日本語)",
    "ko": "Korean (한국어)",
    "fr": "French",
    "de": "German",
    "es": "Spanish",
}

_translation_cache: OrderedDict[str, str] = OrderedDict()
_translate_semaphore = asyncio.Semaphore(3)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}.{time.time_ns()}")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def normalize_target_lang(lang: str | None) -> str:
    cleaned = (lang or "").strip()
    if not cleaned:
        return DEFAULT_TARGET_LANG
    return cleaned


def load_think_translate_config(config_path: Path) -> dict[str, Any]:
    default_cfg: dict[str, Any] = {
        "account_id": "",
        "model": "",
        "target_lang": DEFAULT_TARGET_LANG,
        "updated_at": None,
    }
    if not config_path.exists():
        return default_cfg
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return default_cfg
        return {
            "account_id": str(raw.get("account_id") or "").strip(),
            "model": str(raw.get("model") or "").strip(),
            "target_lang": normalize_target_lang(raw.get("target_lang")),
            "updated_at": raw.get("updated_at"),
        }
    except Exception as exc:
        logger.warning("Failed to read think_translate_config.json: %s", exc)
        return default_cfg


def save_think_translate_config(
    config_path: Path,
    *,
    account_id: str | None = None,
    model: str | None = None,
    target_lang: str | None = None,
) -> dict[str, Any]:
    current = load_think_translate_config(config_path)
    if account_id is not None:
        current["account_id"] = str(account_id).strip()
    if model is not None:
        current["model"] = str(model).strip()
    if target_lang is not None:
        current["target_lang"] = normalize_target_lang(target_lang)
    current["updated_at"] = _now_iso()
    _atomic_write_json(config_path, current)
    return current


def build_translation_prompt(text: str, target_lang: str = DEFAULT_TARGET_LANG) -> str:
    lang_code = normalize_target_lang(target_lang)
    lang_label = _LANG_LABELS.get(lang_code, lang_code)
    return (
        f"You are a precise technical translator. Translate the following AI thinking/reasoning text into {lang_label}.\n"
        "Strict rules:\n"
        "1. Output ONLY the translated text itself. Do NOT add any preamble, explanation, notes, or surrounding quotes.\n"
        "2. Preserve all code blocks, inline code, file paths, CLI commands, identifiers, symbol names, URLs, and exact log/error quotes verbatim.\n"
        "3. Preserve paragraph breaks, bullet lists, and Markdown formatting.\n"
        "4. Do NOT call any tools, do NOT read/write any files, and do NOT answer or continue the reasoning — only translate it.\n\n"
        "Text to translate:\n"
        f"{text}"
    )


def extract_text_from_stream_json(stdout_text: str) -> str:
    """Extract final assistant text from `agy --output-format stream-json` output."""
    deltas: list[str] = []
    result_text = ""
    fallback_lines: list[str] = []

    for raw_line in stdout_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            fallback_lines.append(raw_line)
            continue
        if not isinstance(obj, dict):
            continue

        ev_type = str(obj.get("type") or obj.get("event") or "").lower()
        # Skip thinking/thought events so we only capture the translated answer.
        if ev_type in {"thinking", "thought", "reasoning", "thought_delta", "thinking_delta"}:
            continue
        if obj.get("thought") is True or obj.get("is_thought") is True:
            continue

        if ev_type == "step_update":
            step = obj.get("step_update")
            if not isinstance(step, dict):
                continue
            stype = str(step.get("step_type") or "").lower()
            if stype in {"thinking", "thought", "reasoning", "user_input", "tool", "tool_call"}:
                continue
            if any(key in step for key in ("tool", "tool_name", "tool_info")):
                continue
            delta = step.get("text_delta") or step.get("delta")
            if isinstance(delta, str) and delta:
                deltas.append(delta)
            elif isinstance(step.get("text"), str) and step["text"].strip():
                result_text = step["text"]
            elif isinstance(step.get("content"), str) and step["content"].strip():
                result_text = step["content"]
            continue

        if ev_type in {"message", "assistant"}:
            role = str(obj.get("role") or "").lower()
            if role and role != "assistant":
                continue
            content = obj.get("content")
            if isinstance(content, str) and content:
                if obj.get("delta") is True:
                    deltas.append(content)
                else:
                    result_text = content
            elif isinstance(content, list):
                parts: list[str] = []
                for item in content:
                    if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
                        parts.append(item["text"])
                if parts:
                    result_text = "".join(parts)
            continue

        if ev_type in {"delta", "text", "content_block_delta", "agent_message_chunk"}:
            chunk = obj.get("text_delta") or obj.get("delta") or obj.get("text") or obj.get("content")
            if isinstance(chunk, dict):
                chunk = chunk.get("text") or chunk.get("content")
            if isinstance(chunk, str) and chunk:
                deltas.append(chunk)
            continue

        if ev_type == "result":
            res_obj = obj.get("result")
            resp: Any = None
            if isinstance(res_obj, dict):
                resp = res_obj.get("response") or res_obj.get("text") or res_obj.get("content")
            if not isinstance(resp, str) or not resp.strip():
                resp = obj.get("response") or obj.get("result") or obj.get("text")
            if isinstance(resp, str) and resp.strip():
                result_text = resp
            continue

        if isinstance(obj.get("response"), str) and obj["response"].strip():
            result_text = obj["response"]

    if deltas:
        return "".join(deltas).strip()
    if result_text:
        return result_text.strip()
    return "\n".join(fallback_lines).strip()


def _cache_key(account_id: str, model: str, target_lang: str, text: str) -> str:
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return f"{account_id}|{model}|{target_lang}|{digest}"


def clear_translation_cache() -> None:
    _translation_cache.clear()


def _prepare_isolated_translate_env(
    run_env: dict[str, str],
    tmp_root: Path,
) -> tuple[dict[str, str], Path | None, Path | None, bytes | None]:
    """Create an ephemeral HOME with zero MCP servers and isolated conversations/rules."""
    source_home_raw = (run_env.get("HOME") or "").strip()
    if not source_home_raw:
        return dict(run_env), None, None, None
    source_home = Path(source_home_raw).expanduser()
    source_cli = source_home / ".gemini" / "antigravity-cli"
    if not source_cli.is_dir():
        return dict(run_env), None, None, None

    isolated_home = tmp_root / "home"
    isolated_cli = isolated_home / ".gemini" / "antigravity-cli"
    isolated_cfg = isolated_home / ".gemini" / "config"
    isolated_cli.mkdir(parents=True, exist_ok=True, mode=0o700)
    isolated_cfg.mkdir(parents=True, exist_ok=True, mode=0o700)
    for empty_dir in ("conversations", "brain", "rules"):
        (isolated_cli / empty_dir).mkdir(parents=True, exist_ok=True, mode=0o700)

    for shared_name in ("bin", "builtin", "cache", "installation_id", "settings.json"):
        src_item = source_cli / shared_name
        dst_item = isolated_cli / shared_name
        if src_item.exists() and not dst_item.exists():
            try:
                dst_item.symlink_to(src_item.resolve())
            except OSError:
                pass

    (isolated_cfg / "mcp_config.json").write_text('{"mcpServers": {}}\n', encoding="utf-8")

    src_token = source_cli / "antigravity-oauth-token"
    dst_token: Path | None = None
    src_bytes: bytes | None = None
    if src_token.is_file():
        try:
            src_bytes = src_token.read_bytes()
            dst_token = isolated_cli / "antigravity-oauth-token"
            dst_token.write_bytes(src_bytes)
            dst_token.chmod(0o600)
        except OSError:
            dst_token = None
            src_bytes = None

    isolated_env = dict(run_env)
    isolated_env["HOME"] = str(isolated_home)
    return isolated_env, (src_token if dst_token else None), dst_token, src_bytes


def _sync_refreshed_translate_token(
    src_token: Path | None,
    dst_token: Path | None,
    original_bytes: bytes | None,
) -> None:
    if not src_token or not dst_token or not dst_token.is_file():
        return
    try:
        updated_bytes = dst_token.read_bytes()
        if not updated_bytes or updated_bytes == original_bytes:
            return
        parsed = json.loads(updated_bytes.decode("utf-8"))
        if not isinstance(parsed, dict) or not (parsed.get("access_token") or parsed.get("refresh_token")):
            return
        tmp_path = src_token.with_name(f".{src_token.name}.{os.getpid()}.{time.time_ns()}.tmp")
        tmp_path.write_bytes(updated_bytes)
        tmp_path.chmod(0o600)
        os.replace(tmp_path, src_token)
    except Exception as exc:
        logger.debug("Skipped syncing refreshed translate OAuth token: %s", exc)


async def translate_thinking_text(
    *,
    text: str,
    target_lang: str = DEFAULT_TARGET_LANG,
    account_id: str = "",
    model: str = "",
    agy_bin: str,
    run_env: dict[str, str],
    scratch_dir: Path,
    timeout_sec: int = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    cleaned = (text or "").strip()
    if not cleaned:
        return {
            "ok": True,
            "translated": "",
            "account_id": account_id,
            "model": model,
            "target_lang": normalize_target_lang(target_lang),
            "cached": False,
        }
    if len(cleaned) > MAX_TEXT_CHARS:
        cleaned = cleaned[:MAX_TEXT_CHARS]

    lang = normalize_target_lang(target_lang)
    key = _cache_key(account_id, model, lang, cleaned)
    cached_value = _translation_cache.get(key)
    if cached_value is not None:
        _translation_cache.move_to_end(key)
        return {
            "ok": True,
            "translated": cached_value,
            "account_id": account_id,
            "model": model,
            "target_lang": lang,
            "cached": True,
        }

    prompt = build_translation_prompt(cleaned, lang)
    argv = [
        agy_bin,
        "--dangerously-skip-permissions",
        "--disable-slash-commands",
        "--output-format",
        "stream-json",
    ]
    if model and model != "default":
        argv += ["--model", model]
    else:
        argv += ["--effort", "low"]
    argv += ["--print-timeout", f"{timeout_sec}s", f"-p={prompt}"]

    async with _translate_semaphore:
        # Re-check cache after acquiring semaphore in case a duplicate request finished.
        cached_after_wait = _translation_cache.get(key)
        if cached_after_wait is not None:
            _translation_cache.move_to_end(key)
            return {
                "ok": True,
                "translated": cached_after_wait,
                "account_id": account_id,
                "model": model,
                "target_lang": lang,
                "cached": True,
            }

        with tempfile.TemporaryDirectory(prefix="agy-translate-", dir=str(scratch_dir)) as tmp_cwd:
            tmp_root = Path(tmp_cwd)
            work_cwd = tmp_root / "work"
            work_cwd.mkdir(parents=True, exist_ok=True)
            isolated_env, src_tok, dst_tok, orig_tok_bytes = _prepare_isolated_translate_env(run_env, tmp_root)
            proc = await asyncio.create_subprocess_exec(
                *argv,
                cwd=str(work_cwd),
                env=isolated_env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    proc.communicate(),
                    timeout=timeout_sec + 10,
                )
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                    await proc.wait()
                except Exception:
                    pass
                raise RuntimeError("思考翻译超时，请更换更快的翻译模型或稍后重试。")
            finally:
                _sync_refreshed_translate_token(src_tok, dst_tok, orig_tok_bytes)

            stdout_text = stdout_bytes.decode("utf-8", errors="replace")
            stderr_text = stderr_bytes.decode("utf-8", errors="replace").strip()
            translated = extract_text_from_stream_json(stdout_text)

            if not translated:
                if proc.returncode != 0:
                    detail = stderr_text.splitlines()[-1] if stderr_text else f"exit code {proc.returncode}"
                    raise RuntimeError(f"翻译模型调用失败：{detail[:240]}")
                raise RuntimeError("翻译模型未返回有效内容，请检查所选账号与模型。")

            _translation_cache[key] = translated
            while len(_translation_cache) > MAX_CACHE_ENTRIES:
                _translation_cache.popitem(last=False)

            return {
                "ok": True,
                "translated": translated,
                "account_id": account_id,
                "model": model,
                "target_lang": lang,
                "cached": False,
            }
