"""Thinking auto-translation engine for Antigravity Bridge.

Persists user-selected translation account + model and translates model thinking
blocks using the selected Antigravity account in an isolated HOME environment,
with structured AGY_ERROR parsing, quota cooldown tracking, and usage telemetry.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
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
MAX_COOLDOWN_SECONDS = 6 * 3600
DEFAULT_ACCOUNT_QUOTA_COOLDOWN_SECONDS = 1800
DEFAULT_MODEL_COOLDOWN_SECONDS = 300

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

_AGY_ERROR_JSON_RE = re.compile(r"AGY_ERROR:\s*(\{.*\})", re.DOTALL)
_RESET_HINT_RE = re.compile(r"Resets?\s+in\s+([0-9hms.\s]+)", re.IGNORECASE)
_DURATION_PART_RE = re.compile(r"(\d+(?:\.\d+)?)\s*([hms])", re.IGNORECASE)

_translation_cache: OrderedDict[str, dict[str, Any]] = OrderedDict()
_cooldown_registry: dict[str, dict[str, Any]] = {}
_translate_semaphore = asyncio.Semaphore(3)


class TranslateCallError(RuntimeError):
    """Structured translation invocation failure preserving RuntimeError compatibility."""

    def __init__(
        self,
        message: str,
        *,
        category: str = "other",
        error_code: int | None = None,
        reset_seconds: int | None = None,
        reset_hint: str | None = None,
        account_wide: bool = False,
        short_error: str = "",
    ) -> None:
        super().__init__(message)
        self.category = category
        self.error_code = error_code
        self.reset_seconds = reset_seconds
        self.reset_hint = reset_hint
        self.account_wide = account_wide
        self.short_error = short_error


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


def _parse_reset_duration_seconds(hint: str | None) -> int | None:
    if not hint:
        return None
    total = 0.0
    matched = False
    for num_str, unit in _DURATION_PART_RE.findall(hint):
        matched = True
        val = float(num_str)
        u = unit.lower()
        if u == "h":
            total += val * 3600
        elif u == "m":
            total += val * 60
        elif u == "s":
            total += val
    if not matched or total <= 0:
        return None
    return max(1, int(round(total)))


def parse_agy_error_detail(stderr_text: str, stdout_text: str = "", returncode: int | None = None) -> dict[str, Any]:
    """Parse structured AGY_ERROR JSON or CLI stderr into clean diagnostics and failover classification."""
    combined = "\n".join(part for part in (stderr_text.strip(), stdout_text.strip()) if part)
    parsed_json: dict[str, Any] | None = None

    for line in reversed(combined.splitlines()):
        m = _AGY_ERROR_JSON_RE.search(line)
        if m:
            candidate = m.group(1).strip()
            try:
                obj = json.loads(candidate)
                if isinstance(obj, dict):
                    parsed_json = obj
                    break
            except json.JSONDecodeError:
                pass

    if parsed_json is None:
        m_full = _AGY_ERROR_JSON_RE.search(combined)
        if m_full:
            try:
                obj = json.loads(m_full.group(1).strip())
                if isinstance(obj, dict):
                    parsed_json = obj
            except json.JSONDecodeError:
                pass

    short_error = ""
    status = ""
    error_code: int | None = None
    if parsed_json:
        short_error = str(parsed_json.get("short_error") or parsed_json.get("message") or "").strip()
        status = str(parsed_json.get("status") or "").strip()
        raw_code = parsed_json.get("error_code") or parsed_json.get("code")
        if isinstance(raw_code, int):
            error_code = raw_code
        elif isinstance(raw_code, str) and raw_code.isdigit():
            error_code = int(raw_code)

    if not short_error:
        last_line = stderr_text.strip().splitlines()[-1].strip() if stderr_text.strip() else ""
        if last_line.startswith("AGY_ERROR:"):
            m_short = re.search(r'"short_error"\s*:\s*"([^"]+)"', last_line)
            if m_short:
                short_error = m_short.group(1).strip()
            m_code = re.search(r'"error_code"\s*:\s*(\d+)', last_line)
            if m_code and error_code is None:
                error_code = int(m_code.group(1))
            m_status = re.search(r'"status"\s*:\s*"([^"]+)"', last_line)
            if m_status and not status:
                status = m_status.group(1).strip()
        if not short_error:
            short_error = last_line or (f"exit code {returncode}" if returncode is not None else "未知错误")

    reset_match = _RESET_HINT_RE.search(short_error) or _RESET_HINT_RE.search(combined)
    reset_hint = reset_match.group(1).strip().rstrip(".") if reset_match else None
    reset_seconds = _parse_reset_duration_seconds(reset_hint)

    haystack = f"{status} {short_error}".lower()
    category = "other"
    account_wide = False

    if (
        error_code in (429, 503, 529)
        or status.upper() == "RESOURCE_EXHAUSTED"
        or any(tok in haystack for tok in ("resource_exhausted", "quota", "rate limit", "too many requests", "overloaded", "capacity"))
    ):
        category = "quota_exhausted"
        if any(tok in haystack for tok in ("individual quota reached", "upgrade your subscription", "account quota", "weekly limit")):
            account_wide = True
    elif (
        error_code in (401, 403)
        or status.upper() in ("UNAUTHENTICATED", "PERMISSION_DENIED")
        or any(tok in haystack for tok in ("unauthenticated", "invalid_grant", "unauthorized", "token expired", "permission_denied", "revoked"))
    ):
        category = "auth_error"
        account_wide = True
    elif (
        error_code == 404
        or status.upper() == "NOT_FOUND"
        or ("model" in haystack and any(tok in haystack for tok in ("not found", "unsupported", "not available", "invalid", "access")))
    ):
        category = "model_unavailable"

    if category == "quota_exhausted":
        if reset_hint:
            message = f"翻译模型额度已耗尽（HTTP {error_code or 429}，约 {reset_hint} 后重置）"
        else:
            message = f"翻译模型额度或并发受限（HTTP {error_code or 429}）"
    elif category == "auth_error":
        message = f"翻译账号登录凭证失效或无权限（HTTP {error_code or 401}），请检查账号状态"
    elif category == "model_unavailable":
        message = f"当前翻译账号不支持所选模型：{short_error[:160]}"
    else:
        message = f"翻译模型调用失败：{short_error[:200]}"

    return {
        "message": message,
        "category": category,
        "error_code": error_code,
        "status": status,
        "short_error": short_error,
        "reset_hint": reset_hint,
        "reset_seconds": reset_seconds,
        "account_wide": account_wide,
    }


def _non_neg_int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        iv = int(value)
        return iv if iv >= 0 else 0
    return 0


def _normalize_usage_dict(raw: Any) -> dict[str, int] | None:
    if not isinstance(raw, dict):
        return None
    raw_input = _non_neg_int(raw.get("input_tokens") if raw.get("input_tokens") is not None else raw.get("prompt_tokens"))
    cache_read = _non_neg_int(
        raw.get("cache_read_tokens")
        if raw.get("cache_read_tokens") is not None
        else raw.get("cache_read_input_tokens")
        if raw.get("cache_read_input_tokens") is not None
        else raw.get("cached_input_tokens")
    )
    cache_write = _non_neg_int(
        raw.get("cache_creation_tokens")
        if raw.get("cache_creation_tokens") is not None
        else raw.get("cache_creation_input_tokens")
        if raw.get("cache_creation_input_tokens") is not None
        else raw.get("cache_write_input_tokens")
    )
    output = _non_neg_int(raw.get("output_tokens") if raw.get("output_tokens") is not None else raw.get("completion_tokens"))
    reasoning = _non_neg_int(
        raw.get("thinking_tokens")
        if raw.get("thinking_tokens") is not None
        else raw.get("reasoning_output_tokens")
        if raw.get("reasoning_output_tokens") is not None
        else raw.get("reasoning_tokens")
    )
    total = _non_neg_int(raw.get("total_tokens"))
    if total <= 0:
        total = raw_input + output + cache_read + cache_write
    if total <= 0 and raw_input <= 0 and output <= 0:
        return None
    return {
        "input": raw_input,
        "output": output,
        "cacheRead": cache_read,
        "cacheWrite": cache_write,
        "reasoning": reasoning,
        "total": total,
    }


def extract_translate_stream_details(stdout_text: str) -> dict[str, Any]:
    """Extract translated assistant text plus reported model, duration, and token usage from `agy --output-format stream-json`."""
    deltas: list[str] = []
    result_text = ""
    fallback_lines: list[str] = []
    reported_model: str | None = None
    duration_ms: int | None = None
    usage: dict[str, int] | None = None

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

        if ev_type == "init":
            init_obj = obj.get("init") if isinstance(obj.get("init"), dict) else {}
            cand_model = init_obj.get("model") or obj.get("model")
            if isinstance(cand_model, str) and cand_model.strip():
                reported_model = cand_model.strip()
            continue

        cand_top_model = obj.get("response_model") or obj.get("model")
        if isinstance(cand_top_model, str) and cand_top_model.strip():
            reported_model = cand_top_model.strip()

        top_usage = _normalize_usage_dict(obj.get("usage"))
        if top_usage:
            usage = top_usage

        # Skip thinking/thought events so we only capture the translated answer.
        if ev_type in {"thinking", "thought", "reasoning", "thought_delta", "thinking_delta"}:
            continue
        if obj.get("thought") is True or obj.get("is_thought") is True:
            continue

        if ev_type == "step_update":
            step = obj.get("step_update")
            if not isinstance(step, dict):
                continue
            step_usage = _normalize_usage_dict(step.get("usage"))
            if step_usage:
                usage = step_usage
            if isinstance(step.get("duration_seconds"), (int, float)) and step["duration_seconds"] > 0:
                duration_ms = int(round(float(step["duration_seconds"]) * 1000))
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
                res_usage = _normalize_usage_dict(res_obj.get("usage"))
                if res_usage:
                    usage = res_usage
                if isinstance(res_obj.get("duration_seconds"), (int, float)) and res_obj["duration_seconds"] > 0:
                    duration_ms = int(round(float(res_obj["duration_seconds"]) * 1000))
                res_model = res_obj.get("model") or res_obj.get("response_model")
                if isinstance(res_model, str) and res_model.strip():
                    reported_model = res_model.strip()
            if not isinstance(resp, str) or not resp.strip():
                resp = obj.get("response") or obj.get("result") or obj.get("text")
            if isinstance(resp, str) and resp.strip():
                result_text = resp
            continue

        if isinstance(obj.get("response"), str) and obj["response"].strip():
            result_text = obj["response"]

    if deltas:
        final_text = "".join(deltas).strip()
    elif result_text:
        final_text = result_text.strip()
    else:
        final_text = "\n".join(fallback_lines).strip()

    return {
        "text": final_text,
        "reported_model": reported_model,
        "duration_ms": duration_ms,
        "usage": usage,
    }


def extract_text_from_stream_json(stdout_text: str) -> str:
    """Extract final assistant text from `agy --output-format stream-json` output."""
    return str(extract_translate_stream_details(stdout_text)["text"])


def _cache_key(account_id: str, model: str, target_lang: str, text: str) -> str:
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return f"{account_id}|{model}|{target_lang}|{digest}"


def clear_translate_cooldowns(account_id: str | None = None) -> None:
    if not account_id:
        _cooldown_registry.clear()
        return
    clean = account_id.strip()
    stale = [k for k, v in _cooldown_registry.items() if v.get("account_id") == clean]
    for k in stale:
        _cooldown_registry.pop(k, None)


def clear_translation_cache() -> None:
    _translation_cache.clear()
    _cooldown_registry.clear()


def record_translate_cooldown(
    account_id: str,
    model: str = "",
    *,
    category: str,
    account_wide: bool = False,
    reset_seconds: int | None = None,
    reason: str = "",
) -> None:
    acc = (account_id or "").strip()
    if not acc or category not in {"quota_exhausted", "auth_error", "model_unavailable"}:
        return
    if reset_seconds is not None and reset_seconds > 0:
        ttl = min(max(reset_seconds, 60), MAX_COOLDOWN_SECONDS)
    elif account_wide:
        ttl = DEFAULT_ACCOUNT_QUOTA_COOLDOWN_SECONDS
    else:
        ttl = DEFAULT_MODEL_COOLDOWN_SECONDS

    scope_key = f"acc:{acc}" if (account_wide or not model) else f"mod:{acc}:{model.strip()}"
    _cooldown_registry[scope_key] = {
        "scope": "account" if (account_wide or not model) else "model",
        "account_id": acc,
        "model": "" if (account_wide or not model) else model.strip(),
        "category": category,
        "reason": reason,
        "until_mono": time.monotonic() + ttl,
        "recorded_at": _now_iso(),
    }


def get_translate_cooldown_reason(account_id: str, model: str = "") -> str | None:
    acc = (account_id or "").strip()
    if not acc:
        return None
    now = time.monotonic()
    for key in (f"acc:{acc}", f"mod:{acc}:{model.strip()}" if model else ""):
        if not key:
            continue
        entry = _cooldown_registry.get(key)
        if not entry:
            continue
        if float(entry.get("until_mono", 0.0)) <= now:
            _cooldown_registry.pop(key, None)
            continue
        return str(entry.get("reason") or "账号或模型处于额度冷却期")
    return None


def list_active_translate_cooldowns() -> list[dict[str, Any]]:
    now = time.monotonic()
    active: list[dict[str, Any]] = []
    expired_keys: list[str] = []
    for key, entry in _cooldown_registry.items():
        rem = float(entry.get("until_mono", 0.0)) - now
        if rem <= 0:
            expired_keys.append(key)
            continue
        active.append(
            {
                "scope": entry.get("scope", "account"),
                "account_id": entry.get("account_id", ""),
                "model": entry.get("model", ""),
                "category": entry.get("category", "quota_exhausted"),
                "reason": entry.get("reason", ""),
                "remaining_seconds": int(round(rem)),
                "recorded_at": entry.get("recorded_at"),
            }
        )
    for k in expired_keys:
        _cooldown_registry.pop(k, None)
    return active


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
            "reported_model": None,
            "target_lang": normalize_target_lang(target_lang),
            "cached": False,
            "duration_ms": 0,
            "usage": None,
        }
    if len(cleaned) > MAX_TEXT_CHARS:
        cleaned = cleaned[:MAX_TEXT_CHARS]

    lang = normalize_target_lang(target_lang)
    key = _cache_key(account_id, model, lang, cleaned)
    cached_entry = _translation_cache.get(key)
    if cached_entry is not None:
        _translation_cache.move_to_end(key)
        return {
            "ok": True,
            "translated": cached_entry["translated"],
            "account_id": account_id,
            "model": model,
            "reported_model": cached_entry.get("reported_model"),
            "target_lang": lang,
            "cached": True,
            "duration_ms": 0,
            "usage": None,
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
        cached_after_wait = _translation_cache.get(key)
        if cached_after_wait is not None:
            _translation_cache.move_to_end(key)
            return {
                "ok": True,
                "translated": cached_after_wait["translated"],
                "account_id": account_id,
                "model": model,
                "reported_model": cached_after_wait.get("reported_model"),
                "target_lang": lang,
                "cached": True,
                "duration_ms": 0,
                "usage": None,
            }

        with tempfile.TemporaryDirectory(prefix="agy-translate-", dir=str(scratch_dir)) as tmp_cwd:
            tmp_root = Path(tmp_cwd)
            work_cwd = tmp_root / "work"
            work_cwd.mkdir(parents=True, exist_ok=True)
            isolated_env, src_tok, dst_tok, orig_tok_bytes = _prepare_isolated_translate_env(run_env, tmp_root)
            started_mono = time.monotonic()
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
                raise TranslateCallError(
                    "思考翻译超时，请更换更快的翻译模型或稍后重试。",
                    category="timeout",
                )
            finally:
                _sync_refreshed_translate_token(src_tok, dst_tok, orig_tok_bytes)

            elapsed_ms = max(1, int(round((time.monotonic() - started_mono) * 1000)))
            stdout_text = stdout_bytes.decode("utf-8", errors="replace")
            stderr_text = stderr_bytes.decode("utf-8", errors="replace").strip()
            details = extract_translate_stream_details(stdout_text)
            translated = str(details["text"] or "").strip()

            if not translated:
                if proc.returncode != 0 or stderr_text:
                    err = parse_agy_error_detail(stderr_text, stdout_text, proc.returncode)
                    record_translate_cooldown(
                        account_id,
                        model,
                        category=err["category"],
                        account_wide=bool(err["account_wide"]),
                        reset_seconds=err["reset_seconds"],
                        reason=err["message"],
                    )
                    raise TranslateCallError(
                        err["message"],
                        category=err["category"],
                        error_code=err["error_code"],
                        reset_seconds=err["reset_seconds"],
                        reset_hint=err["reset_hint"],
                        account_wide=bool(err["account_wide"]),
                        short_error=err["short_error"],
                    )
                raise TranslateCallError(
                    "翻译模型未返回有效内容，请检查所选账号与模型。",
                    category="empty_output",
                )

            duration_ms = details["duration_ms"] if isinstance(details["duration_ms"], int) and details["duration_ms"] > 0 else elapsed_ms
            reported_model = details["reported_model"]
            usage = details["usage"]

            _translation_cache[key] = {
                "translated": translated,
                "reported_model": reported_model,
            }
            while len(_translation_cache) > MAX_CACHE_ENTRIES:
                _translation_cache.popitem(last=False)

            return {
                "ok": True,
                "translated": translated,
                "account_id": account_id,
                "model": model,
                "reported_model": reported_model,
                "target_lang": lang,
                "cached": False,
                "duration_ms": duration_ms,
                "usage": usage,
            }
