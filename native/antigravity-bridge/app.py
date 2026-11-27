"""antigravity-chat — a minimal web chat UI backed by the `agy` (antigravity) CLI.

Self-contained FastAPI app. It shells `agy --print` headlessly using `--output-format stream-json`
and streams real-time token events to a lightweight web UI, supporting stateful conversations.

This is NOT the OpenRouter proxy on :3120 — it talks to the real antigravity CLI.
"""

from __future__ import annotations

import asyncio
import base64
import codecs
from contextlib import asynccontextmanager
import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, SecretStr, StrictBool
from agy_metadata import (
    read_acp_session_evidence,
    read_session_historical_error,
    read_session_models,
    read_session_thinking,
)
from acp_client import probe_agy_acp_info, stream_agy_acp
from agy_client_profile import DesktopProfileProxy
from claude_agy import resolve_active_claude_output_style, stream_claude_agy
from process_lifecycle import reap_cli_process
from project_updates import ProjectUpdater
from update_common import UpdateError
from detached_chat import TurnManager
from armor_engine import (
    ARMOR_DELIVERY_SEAT,
    ARMOR_SYSTEM_DIRECTIVE,
    ensure_armor_rules,
    get_armor_system_directive,
    is_pure_history_refusal,
    soften_prompt,
    strip_block_echo,
    strip_foreign_armor,
    sync_armor_rules,
)
from transam_engine import (
    build_transam_turn_prompt,
    get_transam_system_directive,
    has_transam_history_tags,
    is_continue_prompt,
    resolve_transam_tier,
    sanitize_transam_history_content,
    sync_transam_rules,
)
from agy_fast_engine import (
    bind_agy_fast_session_snapshot,
    check_agy_fast_update,
    get_agy_fast_mcp_config,
    get_agy_fast_status,
    get_agy_fast_system_directive,
    has_agy_fast_session_snapshot,
    set_agy_fast_config,
    update_agy_fast_plugin,
)
from think_translate_engine import (
    TranslateCallError,
    clear_translate_cooldowns,
    get_translate_cooldown_reason,
    list_active_translate_cooldowns,
    load_think_translate_config,
    save_think_translate_config,
    translate_thinking_text,
)

logger = logging.getLogger("antigravity-chat")

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #

def _load_env() -> None:
    env_file = Path(__file__).parent / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip("'\""))


_load_env()

PORT = int(os.getenv("PORT", "26903"))
AGY_BIN = os.getenv("AGY_BIN", "agy")
AGY_TIMEOUT = int(os.getenv("AGY_TIMEOUT", "1800"))  # seconds per turn
AGY_SANDBOX = os.getenv("AGY_SANDBOX", "0") not in ("0", "false", "")
AGY_OUTPUT_FORMAT = os.getenv("AGY_OUTPUT_FORMAT", "stream-json")
AGY_PERSIST_CONVERSATIONS = os.getenv("AGY_PERSIST_CONVERSATIONS", "true").lower() in ("1", "true", "yes")
AGY_DISABLE_MCP = os.getenv("AGY_DISABLE_MCP", "false").lower() in ("1", "true", "yes")
AGY_DISABLED_MCP_SERVERS = {
    name.strip().lower()
    for name in os.getenv("AGY_DISABLED_MCP_SERVERS", "").split(",")
    if name.strip()
}
CONVERSATIONS_FILE = Path(os.getenv("AGY_CONVERSATIONS_FILE", str(Path(__file__).parent / ".antigravity_conversations.json")))
MESSAGES_DIR = Path(os.getenv("AGY_MESSAGES_DIR", str(Path(__file__).parent / "data" / "messages")))
MESSAGES_DIR.mkdir(parents=True, exist_ok=True)
web_turns = TurnManager(MESSAGES_DIR, logger)

# Neutral working dir so agy does not pull in unrelated repo context.
SCRATCH = Path(os.getenv("AGY_SCRATCH", str(Path(__file__).parent / "scratch")))
SCRATCH.mkdir(parents=True, exist_ok=True)
UPLOADS = Path(os.getenv("AGY_UPLOADS", str(Path(__file__).parent / "uploads")))
UPLOADS.mkdir(parents=True, exist_ok=True)
STATIC = Path(__file__).parent / "static"

HOME = os.path.expanduser("~")
DEFAULT_ALLOWED_ROOTS = f"{HOME}"
_allowed_raw = os.getenv("AGY_ALLOWED_ROOTS", DEFAULT_ALLOWED_ROOTS)
ALLOWED_ROOTS = [
    os.path.realpath(os.path.expanduser(p.strip()))
    for p in _allowed_raw.split(os.pathsep)
    if p.strip()
]
if str(UPLOADS.resolve()) not in ALLOWED_ROOTS:
    ALLOWED_ROOTS.append(str(UPLOADS.resolve()))

ACCOUNTS_DIR = Path(os.getenv("AGY_ACCOUNTS_DIR", str(Path(HOME) / ".gemini" / "antigravity-cli" / "accounts")))
ACTIVE_TOKEN_FILE = Path(HOME) / ".gemini" / "antigravity-cli" / "antigravity-oauth-token"
try:
    ACCOUNTS_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
except Exception:
    pass

DOWNLOAD_LINK_INSTRUCTION = (
    "当用户需要查看或获取图片、视频时，请直接使用 Markdown 语法 ![说明](文件相对或绝对路径) 嵌入到回复中，聊天界面会直接显示图片和播放视频；"
    "当用户需要获取或下载其他文件时，如果你生成或修改了文件，请在回答中提供文件下载链接，格式为 [📥 点击下载 文件名](/api/download?path=文件相对或绝对路径)，客户端即可直接下载到本地电脑。"
)

DEFAULT_SYSTEM = (
    "You are a helpful, concise assistant chatting with a user in a web UI. "
    "Provide your answer directly in Markdown, with a brief explanation when useful. "
    "Do not use tools, do not read or write files, and do not run shell commands unless the user "
    "explicitly asks you to or has provided attached files/images to inspect. "
    f"{DOWNLOAD_LINK_INSTRUCTION}"
)

@asynccontextmanager
async def _app_lifespan(_app: FastAPI):
    web_turns.shutting_down = False
    try:
        yield
    finally:
        await web_turns.shutdown(drain_timeout=22.0)


app = FastAPI(title="antigravity-chat", version="1.1.0", lifespan=_app_lifespan)

# --------------------------------------------------------------------------- #
# Conversation persistence layer
# --------------------------------------------------------------------------- #

_conversations_lock = asyncio.Lock()


def _sanitize_token(val: str | None, default: str | None = None) -> str | None:
    if not val or not isinstance(val, str):
        return default
    clean = "".join(c for c in val if c.isalnum() or c in ("-", "_")).strip()
    return clean if clean else default


def _read_conversations() -> dict:
    if not CONVERSATIONS_FILE.exists():
        return {}
    try:
        return json.loads(CONVERSATIONS_FILE.read_text())
    except Exception as exc:
        logger.warning(f"Failed to read conversation mapping file {CONVERSATIONS_FILE}: {exc}")
        return {}


def _write_conversations(data: dict) -> None:
    try:
        tmp_file = CONVERSATIONS_FILE.with_suffix(".json.tmp")
        tmp_file.write_text(json.dumps(data, indent=2))
        tmp_file.replace(CONVERSATIONS_FILE)
    except Exception as exc:
        logger.warning(f"Failed to write conversation mapping file {CONVERSATIONS_FILE}: {exc}")


def _ensure_user(data: dict, uid: str) -> dict:
    """Return user's store in multi-conversation format, migrating old format in-memory.

    New format: {"active_id": <cid|None>, "conversations": {<cid>: {"title":..., "updated_at":...}}}
    Old format: {"conversation_id":..., "title":..., "updated_at":...}
    """
    entry = data.get(uid)
    if isinstance(entry, dict) and isinstance(entry.get("conversations"), dict):
        entry.setdefault("active_id", None)
        return entry
    new_entry: dict = {"active_id": None, "conversations": {}}
    if isinstance(entry, dict):
        cid = _sanitize_token(entry.get("conversation_id"))
        if cid:
            new_entry["conversations"][cid] = {
                "title": entry.get("title") or "Conversation",
                "updated_at": entry.get("updated_at") or time.time(),
                "pinned": bool(entry.get("pinned", False)),
            }
            new_entry["active_id"] = cid
    data[uid] = new_entry
    return new_entry


def parse_transcript_to_messages(transcript_path: Path, *, include_monitor: bool = False) -> list[dict]:
    if not transcript_path.exists():
        return []
    try:
        lines = transcript_path.read_text(errors="replace").splitlines()
    except Exception as exc:
        logger.warning(f"Failed to read transcript {transcript_path}: {exc}")
        return []

    messages: list[dict] = []
    current_user: dict | None = None
    assistant_steps: list[dict] = []
    observed_steps: set[int] = set()
    usage_by_step: dict[int, dict] = {}
    cumulative_usage: dict[str, int] = {}

    def flush_turn() -> None:
        nonlocal current_user, assistant_steps, observed_steps
        if current_user:
            messages.append(current_user)
            current_user = None
        if assistant_steps:
            final_content = ""
            all_thinking = []
            tool_name = None
            for step in assistant_steps:
                c = step.get("content") or ""
                th = step.get("thinking") or ""
                tl = step.get("tool")
                if tl:
                    tool_name = tl
                if th and th.strip() and th.strip() != "...":
                    all_thinking.append(th.strip())
                if c.strip():
                    final_content = c.strip()

            if "<think>" in final_content:
                tm = re.search(r"<think>(.*?)(?:</think>|$)", final_content, re.DOTALL)
                if tm:
                    th_inner = tm.group(1).strip()
                    if th_inner and th_inner != "...":
                        all_thinking.append(th_inner)
                    final_content = re.sub(r"<think>.*?</think>\s*", "", final_content, flags=re.DOTALL).strip()

            combined_thinking = "\n\n".join(all_thinking).strip()
            if final_content or combined_thinking or tool_name:
                messages.append({
                    "role": "assistant",
                    "created_at": assistant_steps[0].get("created_at"),
                    "content": final_content,
                    "thinking": combined_thinking,
                    "thoughtOpen": True,
                    "tool": tool_name,
                })
            if include_monitor and messages and messages[-1].get("role") == "assistant":
                messages[-1]["_native_steps"] = sorted(observed_steps)
                messages[-1]["_native_response_steps"] = sorted({step["step_index"] for step in assistant_steps
                    if isinstance(step.get("step_index"), int) and not isinstance(step["step_index"], bool)})
                if cumulative_usage:
                    total = cumulative_usage.get("input_tokens", 0) + cumulative_usage.get("output_tokens", 0)
                    labels = (("input_tokens", "输入"), ("output_tokens", "输出"),
                              ("thinking_tokens", "思考"), ("cache_read_tokens", "缓存"))
                    details = " / ".join(f"{label} {cumulative_usage[key]:,}" for key, label in labels if key in cumulative_usage)
                    messages[-1]["metrics"] = f"{total:,} tokens ({details})"
            assistant_steps = []
        observed_steps = set()

    for line in lines:
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue

        t = obj.get("type")
        src = obj.get("source")
        content = obj.get("content") or ""
        thinking = obj.get("thinking") or ""
        tool_calls = obj.get("tool_calls") or []

        if not (t == "USER_INPUT" and src == "USER_EXPLICIT"):
            index = obj.get("step_index")
            if isinstance(index, int) and not isinstance(index, bool) and index >= 0:
                observed_steps.add(index)
        if t == "USER_INPUT" and src == "USER_EXPLICIT":
            flush_turn()
            index = obj.get("step_index")
            if isinstance(index, int) and not isinstance(index, bool) and index >= 0:
                observed_steps.add(index)
            m = re.search(r"<USER_REQUEST>(.*?)</USER_REQUEST>", content, re.DOTALL)
            raw = m.group(1) if m else content
            if "--- Conversation so far ---" in raw:
                parts = raw.split("--- Conversation so far ---")
                after = parts[1].split("--- End conversation ---")[0].strip()
                user_lines = []
                for uline in after.splitlines():
                    if uline.startswith("User: "):
                        user_lines.append(uline[6:])
                    elif user_lines:
                        user_lines[-1] += "\n" + uline
                if user_lines:
                    raw = user_lines[-1]
            elif "Reply as the Assistant to the last User message" in raw:
                raw = raw.split("Reply as the Assistant to the last User message")[0].strip()

            raw = re.sub(r"\[系统设定：.*?\]\s*", "", raw).strip()
            attachments = []
            att_matches = re.finditer(r"\[附带(图片|文件):\s*(.+?)\s*\(本地路径:\s*(.+?)\)[\s\S]*?\]", raw)
            for am in att_matches:
                is_img = am.group(1) == "图片"
                att_name = am.group(2)
                att_path = am.group(3)
                url = None
                if "uploads/" in att_path:
                    url = "/uploads/" + att_path.split("uploads/")[-1]
                attachments.append({
                    "filename": att_name,
                    "path": att_path,
                    "url": url or att_path,
                    "is_image": is_img,
                })
            cleaned_text = re.sub(r"\[附带(图片|文件):.+?\]\s*", "", raw).strip()
            current_user = {"role": "user", "content": cleaned_text or raw,
                            "created_at": obj.get("created_at")}
            if attachments:
                current_user["attachments"] = attachments

        elif t == "PLANNER_RESPONSE" and src == "MODEL":
            tl = None
            if tool_calls:
                for tc in tool_calls:
                    fn = tc.get("function") or {}
                    tl = fn.get("name") or tc.get("name") or tl
            index = obj.get("step_index")
            if include_monitor and isinstance(index, int) and not isinstance(index, bool):
                numeric = {key: value for key in ("input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens")
                           if isinstance((value := obj.get(key)), int) and not isinstance(value, bool) and value >= 0}
                if numeric:
                    previous = usage_by_step.get(index, {})
                    current = {**previous, **numeric}
                    for key, value in current.items():
                        cumulative_usage[key] = cumulative_usage.get(key, 0) + value - previous.get(key, 0)
                    usage_by_step[index] = current
            assistant_steps.append({"content": content, "thinking": thinking, "tool": tl,
                                    "step_index": index, "created_at": obj.get("created_at")})

    flush_turn()
    return messages


def save_conversation(user_id: str, conversation_id: str, title: str | None = None) -> dict:
    """Upsert a conversation into the user's list and mark it active."""
    uid = _sanitize_token(user_id, "default") or "default"
    cid = _sanitize_token(conversation_id)
    if not cid:
        return {}
    data = _read_conversations()
    target_uids = set([uid, "default"])
    for target_uid in target_uids:
        udata = _ensure_user(data, target_uid)
        convs = udata["conversations"]
        existing = convs.get(cid, {})
        convs[cid] = {
            "title": title or existing.get("title") or "Conversation",
            "updated_at": time.time(),
            "pinned": bool(existing.get("pinned", False)),
            **({"needs_replay": True} if existing.get("needs_replay") else {}),
        }
        udata["active_id"] = cid
    _write_conversations(data)
    default_entry = data.get("default", {}).get("conversations", {}).get(cid, {})
    return {"conversation_id": cid, **default_entry}


def _conversation_needs_replay(conversation_id: str | None) -> bool:
    cid = _sanitize_token(conversation_id)
    if not cid:
        return False
    data = _read_conversations()
    for udata in data.values():
        if isinstance(udata, dict):
            entry = (udata.get("conversations") or {}).get(cid)
            if isinstance(entry, dict) and entry.get("needs_replay"):
                return True
    return False


def set_conversation_needs_replay(conversation_id: str, needs_replay: bool) -> None:
    cid = _sanitize_token(conversation_id)
    if not cid:
        return
    data = _read_conversations()
    changed = False
    for udata in data.values():
        if not isinstance(udata, dict):
            continue
        convs = udata.get("conversations")
        if not isinstance(convs, dict) or cid not in convs:
            continue
        entry = dict(convs[cid])
        if needs_replay:
            if not entry.get("needs_replay"):
                entry["needs_replay"] = True
                convs[cid] = entry
                changed = True
        elif "needs_replay" in entry:
            entry.pop("needs_replay", None)
            convs[cid] = entry
            changed = True
    if needs_replay and not changed:
        udata = _ensure_user(data, "default")
        convs = udata["conversations"]
        entry = dict(convs.get(cid) or {"title": "Conversation", "updated_at": time.time(), "pinned": False})
        entry["needs_replay"] = True
        convs[cid] = entry
        changed = True
    if changed:
        _write_conversations(data)


async def set_conversation_needs_replay_async(conversation_id: str, needs_replay: bool) -> None:
    async with _conversations_lock:
        await asyncio.to_thread(set_conversation_needs_replay, conversation_id, needs_replay)


async def save_conversation_async(user_id: str, conversation_id: str, title: str | None = None) -> dict:
    async with _conversations_lock:
        return await asyncio.to_thread(save_conversation, user_id, conversation_id, title)


def get_conversation_id(user_id: str = "default") -> str | None:
    """Retrieve the active conversation ID."""
    uid = _sanitize_token(user_id, "default") or "default"
    data = _read_conversations()
    udata = _ensure_user(data, uid)
    if udata.get("active_id"):
        return udata.get("active_id")
    return data.get("default", {}).get("active_id")


async def get_conversation_id_async(user_id: str = "default") -> str | None:
    async with _conversations_lock:
        return await asyncio.to_thread(get_conversation_id, user_id)


def list_user_conversations(user_id: str = "default") -> tuple[list, str | None]:
    """Return all conversations across the deployment (pinned-first, updated_at desc, active_id)."""
    uid = _sanitize_token(user_id, "default") or "default"
    data = _read_conversations()

    merged_convs = {}
    active_id = None

    if "default" in data and isinstance(data["default"], dict):
        merged_convs.update(data["default"].get("conversations", {}))
        active_id = data["default"].get("active_id")

    if uid in data and isinstance(data[uid], dict):
        for cid, info in data[uid].get("conversations", {}).items():
            if cid not in merged_convs or info.get("updated_at", 0) > merged_convs[cid].get("updated_at", 0):
                merged_convs[cid] = info
        if data[uid].get("active_id"):
            active_id = data[uid].get("active_id")

    for other_uid, udata in data.items():
        if isinstance(udata, dict) and "conversations" in udata:
            for cid, info in udata["conversations"].items():
                if cid not in merged_convs:
                    merged_convs[cid] = info

    items = [
        {"conversation_id": cid, "title": info.get("title") or "Conversation",
         "updated_at": info.get("updated_at") or 0,
         "pinned": bool(info.get("pinned", False))}
        for cid, info in merged_convs.items()
    ]
    items.sort(key=lambda x: (x["pinned"], x["updated_at"]), reverse=True)
    return items, active_id


async def list_user_conversations_async(user_id: str = "default") -> tuple[list, str | None]:
    async with _conversations_lock:
        return await asyncio.to_thread(list_user_conversations, user_id)


def delete_user_conversation(user_id: str, conversation_id: str) -> bool:
    """Delete one conversation across all user stores and message cache."""
    uid = _sanitize_token(user_id, "default") or "default"
    cid = _sanitize_token(conversation_id)
    if not cid:
        return False
    data = _read_conversations()
    deleted = False
    for target_uid in set([uid, "default"] + list(data.keys())):
        udata = data.get(target_uid)
        if isinstance(udata, dict) and "conversations" in udata and cid in udata["conversations"]:
            del udata["conversations"][cid]
            deleted = True
            if udata.get("active_id") == cid:
                remaining = sorted(udata["conversations"].items(), key=lambda kv: kv[1].get("updated_at") or 0, reverse=True)
                udata["active_id"] = remaining[0][0] if remaining else None
    if deleted:
        _write_conversations(data)
        msg_file = MESSAGES_DIR / f"{cid}.json"
        msg_file.unlink(missing_ok=True)
    return deleted


async def delete_user_conversation_async(user_id: str, conversation_id: str) -> bool:
    async with _conversations_lock:
        return await asyncio.to_thread(delete_user_conversation, user_id, conversation_id)


def set_active_conversation(user_id: str, conversation_id: str) -> bool:
    """Mark an existing conversation as active."""
    uid = _sanitize_token(user_id, "default") or "default"
    cid = _sanitize_token(conversation_id)
    if not cid:
        return False
    data = _read_conversations()
    found = False
    for target_uid in set([uid, "default"]):
        udata = _ensure_user(data, target_uid)
        if cid in udata["conversations"]:
            udata["active_id"] = cid
            found = True
    if found:
        _write_conversations(data)
    return found


async def set_active_conversation_async(user_id: str, conversation_id: str) -> bool:
    async with _conversations_lock:
        return await asyncio.to_thread(set_active_conversation, user_id, conversation_id)


def rename_conversation(user_id: str, conversation_id: str, title: str) -> bool:
    """Rename a conversation."""
    uid = _sanitize_token(user_id, "default") or "default"
    cid = _sanitize_token(conversation_id)
    clean_title = (title or "").strip()[:80]
    if not cid or not clean_title:
        return False
    data = _read_conversations()
    found = False
    for target_uid in set([uid, "default"] + list(data.keys())):
        udata = data.get(target_uid)
        if isinstance(udata, dict) and "conversations" in udata and cid in udata["conversations"]:
            udata["conversations"][cid]["title"] = clean_title
            found = True
    if found:
        _write_conversations(data)
    return found


async def rename_conversation_async(user_id: str, conversation_id: str, title: str) -> bool:
    async with _conversations_lock:
        return await asyncio.to_thread(rename_conversation, user_id, conversation_id, title)


def set_conversation_pinned(user_id: str, conversation_id: str, pinned: bool) -> bool:
    """Persist a pin for an existing conversation."""
    uid = _sanitize_token(user_id)
    cid = _sanitize_token(conversation_id)
    if not cid or not isinstance(pinned, bool):
        return False
    data = _read_conversations()
    found = False
    for target_uid in set([uid, "default"] + list(data.keys())):
        if not target_uid:
            continue
        udata = data.get(target_uid)
        if isinstance(udata, dict) and "conversations" in udata and cid in udata["conversations"]:
            udata["conversations"][cid]["pinned"] = pinned
            found = True
    if not found:
        return False
    tmp_file = CONVERSATIONS_FILE.with_suffix(".json.tmp")
    try:
        tmp_file.write_text(json.dumps(data, indent=2))
        tmp_file.replace(CONVERSATIONS_FILE)
    except Exception as exc:
        logger.warning(f"Failed to persist conversation pin: {exc}")
        raise HTTPException(status_code=500, detail="could not save conversation pin") from exc
    return True


async def set_conversation_pinned_async(user_id: str, conversation_id: str, pinned: bool) -> bool:
    async with _conversations_lock:
        return await asyncio.to_thread(set_conversation_pinned, user_id, conversation_id, pinned)


def clear_conversation(user_id: str = "default") -> None:
    """Clear ALL conversations for a user."""
    uid = _sanitize_token(user_id, "default") or "default"
    data = _read_conversations()
    if uid in data:
        del data[uid]
        _write_conversations(data)


async def clear_conversation_async(user_id: str = "default") -> None:
    async with _conversations_lock:
        await asyncio.to_thread(clear_conversation, user_id)


def list_conversations() -> dict:
    """List stored conversation mappings."""
    return _read_conversations()


async def list_conversations_async() -> dict:
    async with _conversations_lock:
        return await asyncio.to_thread(list_conversations)

# --------------------------------------------------------------------------- #
# Path jailing & filesystem browsing
# --------------------------------------------------------------------------- #

_SENSITIVE_DIR_SEGMENTS = frozenset({
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".docker",
    ".git",
    ".svn",
    ".hg",
})

_SENSITIVE_FILENAMES = frozenset({
    "auth.db",
    "auth.db-wal",
    "auth.db-shm",
    "antigravity-oauth-token",
    "oauth_creds.json",
    ".credentials.json",
    "credentials.json",
    ".agychat.env",
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".git-credentials",
    ".bash_history",
    ".zsh_history",
    ".python_history",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "id_dsa",
})


def _is_sensitive_path(resolved_path: str) -> bool:
    """Block credential stores, private keys, auth databases, and .env files."""
    p = Path(resolved_path)
    name_lower = p.name.lower()
    if name_lower in _SENSITIVE_FILENAMES or name_lower.endswith((".env", ".pem", ".key", ".p12", ".pfx")):
        return True
    parts_lower = [seg.lower() for seg in p.parts]
    if any(seg in _SENSITIVE_DIR_SEGMENTS for seg in parts_lower):
        return True
    normalized = resolved_path.replace("\\", "/").lower()
    if "/.gemini/antigravity-cli/accounts" in normalized or "/.codex/auth.json" in normalized:
        return True
    return False


def _within_allowed(path: str | None) -> str | None:
    if not path or not path.strip():
        return None
    rp = os.path.realpath(os.path.expanduser(path.strip()))
    for root in ALLOWED_ROOTS:
        if rp == root or rp.startswith(root + os.sep):
            return rp
    return None


def _is_project_dir(path: str) -> bool:
    return any(
        os.path.exists(os.path.join(path, m))
        for m in (".git", "CLAUDE.md", "AGENTS.md", "package.json", "pyproject.toml", "README.md")
    )


def browse_fs(path: str | None) -> dict:
    """List immediate subdirectories of a jailed path (or allowed roots if path is empty)."""
    if not path:
        entries = [
            {
                "name": os.path.basename(r) or r,
                "path": r,
                "is_project": _is_project_dir(r),
            }
            for r in ALLOWED_ROOTS
            if os.path.isdir(r)
        ]
        return {"path": "", "parent": None, "up": None, "roots": ALLOWED_ROOTS, "entries": entries}

    rp = _within_allowed(path)
    if rp is None or not os.path.isdir(rp) or _is_sensitive_path(rp):
        raise HTTPException(status_code=400, detail="Path outside allowed roots or not a directory")

    entries = []
    try:
        filenames = sorted(os.listdir(rp))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to list directory: {exc}")

    for name in filenames:
        if name.startswith("."):
            continue
        full = os.path.join(rp, name)
        if os.path.isdir(full):
            entries.append({"name": name, "path": full, "is_project": _is_project_dir(full)})

    parent = os.path.dirname(rp)
    up = parent if _within_allowed(parent) is not None else ""
    return {"path": rp, "parent": up, "up": up, "roots": ALLOWED_ROOTS, "entries": entries}

# --------------------------------------------------------------------------- #
# Session auth (form login page + HttpOnly session cookie)
# --------------------------------------------------------------------------- #

BASIC_AUTH_USER = os.getenv("BASIC_AUTH_USER", "")
BASIC_AUTH_PASS = os.getenv("BASIC_AUTH_PASS", "")
_AUTH_ENABLED = bool(BASIC_AUTH_USER and BASIC_AUTH_PASS)

_SESSION_COOKIE = "agy_session"
_SESSION_TTL = 7 * 24 * 3600  # 7 days
_sessions: dict[str, float] = {}  # token -> expiry timestamp
project_updater = ProjectUpdater(Path(__file__).parent, PORT)

# Paths reachable without a session (login page/API, health checks, artwork).
_AUTH_EXEMPT = {"/healthz", "/favicon.ico", "/favicon.png", "/login", "/api/login", "/api/me"}
_AUTH_EXEMPT_PREFIX = ("/static/bg-login.jpg", "/static/bg-chat.jpg", "/static/logo.png")

_LOGIN_RATE_WINDOW_SECONDS = 60.0
_LOGIN_MAX_FAILURES = 10
_login_failures: dict[str, list[float]] = {}
MAX_UPLOAD_BYTES = int(os.getenv("AGY_MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))
_ACTIVE_UPLOAD_EXTENSIONS = frozenset({
    ".html", ".htm", ".xhtml", ".svg", ".xml", ".mhtml", ".js", ".mjs", ".swf",
})


def _client_rate_key(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        first = forwarded.split(",")[0].strip()
        if first:
            return first
    return (request.client.host if request.client else "") or "unknown"


def _check_login_rate_limit(key: str) -> None:
    now = time.monotonic()
    cutoff = now - _LOGIN_RATE_WINDOW_SECONDS
    entries = [ts for ts in _login_failures.get(key, []) if ts > cutoff]
    if entries:
        _login_failures[key] = entries
    else:
        _login_failures.pop(key, None)
    if len(entries) >= _LOGIN_MAX_FAILURES:
        retry_after = max(1, int(entries[0] + _LOGIN_RATE_WINDOW_SECONDS - now) + 1)
        raise HTTPException(
            status_code=429,
            detail="too many login attempts, please retry later",
            headers={"Retry-After": str(retry_after)},
        )


def _record_login_failure(key: str) -> None:
    now = time.monotonic()
    cutoff = now - _LOGIN_RATE_WINDOW_SECONDS
    if len(_login_failures) >= 2048 and key not in _login_failures:
        oldest = next(iter(_login_failures))
        _login_failures.pop(oldest, None)
    entries = [ts for ts in _login_failures.get(key, []) if ts > cutoff]
    entries.append(now)
    _login_failures[key] = entries


def _is_secure_request(request: Request) -> bool:
    forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    if forwarded_proto:
        return forwarded_proto == "https"
    return request.url.scheme == "https"


def _issue_session() -> str:
    now = time.time()
    for t in [t for t, exp in _sessions.items() if exp < now]:
        _sessions.pop(t, None)
    token = secrets.token_urlsafe(32)
    _sessions[token] = now + _SESSION_TTL
    return token


def _valid_session(request: Request) -> bool:
    token = request.cookies.get(_SESSION_COOKIE, "")
    if not token:
        return False
    exp = _sessions.get(token)
    if not exp or exp < time.time():
        _sessions.pop(token, None)
        return False
    return True


def _drop_session(request: Request) -> None:
    token = request.cookies.get(_SESSION_COOKIE, "")
    if token:
        _sessions.pop(token, None)


@app.middleware("http")
async def _session_auth(request: Request, call_next):
    path = request.url.path
    # Optional deployment entry: the native API and legacy UI keep their existing authentication.
    unified_url = os.getenv("AGY_UNIFIED_URL", "").strip()
    if path == "/" and unified_url:
        return RedirectResponse(url=unified_url, status_code=302)
    # A job-scoped read capability lets the initiating browser observe a restart.
    # This endpoint checks its own short-lived token and cannot start updates.
    if request.method == 'GET' and re.fullmatch(r'/api/updates/jobs/[a-f0-9]{32}', path):
        return await call_next(request)
    if _AUTH_ENABLED and path not in _AUTH_EXEMPT and not path.startswith(_AUTH_EXEMPT_PREFIX):
        if not _valid_session(request):
            if path.startswith("/api/"):
                return JSONResponse(status_code=401, content={"detail": "login required"})
            return RedirectResponse(url="/login?next=/legacy" if path == "/legacy" else "/login", status_code=302)
    return await call_next(request)


@app.get('/api/updates')
async def updates_status(check: bool = False):
    return await asyncio.to_thread(project_updater.check if check else project_updater.info)


@app.post('/api/updates/check')
async def updates_check():
    return await asyncio.to_thread(project_updater.check, True)


class UpdateRequest(BaseModel):
    commit: str


@app.post('/api/updates/install', status_code=202)
async def updates_install(request: Request, req: UpdateRequest):
    if not _AUTH_ENABLED or not _valid_session(request):
        raise HTTPException(status_code=403, detail='请先登录，再更新项目。')
    origin = request.headers.get('origin')
    expected = str(request.url).split('/api/', 1)[0]
    if ((origin and origin.rstrip('/') != expected)
            or request.headers.get('x-requested-with') != 'MarchAgent'):
        raise HTTPException(status_code=403, detail='请在本站的更新窗口中操作。')
    if any(turn.status == 'running' for turn in web_turns.turns.values()):
        raise HTTPException(status_code=409, detail='后台任务仍在运行，请完成或明确停止后再更新。')
    try:
        return await asyncio.to_thread(project_updater.start, req.commit)
    except UpdateError as error:
        raise HTTPException(status_code=409, detail=str(error))


@app.get('/api/updates/jobs/{job_id}')
async def updates_job(job_id: str, request: Request):
    try:
        return project_updater.read_job(job_id, request.headers.get('x-update-token', ''))
    except UpdateError as error:
        raise HTTPException(status_code=403, detail=str(error))


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #

app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.api_route("/uploads/{filename:path}", methods=["GET", "HEAD"])
async def serve_upload(filename: str) -> FileResponse:
    if not filename or ".." in filename or filename.startswith(("/", "\\")):
        raise HTTPException(status_code=404, detail="Not found")
    uploads_real = os.path.realpath(str(UPLOADS))
    target_real = os.path.realpath(str(UPLOADS / filename))
    if not (target_real.startswith(uploads_real + os.sep) and os.path.isfile(target_real)):
        raise HTTPException(status_code=404, detail="Not found")
    ext = Path(target_real).suffix.lower()
    headers = {
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
    }
    if ext in _ACTIVE_UPLOAD_EXTENSIONS:
        safe_ascii = "".join(
            c if 32 <= ord(c) < 127 and c not in ('"', "\\") else "_"
            for c in Path(target_real).name
        ) or "download"
        headers["Content-Disposition"] = f'attachment; filename="{safe_ascii}"'
    return FileResponse(path=target_real, headers=headers)


@app.get("/")
@app.get("/legacy")
async def index() -> FileResponse:
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})


@app.get("/login")
async def login_page() -> FileResponse:
    return FileResponse(STATIC / "login.html")


class LoginRequest(BaseModel):
    username: str = ""
    password: str = ""


@app.post("/api/login")
async def api_login(request: Request, req: LoginRequest) -> JSONResponse:
    rate_key = _client_rate_key(request)
    if _AUTH_ENABLED:
        _check_login_rate_limit(rate_key)
        ok = secrets.compare_digest(req.username or "", BASIC_AUTH_USER) and \
            secrets.compare_digest(req.password or "", BASIC_AUTH_PASS)
        if not ok:
            _record_login_failure(rate_key)
            raise HTTPException(status_code=401, detail="invalid credentials")
        _login_failures.pop(rate_key, None)
    token = _issue_session()
    resp = JSONResponse({"ok": True})
    resp.set_cookie(
        _SESSION_COOKIE,
        token,
        max_age=_SESSION_TTL,
        httponly=True,
        samesite="lax",
        secure=_is_secure_request(request),
        path="/",
    )
    return resp


@app.post("/api/logout")
async def api_logout(request: Request) -> JSONResponse:
    _drop_session(request)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(_SESSION_COOKIE, path="/")
    return resp


@app.get("/api/me")
async def api_me(request: Request) -> dict:
    if _AUTH_ENABLED and not _valid_session(request):
        raise HTTPException(status_code=401, detail="login required")
    return {"ok": True, "auth": _AUTH_ENABLED}


@app.api_route("/favicon.ico", methods=["GET", "HEAD"])
async def favicon() -> FileResponse:
    return FileResponse(STATIC / "logo.png", media_type="image/png")


@app.api_route("/favicon.png", methods=["GET", "HEAD"])
async def favicon_png() -> FileResponse:
    return FileResponse(STATIC / "logo.png", media_type="image/png")


@app.post("/api/upload")
async def api_upload(request: Request, file: UploadFile | None = File(None)) -> JSONResponse:
    try:
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                # Allow modest multipart/JSON framing overhead above MAX_UPLOAD_BYTES
                if int(content_length) > int(MAX_UPLOAD_BYTES * 1.4) + 65536:
                    raise HTTPException(status_code=413, detail=f"File too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)}MB)")
            except ValueError:
                pass

        content_type = request.headers.get("content-type", "")
        if "application/json" in content_type:
            payload = await request.json()
            orig_name = Path(payload.get("filename") or "upload.png").name
            data_str = payload.get("data") or ""
            if "," in data_str:
                _, data_str = data_str.split(",", 1)
            if len(data_str) > int(MAX_UPLOAD_BYTES * 1.4) + 1024:
                raise HTTPException(status_code=413, detail=f"File too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)}MB)")
            raw_bytes = base64.b64decode(data_str)
        elif file is not None:
            orig_name = Path(file.filename or "upload").name
            raw_bytes = await file.read(MAX_UPLOAD_BYTES + 1)
        else:
            raise HTTPException(status_code=400, detail="no file or data provided")

        if len(raw_bytes) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail=f"File too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)}MB)")

        clean_stem = "".join(c for c in Path(orig_name).stem if c.isalnum() or c in ("-", "_", " ")).strip() or "file"
        ext = Path(orig_name).suffix.lower()
        if not ext and "application/json" in content_type:
            ext = ".png"
        unique_name = f"{int(time.time())}_{secrets.token_hex(4)}_{clean_stem}{ext}"
        save_path = UPLOADS / unique_name

        await asyncio.to_thread(save_path.write_bytes, raw_bytes)

        file_size = len(raw_bytes)
        is_image = ext in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg")
        return JSONResponse({
            "filename": orig_name,
            "saved_name": unique_name,
            "url": f"/uploads/{unique_name}",
            "path": str(save_path.resolve()),
            "is_image": is_image,
            "size": file_size,
        })
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning(f"Failed to save upload: {exc}")
        raise HTTPException(status_code=500, detail=f"Failed to save upload: {exc}")


@app.get("/api/download")
async def api_download(path: str) -> FileResponse:
    """Download a file from the server directly to the user's client."""
    if not path or not path.strip():
        raise HTTPException(status_code=400, detail="path parameter is required")

    clean_path = urllib.parse.unquote(path.strip())
    if clean_path.startswith("file://"):
        clean_path = re.sub(r"^file://+", "/", clean_path)

    clean_path = clean_path.split("#")[0].split("?")[0]
    candidate = Path(clean_path).expanduser()

    if not candidate.is_absolute():
        if (SCRATCH / clean_path).exists():
            candidate = SCRATCH / clean_path
        elif (UPLOADS / clean_path).exists():
            candidate = UPLOADS / clean_path
        else:
            candidate = SCRATCH / clean_path

    rp = _within_allowed(str(candidate))
    if not rp:
        scratch_real = os.path.realpath(str(SCRATCH))
        uploads_real = os.path.realpath(str(UPLOADS))
        cand_real = os.path.realpath(str(candidate))
        if cand_real == scratch_real or cand_real.startswith(scratch_real + os.sep):
            rp = cand_real
        elif cand_real == uploads_real or cand_real.startswith(uploads_real + os.sep):
            rp = cand_real
        else:
            raise HTTPException(status_code=403, detail="Access denied: path is outside allowed directories")

    if _is_sensitive_path(rp):
        raise HTTPException(status_code=403, detail="Access denied: sensitive file cannot be downloaded")

    if not os.path.exists(rp) or not os.path.isfile(rp):
        raise HTTPException(status_code=404, detail=f"File not found: {Path(clean_path).name}")

    filename = Path(rp).name
    ascii_fallback = "".join(
        c if 32 <= ord(c) < 127 and c not in ('"', "\\") else "_"
        for c in filename
    ).strip() or "download"
    safe_filename = urllib.parse.quote(filename, safe="")
    return FileResponse(
        path=rp,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{safe_filename}",
            "X-Content-Type-Options": "nosniff",
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )


_models_cache: tuple[float, list[dict[str, str]]] | None = None
_account_models_cache: dict[str, tuple[float, list[dict[str, str]]]] = {}
_MODELS_TTL = 300

_models_label_map: dict[str, str] = {
    "gemini-3.8-flash-high": "Gemini 3.8 Flash (High)",
    "gemini-3.8-flash-medium": "Gemini 3.8 Flash (Medium)",
    "gemini-3.8-flash-low": "Gemini 3.8 Flash (Low)",
    "gemini-3.7-flash-high": "Gemini 3.7 Flash (High)",
    "gemini-3.7-flash-medium": "Gemini 3.7 Flash (Medium)",
    "gemini-3.7-flash-low": "Gemini 3.7 Flash (Low)",
    "gemini-3.6-flash-high": "Gemini 3.6 Flash (High)",
    "gemini-3.6-flash-medium": "Gemini 3.6 Flash (Medium)",
    "gemini-3.6-flash-low": "Gemini 3.6 Flash (Low)",
    "gemini-3.1-pro-high": "Gemini 3.1 Pro (High)",
    "gemini-3.1-pro-low": "Gemini 3.1 Pro (Low)",
    "claude-sonnet-4-6": "Claude Sonnet 4.6 (Thinking)",
    "claude-opus-4-6-thinking": "Claude Opus 4.6 (Thinking)",
    "gpt-oss-120b-medium": "GPT-OSS 120B (Medium)",
}


_RETURNED_MODEL_FIELDS = {"modelVersion", "model_version", "responseModel", "response_model"}
_RESPONSE_ID_FIELDS = {"responseId", "response_id", "ResponseID"}


def _new_route_info(request_id: str | None = None, requested_model: str | None = None) -> dict:
    return {"request_id": request_id, "requested_model": requested_model,
            "cli_config_model": None, "cli_reported_model": None, "returned_models": [], "returned_model_fulls": [],
            "response_ids": [], "upstream_urls": [], "trace_ids": [],
            "observed_step_indices": [], "model_step_indices": [], "uncovered_step_indices": [], "coverage_unknown": False,
            "evidence": [], "status": "unavailable"}


def _metadata_url(value: str) -> str | None:
    """Keep only the endpoint; never expose URL credentials or query values."""
    try:
        url = urllib.parse.urlsplit(value)
        if url.scheme not in ("http", "https") or not url.hostname:
            return None
        host = f"[{url.hostname}]" if ":" in url.hostname else url.hostname
        if url.port:
            host += f":{url.port}"
        return urllib.parse.urlunsplit((url.scheme, host, url.path, "", ""))
    except ValueError:
        return None


def _response_evidence(obj: dict) -> list[dict]:
    """Read explicit metadata containers, never response text, tools or configuration."""
    kind = obj.get("event") or obj.get("type") or "metadata"
    if kind not in ("init", "result", "step_update", "metadata", "response_metadata"):
        return []
    scopes = [("", obj)]
    for name in (("init",) if kind == "init" else ("result", "step_update", "metadata")):
        if isinstance(obj.get(name), dict):
            scopes.append((name + ".", obj[name]))
    records = []
    for prefix, payload in scopes:
        containers = [(prefix, payload)]
        if kind != "init" and isinstance(payload.get("response_metadata"), dict):
            containers.append((prefix + "response_metadata.", payload["response_metadata"]))
        for field_prefix, data in containers:
            allowed = {"model"} if kind == "init" else (
                _RETURNED_MODEL_FIELDS | _RESPONSE_ID_FIELDS | {"response_model_full", "responseModelFull", "traceId", "trace_id", "upstream_url"}
                | ({"model"} if kind in ("result", "step_update") else set()))
            for key in sorted(allowed):
                value = data.get(key)
                if not isinstance(value, str) or not value.strip():
                    continue
                if key == "upstream_url":
                    value = _metadata_url(value)
                    if not value:
                        continue
                records.append({"field": field_prefix + key, "value": value,
                                "source": "cli_" + kind})
    return records


def _merge_response_evidence(info: dict, records: list[dict]) -> None:
    for record in records:
        if record in info["evidence"]:
            continue
        info["evidence"].append(record)
        key, value = record["field"].rsplit(".", 1)[-1], record["value"]
        if key in _RETURNED_MODEL_FIELDS and value not in info["returned_models"]:
            info["returned_models"].append(value)
        elif key in ("response_model_full", "responseModelFull") and value not in info["returned_model_fulls"]:
            info["returned_model_fulls"].append(value)
        elif key in _RESPONSE_ID_FIELDS and value not in info["response_ids"]:
            info["response_ids"].append(value)
        elif key == "model":
            target = "cli_config_model" if record["source"] == "cli_init" else "cli_reported_model"
            info[target] = value
        elif key in ("traceId", "trace_id", "Trace"):
            if value not in info["trace_ids"]:
                info["trace_ids"].append(value)
        elif key in ("upstream_url", "URL"):
            if value not in info["upstream_urls"]:
                info["upstream_urls"].append(value)
    count = max(len(info["returned_models"]), len(info["returned_model_fulls"]))
    info["status"] = "conflict" if count > 1 else "available" if count else "unavailable"


def _update_route_coverage(info: dict, response_steps: set[int], coverage_unknown: bool = False) -> None:
    fields = _RETURNED_MODEL_FIELDS | {"response_model_full", "responseModelFull"}
    covered = {index for record in info["evidence"] if record["field"].rsplit(".", 1)[-1] in fields
               for index in record.get("step_indices", []) if index in response_steps}
    info["observed_step_indices"] = sorted(response_steps)
    info["model_step_indices"] = sorted(covered)
    info["uncovered_step_indices"] = sorted(response_steps - covered)
    info["coverage_unknown"] = coverage_unknown
    info["model_conflict"] = max(len(info["returned_models"]), len(info["returned_model_fulls"])) > 1
    if info["status"] in ("available", "conflict") and (coverage_unknown or info["uncovered_step_indices"]):
        info["status"] = "partial"


def _request_log_evidence(log_path: Path) -> list[dict]:
    records = []
    try:
        with log_path.open(errors="replace") as log_file:
            for line in log_file:
                # Unverified log layouts stay unavailable; never scan arbitrary text.
                match = re.fullmatch(r"\[streamGenerateContent\] ResponseID: ([A-Za-z0-9._:-]{1,200})\s*", line)
                if match:
                    records.append({"field": "log.ResponseID", "value": match[1], "source": "request_log"})
    except OSError:
        pass
    return records


def _apply_claude_agy_trace(info: dict, agy_home: str | None, trace: dict) -> None:
    log_records = []
    for value in trace.get("response_ids") or []:
        if isinstance(value, str) and value.strip():
            log_records.append({"field": "log.ResponseID", "value": value.strip(), "source": "agy_acp_log"})
    for value in trace.get("trace_ids") or []:
        if isinstance(value, str) and value.strip():
            log_records.append({"field": "log.Trace", "value": value.strip(), "source": "agy_acp_log"})
    for value in trace.get("upstream_urls") or []:
        if isinstance(value, str):
            url = _metadata_url(value.strip())
            if url:
                log_records.append({"field": "log.URL", "value": url, "source": "agy_acp_log"})
    if log_records:
        _merge_response_evidence(info, log_records)

    session_ids: list[str] = []
    for value in [*(info.get("acp_session_ids") or []), *(trace.get("session_ids") or [])]:
        if isinstance(value, str) and value.strip() and value.strip() not in session_ids:
            session_ids.append(value.strip())
    if session_ids:
        info["acp_session_ids"] = session_ids

    if not agy_home or not session_ids:
        return

    model_fields = _RETURNED_MODEL_FIELDS | {"response_model_full", "responseModelFull"}
    single_response_steps: set[int] = set()
    coverage_unknown = False
    any_uncovered = False
    for sid in session_ids:
        try:
            result = read_acp_session_evidence(agy_home, sid)
        except Exception:
            logger.warning("Could not read claude_agy response metadata")
            coverage_unknown = True
            continue
        records = result["records"]
        if records:
            _merge_response_evidence(info, records)
        resp_steps = result["response_steps"]
        if result["coverage_unknown"]:
            coverage_unknown = True
        if len(session_ids) == 1:
            single_response_steps = resp_steps
        else:
            covered = {
                index
                for record in records
                if record["field"].rsplit(".", 1)[-1] in model_fields
                for index in record.get("step_indices", [])
                if index in resp_steps
            }
            if resp_steps - covered:
                any_uncovered = True

    count = max(len(info["returned_models"]), len(info["returned_model_fulls"]))
    info["status"] = "conflict" if count > 1 else "available" if count else "unavailable"
    if len(session_ids) == 1:
        _update_route_coverage(info, single_response_steps, coverage_unknown)
    else:
        _update_route_coverage(info, set(), coverage_unknown or any_uncovered)


def _claude_agy_candidate_homes() -> list[str]:
    homes = [HOME]
    runtime_home = os.getenv("AGY_RUNTIME_HOME")
    if runtime_home:
        resolved = str(Path(runtime_home).expanduser().resolve())
        if resolved not in homes:
            homes.append(resolved)
    return homes


@app.get("/api/inspect-route")
async def inspect_route_ep() -> dict:
    return {"ok": True, "data": _new_route_info(),
            "message": "请查看对应消息的请求证据；全局日志不能证明该消息的返回模型。"}


class InspectRouteRequest(BaseModel):
    model: str | None = None
    use_armor: StrictBool = False
    use_transam: StrictBool = False
    use_agy_fast: StrictBool = False
    use_claude_agy: StrictBool = False


class ThinkTranslateConfigRequest(BaseModel):
    account_id: str | None = None
    model: str | None = None
    target_lang: str | None = None


class ThinkTranslateRequest(BaseModel):
    text: str
    target_lang: str | None = None
    account_id: str | None = None
    model: str | None = None


class AgyFastConfigRequest(BaseModel):
    auto_update_enabled: StrictBool


class AgyFastUpdateRequest(BaseModel):
    force: StrictBool = False
    only_if_auto_enabled: StrictBool = False


@app.get("/api/agy-fast/status")
async def api_agy_fast_status() -> dict:
    return await asyncio.to_thread(get_agy_fast_status)


@app.post("/api/agy-fast/check-update")
async def api_agy_fast_check_update() -> dict:
    return await asyncio.to_thread(check_agy_fast_update)


@app.post("/api/agy-fast/update")
async def api_agy_fast_update(req: AgyFastUpdateRequest | None = None) -> dict:
    force = bool(req.force) if req else False
    only_auto = bool(req.only_if_auto_enabled) if req else False
    return await asyncio.to_thread(update_agy_fast_plugin, force=force, only_if_auto_enabled=only_auto)


@app.post("/api/agy-fast/config")
async def api_agy_fast_config(req: AgyFastConfigRequest) -> dict:
    return await asyncio.to_thread(set_agy_fast_config, auto_update_enabled=req.auto_update_enabled)


def _think_translate_config_path() -> Path:
    return MESSAGES_DIR.parent / "think_translate_config.json"


def _strip_agy_account_prefix(account_id: str | None) -> str:
    cleaned = (account_id or "").strip()
    if cleaned.startswith("agy:"):
        return cleaned[4:].strip()
    return cleaned


def _pick_cached_fast_translate_model(account_id: str) -> str:
    """When user leaves translation model blank, prefer a cached lightweight Flash model if known."""
    candidates: list[dict[str, str]] = []
    if account_id:
        entry = _account_models_cache.get(account_id)
        if entry and entry[1]:
            candidates = entry[1]
    if not candidates and _models_cache and _models_cache[1]:
        candidates = _models_cache[1]
    if not candidates:
        return ""
    ids = [str(item.get("id") or "").strip() for item in candidates if isinstance(item, dict) and item.get("id")]
    non_orch = [mid for mid in ids if mid and not _is_orchestrator_model(mid, None)]
    for pattern in (r"^gemini-[a-z0-9.]*-flash-low$", r"^gemini-[a-z0-9.]*-flash-medium$", r"^gemini-[a-z0-9.]*-flash"):
        rx = re.compile(pattern, re.IGNORECASE)
        for mid in non_orch:
            if rx.search(mid):
                return mid
    return ""


def _translate_account_tier_rank(tier: str | None) -> int:
    t = (tier or "").strip().lower()
    if "ultra" in t:
        return 0
    if "paid" in t:
        return 1
    if "free" in t:
        return 2
    if "starter" in t:
        return 4
    return 3


def _build_agy_translate_candidates(
    selected_account: str,
    selected_model: str,
    stored_accounts: list[dict[str, Any]],
) -> list[tuple[str, str, bool]]:
    """Build ordered (account_id, model, is_fallback) candidates for resilient thinking translation."""
    clean_model = (selected_model or "").strip()
    if clean_model == "default":
        clean_model = ""
    if clean_model and _is_orchestrator_model(clean_model, None):
        clean_model = ""

    active_id = next((str(a.get("id") or "").strip() for a in stored_accounts if a.get("active")), "")
    primary_acc = selected_account or active_id
    primary_exists = (not primary_acc) or (_resolve_account_file(primary_acc) is not None)

    raw_candidates: list[tuple[str, str, bool]] = []
    if primary_exists:
        primary_effective = clean_model or _pick_cached_fast_translate_model(primary_acc)
        raw_candidates.append((primary_acc, primary_effective, False))
        primary_fast = _pick_cached_fast_translate_model(primary_acc) or "gemini-3.8-flash-low"
        if primary_effective != primary_fast:
            raw_candidates.append((primary_acc, primary_fast, True))

    backups = [
        acc
        for acc in stored_accounts
        if str(acc.get("id") or "").strip() and str(acc.get("id") or "").strip() != primary_acc
    ]
    backups.sort(
        key=lambda acc: (
            0 if acc.get("active") else 1,
            _translate_account_tier_rank(acc.get("subscription_tier")),
        )
    )

    for acc in backups[:4]:
        b_id = str(acc.get("id") or "").strip()
        if not b_id or _resolve_account_file(b_id) is None:
            continue
        b_fast = _pick_cached_fast_translate_model(b_id) or "gemini-3.8-flash-low"
        if clean_model and clean_model != b_fast:
            cached_entry = _account_models_cache.get(b_id)
            cached_ids = {
                str(m.get("id") or "").strip()
                for m in (cached_entry[1] if cached_entry and cached_entry[1] else [])
                if isinstance(m, dict)
            }
            tier_rank = _translate_account_tier_rank(acc.get("subscription_tier"))
            if (cached_ids and clean_model in cached_ids) or (not cached_ids and tier_rank <= 1):
                raw_candidates.append((b_id, clean_model, True))
        raw_candidates.append((b_id, b_fast, True))

    deduped: list[tuple[str, str, bool]] = []
    seen: set[tuple[str, str]] = set()
    for acc_id, mod_id, is_fb in raw_candidates:
        key = (acc_id, mod_id)
        if key in seen:
            continue
        seen.add(key)
        deduped.append((acc_id, mod_id, is_fb))
    return deduped


@app.get("/api/think-translate/config")
async def api_think_translate_config(account_id: str | None = None, lite: bool = False) -> dict:
    cfg = load_think_translate_config(_think_translate_config_path())
    cooldowns = list_active_translate_cooldowns()
    if lite:
        return {
            **cfg,
            "accounts": [],
            "models": [],
            "cooldowns": cooldowns,
        }
    raw_accounts = _list_stored_accounts()
    accounts = [
        {
            **acc,
            "platform": "agy",
            "label": f"agy:{acc.get('email') or acc.get('name') or acc.get('id')}",
        }
        for acc in raw_accounts
    ]
    target_account = _strip_agy_account_prefix(account_id if account_id is not None else cfg.get("account_id"))
    try:
        model_list = await _fetch_account_models(target_account or None)
    except Exception:
        model_list = []
    return {
        **cfg,
        "accounts": accounts,
        "models": model_list,
        "cooldowns": cooldowns,
    }


@app.post("/api/think-translate/config")
async def api_think_translate_save_config(req: ThinkTranslateConfigRequest) -> dict:
    clean_acc = _strip_agy_account_prefix(req.account_id) if req.account_id is not None else None
    if clean_acc:
        if _resolve_account_file(clean_acc) is None:
            raise HTTPException(status_code=404, detail="所选翻译账号不存在，请刷新账号列表后重试。")
    cfg = save_think_translate_config(
        _think_translate_config_path(),
        account_id=clean_acc if req.account_id is not None else None,
        model=req.model,
        target_lang=req.target_lang,
    )
    clear_translate_cooldowns(clean_acc)
    return {"ok": True, **cfg}


@app.post("/api/think-translate/translate")
async def api_think_translate(req: ThinkTranslateRequest) -> dict:
    cfg = load_think_translate_config(_think_translate_config_path())
    selected_account = _strip_agy_account_prefix(
        req.account_id if req.account_id is not None else cfg.get("account_id")
    )
    selected_model = (req.model if req.model is not None else cfg.get("model") or "").strip()
    target_lang = (req.target_lang if req.target_lang is not None else cfg.get("target_lang") or "zh-CN").strip() or "zh-CN"

    stored_accounts = _list_stored_accounts()
    acc_email_map = {
        str(a.get("id") or "").strip(): str(a.get("email") or a.get("name") or a.get("id") or "").strip()
        for a in stored_accounts
    }

    if selected_account and _resolve_account_file(selected_account) is None and not stored_accounts:
        raise HTTPException(status_code=404, detail="配置的翻译账号不存在，请重新选择翻译账号。")

    candidates = _build_agy_translate_candidates(selected_account, selected_model, stored_accounts)
    if not candidates:
        candidates = [("", selected_model if selected_model != "default" else "", False)]

    first_failure_reason: str | None = None
    last_error_message: str | None = None
    failed_accounts_wide: set[str] = set()
    exec_attempts = 0
    max_exec_attempts = 3

    if selected_account and _resolve_account_file(selected_account) is None:
        first_failure_reason = f"原配置账号 {selected_account} 已不存在"

    for cand_acc, cand_model, is_fallback in candidates:
        if cand_acc and cand_acc in failed_accounts_wide:
            continue
        cooldown_msg = get_translate_cooldown_reason(cand_acc, cand_model) if cand_acc else None
        if cooldown_msg:
            if first_failure_reason is None:
                first_failure_reason = cooldown_msg
            last_error_message = cooldown_msg
            continue
        if exec_attempts >= max_exec_attempts:
            break

        exec_attempts += 1
        try:
            run_env = _agy_environment(account_id=cand_acc) if cand_acc else _agy_environment()
        except Exception as exc:
            msg = f"准备翻译账号环境失败：{exc}"
            if first_failure_reason is None:
                first_failure_reason = msg
            last_error_message = msg
            if cand_acc:
                failed_accounts_wide.add(cand_acc)
            continue

        try:
            result = await translate_thinking_text(
                text=req.text,
                target_lang=target_lang,
                account_id=cand_acc,
                model=cand_model,
                agy_bin=AGY_BIN,
                run_env=run_env,
                scratch_dir=SCRATCH,
            )
            used_fallback = bool(is_fallback or first_failure_reason)
            return {
                **result,
                "account_id": cand_acc,
                "account_email": acc_email_map.get(cand_acc, cand_acc),
                "requested_account_id": selected_account,
                "requested_model": selected_model,
                "fallback_used": used_fallback,
                "fallback_reason": first_failure_reason if used_fallback else None,
            }
        except TranslateCallError as exc:
            msg = str(exc)
            if first_failure_reason is None:
                first_failure_reason = msg
            last_error_message = msg
            if exc.account_wide and cand_acc:
                failed_accounts_wide.add(cand_acc)
            elif exc.category not in {"quota_exhausted", "auth_error", "model_unavailable", "timeout", "empty_output"}:
                break
        except RuntimeError as exc:
            msg = str(exc)
            if first_failure_reason is None:
                first_failure_reason = msg
            last_error_message = msg
        finally:
            if cand_acc:
                _sync_account_home_token_to_storage(cand_acc)

    detail_msg = last_error_message or first_failure_reason or "思考翻译失败，请检查可用账号额度与模型状态。"
    raise HTTPException(status_code=502, detail=detail_msg) from None


def _resolve_agy_fast_turn() -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    cfg = get_agy_fast_mcp_config()
    if not cfg.get("installed"):
        return cfg, None
    st = get_agy_fast_status()
    meta = {
        "enabled": True,
        "version": st.get("installed_version"),
        "server_name": cfg.get("server_name"),
        "tools": cfg.get("tools", []),
    }
    return cfg, meta


def _compose_system_append(
    base_system: str | None,
    *,
    use_armor: bool = False,
    use_transam: bool = False,
    use_agy_fast: bool = False,
    agy_fast_mode: str = "acp",
    target_cwd: str | None = None,
    include_agy_fast_snapshot: bool = True,
    agy_fast_session_key: str | None = None,
    agent_tools: bool = False,
    model: str | None = None,
    model_label: str | None = None,
    is_continue: bool = False,
) -> str | None:
    parts: list[str] = []
    if base_system and base_system.strip():
        parts.append(base_system.strip())
    if use_armor:
        parts.append(get_armor_system_directive(agent_tools=agent_tools, transam=use_transam))
    if use_transam:
        parts.append(get_transam_system_directive(model, model_label, is_continue=is_continue))
    if use_agy_fast:
        fast_dir = get_agy_fast_system_directive(
            mode=agy_fast_mode,
            target_cwd=target_cwd,
            include_snapshot=include_agy_fast_snapshot,
            session_key=agy_fast_session_key,
        )
        if fast_dir:
            parts.append(fast_dir)
    return "\n\n".join(parts) if parts else None


async def _compose_system_append_async(
    base_system: str | None,
    **kwargs: Any,
) -> str | None:
    if kwargs.get("use_agy_fast"):
        return await asyncio.to_thread(_compose_system_append, base_system, **kwargs)
    return _compose_system_append(base_system, **kwargs)


@app.post("/api/inspect-route")
async def inspect_selected_route(req: InspectRouteRequest) -> dict:
    """Fresh synthetic request; never continue or persist a human conversation."""
    info = _new_route_info(requested_model=req.model)
    agy_fast_probe_meta: dict[str, Any] | None = None
    if req.use_agy_fast:
        _, agy_fast_probe_meta = await asyncio.to_thread(_resolve_agy_fast_turn)
        if agy_fast_probe_meta is None:
            agy_fast_probe_meta = {"enabled": False, "error": "not_installed"}

    def _StampProbeFlags(target: dict[str, Any], effective_model: str | None) -> None:
        if req.use_transam:
            target["transam"] = {"enabled": True, "tier": resolve_transam_tier(effective_model, None)}
        if agy_fast_probe_meta is not None:
            target["agy_fast"] = dict(agy_fast_probe_meta)

    _StampProbeFlags(info, req.model)
    failed = False
    async def collect(folder):
        nonlocal info, failed
        if req.use_claude_agy:
            requested_model = (req.model or "").strip()
            model = requested_model if requested_model and requested_model != "default" else await _default_claude_agy_model()
            run_env = _agy_environment()
            agy_home = run_env.get("HOME") or HOME
            active_output_style = resolve_active_claude_output_style(run_env, folder)
            if _is_orchestrator_model(model, None):
                async for event in stream_agy_acp(
                    agy_bin=AGY_BIN,
                    prompt="Reply only OK. Do not use tools or access files.",
                    model=model,
                    target_cwd=folder,
                    run_env=run_env,
                    scratch_dir=SCRATCH,
                    persist_conversation=False,
                    route_info_factory=lambda rid, m: {
                        **_new_route_info(rid, m),
                        "transport": "acp",
                        "prompt_mode": "claude_code_enhanced",
                        **({"output_style": active_output_style["name"]} if active_output_style else {}),
                    },
                    route_enricher=lambda r, trace: _apply_claude_agy_trace(r, agy_home, trace),
                    system_append=_compose_system_append(
                        _claude_agy_orchestrator_system_append(None, output_style=active_output_style),
                        use_armor=req.use_armor,
                        use_transam=False,
                        agent_tools=True,
                        model=model,
                    ),
                    use_armor=req.use_armor,
                ):
                    if isinstance(event.get("route_info"), dict):
                        info = event["route_info"]
                        _StampProbeFlags(info, model)
                    if event.get("event") == "error":
                        failed = True
                return
            info["transport"] = "claude_agy"
            info["cli_config_model"] = model
            if active_output_style:
                info["output_style"] = active_output_style["name"]
            if req.use_armor:
                info["armor"] = {"enabled": True, "status": "armed", "retries": 0}
            _StampProbeFlags(info, model)
            async for event in stream_claude_agy(
                agy_bin=AGY_BIN,
                env=run_env,
                cwd=folder,
                scratch=SCRATCH,
                prompt="Reply only OK. Do not use tools or access files.",
                model=model,
                turn_id=info["request_id"],
                sandbox=AGY_SANDBOX,
                system_append=_compose_system_append(
                    None,
                    use_armor=req.use_armor,
                    use_transam=False,
                    agent_tools=True,
                    model=model,
                ),
                use_armor=req.use_armor,
            ):
                if event.get("event") == "armor_status":
                    info["armor"] = {"enabled": True, "status": event.get("status", "armed"), "retries": int(event.get("retries") or 0)}
                elif event.get("event") == "agy_trace":
                    await asyncio.to_thread(_apply_claude_agy_trace, info, agy_home, event)
                elif event.get("event") == "error":
                    failed = True
            return

        async for event in _stream_agy(
            prompt="Reply only OK. Do not use tools or access files.",
            model=req.model,
            cwd=folder,
            persist_conversation=False,
            system_append=_compose_system_append(
                None,
                use_armor=req.use_armor,
                use_transam=False,
                agent_tools=True,
                model=req.model,
            ),
            use_armor=req.use_armor,
        ):
            if isinstance(event.get("route_info"), dict):
                info = event["route_info"]
                _StampProbeFlags(info, req.model)
            if event.get("event") == "error":
                failed = True
    try:
        with tempfile.TemporaryDirectory(prefix="agy-model-check-", dir=str(SCRATCH)) as folder:
            await asyncio.wait_for(collect(folder), timeout=90)
    except asyncio.TimeoutError:
        return {"ok": False, "data": info, "message": "检测超时，请稍后重试。"}
    except Exception:
        logger.warning("Selected-model inspection failed")
        failed = True
    return {"ok": not failed, "data": info, "message": "CLI 未完成本次检测，请稍后重试。" if failed
            else "本次没有返回可关联的模型名。" if info["status"] == "unavailable" else "本次检测已完成。"}



# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #

class Message(BaseModel):
    role: str
    content: str = ""
    attachments: list[dict] | None = None


class ApiConnection(BaseModel):
    """Server-resolved credentials held only by this turn's in-memory stream closure."""
    base_url: str = Field(min_length=1, max_length=1000)
    api_key: SecretStr
    proxy_port: int = Field(default=0, ge=0, le=65535)
    chat_compat: bool = False


class ChatRequest(BaseModel):
    messages: list[Message]
    model: str | None = None
    system: str | None = None
    cwd: str | None = None
    conversation_id: str | None = None
    continue_conversation: bool | None = None
    user_id: str | None = "default"
    thinking: bool | None = None
    turn_id: str | None = None
    message_snapshot: list[dict] | None = None
    model_label: str | None = None
    history_revision: str | None = None
    stream: StrictBool = False
    stream_options: dict[str, Any] | None = None
    api_connection: ApiConnection | None = None
    use_claude_agy: StrictBool = False
    use_armor: StrictBool = False
    use_transam: StrictBool = False
    use_agy_fast: StrictBool = False
    account_id: str | None = None


def _api_environment(env: dict[str, str], api: ApiConnection) -> dict[str, str]:
    """Pin API and egress settings on a child process without changing saved Google profiles."""
    result = {key: value for key, value in env.items()
              if not re.match(r"^(?:(?:http|https|all|ws|wss|no)_proxy|node_use_env_proxy)$", key, re.I)
              and key not in {"GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "AGY_ADC_AUTH"}}
    if api.proxy_port:
        proxy = f"http://127.0.0.1:{api.proxy_port}"
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            result[key] = proxy
    result.update(GEMINI_API_KEY=api.api_key.get_secret_value(), GOOGLE_GEMINI_BASE_URL=api.base_url,
                  NO_PROXY="localhost,127.0.0.1,::1", no_proxy="localhost,127.0.0.1,::1")
    return result


def _redact_api_event(value, secret: str):
    if isinstance(value, str):
        return value.replace(secret, "[密钥已隐藏]") if secret else value
    if isinstance(value, list):
        return [_redact_api_event(item, secret) for item in value]
    if isinstance(value, dict):
        return {key: _redact_api_event(item, secret) for key, item in value.items()}
    return value


# --------------------------------------------------------------------------- #
# agy invocation
# --------------------------------------------------------------------------- #

THINKING_PROMPT_PREFIX = (
    "[回答时可先简要说明解题思路或理由，再给出最终答案。]"
)


def _format_message_content(m: Message) -> str:
    content = (m.content or "").strip()
    if m.attachments:
        att_lines = []
        for att in m.attachments:
            if not isinstance(att, dict):
                continue
            name = att.get("filename") or att.get("name") or "file"
            path = att.get("path") or att.get("url") or ""
            mime = str(att.get("mimeType") or "")
            is_img = bool(att.get("is_image") or mime.startswith("image/"))
            if is_img:
                att_lines.append(f"[附带图片: {name} (本地路径: {path})。请使用相应工具查看此图片内容并作答。]")
            else:
                att_lines.append(f"[附带文件: {name} (本地路径: {path})。请使用相应工具查看此文件内容并作答。]")
        if att_lines:
            prefix = "\n".join(att_lines)
            content = f"{prefix}\n\n{content}" if content else prefix
    return content


def _render_prompt(messages: list[Message], system: str | None, thinking: bool | None = None) -> str:
    """Flatten a chat history into a single prompt for agy print mode."""
    sys_txt = (system or DEFAULT_SYSTEM).strip()
    if thinking:
        sys_txt = f"{sys_txt}\n\n{THINKING_PROMPT_PREFIX}"
    lines = [sys_txt, "", "--- Conversation so far ---"]
    for m in messages:
        role = {"user": "User", "assistant": "Assistant", "system": "System"}.get(
            m.role, m.role.capitalize()
        )
        lines.append(f"{role}: {_format_message_content(m)}")
    lines.append("--- End conversation ---")
    lines.append("")
    lines.append("Reply as the Assistant to the last User message. "
                 "Output only your reply, with no role prefix.")
    return "\n".join(lines)


async def _resolve_prompt_and_session(req: ChatRequest) -> tuple[str, str | None, bool, str]:
    user_id = _sanitize_token(req.user_id, "default") or "default"
    cid = _sanitize_token(req.conversation_id)

    if not AGY_PERSIST_CONVERSATIONS:
        cid = None

    if AGY_PERSIST_CONVERSATIONS and not cid and req.continue_conversation:
        cid = await get_conversation_id_async(user_id)

    if cid or req.continue_conversation:
        base_prompt = _format_message_content(req.messages[-1]) if req.messages else ""
        continue_last = not cid and bool(req.continue_conversation)
        if req.thinking and base_prompt:
            prompt = f"{THINKING_PROMPT_PREFIX}\n\n{base_prompt}"
        else:
            prompt = base_prompt
    else:
        prompt = _render_prompt(req.messages, req.system, thinking=req.thinking)
        continue_last = False

    return prompt, cid, continue_last, user_id


def _build_argv(
    model: str | None,
    prompt: str = "",
    conversation_id: str | None = None,
    continue_last: bool = False,
    target_cwd: str | None = None,
    effort: str | None = None,
    timeout: int | None = None,
) -> list[str]:
    # agy treats the token after -p as its prompt, even when that token is a flag.
    # Attach the prompt to -p so permission and output flags cannot be swallowed.
    argv = [AGY_BIN, "--dangerously-skip-permissions"]
    if AGY_OUTPUT_FORMAT:
        argv += ["--output-format", AGY_OUTPUT_FORMAT]
    if effort:
        argv += ["--effort", effort]
    if AGY_SANDBOX:
        argv.append("--sandbox")
    if target_cwd:
        argv += ["--add-dir", target_cwd]
    if model and model.strip() and model != "default":
        argv += ["--model", model]
    clean_cid = _sanitize_token(conversation_id)
    if clean_cid:
        argv += ["--conversation", clean_cid]
    elif continue_last:
        argv.append("--continue")
    argv += ["--print-timeout", f"{AGY_TIMEOUT if timeout is None else timeout}s"]
    if prompt:
        argv.append(f"-p={prompt}")
    return argv


from egress import egress_environment


_active_account_turns: dict[str, int] = {}
_active_armor_turns: dict[str, int] = {}
_armor_cleanup_deferred: set[str] = set()


def _resolve_home_key(home_path: str | None) -> str:
    if not home_path:
        return ""
    try:
        return str(Path(home_path).expanduser().resolve())
    except Exception:
        return str(home_path)


def _sync_armor_rules_concurrency_safe(
    enabled: bool,
    *,
    target_cwd: str | None,
    agy_home: str | None,
) -> str:
    """Sync 00-armor.md without deleting a home rule still used by another active Armor turn."""
    home_key = _resolve_home_key(agy_home)
    if enabled:
        if home_key:
            _active_armor_turns[home_key] = _active_armor_turns.get(home_key, 0) + 1
            _armor_cleanup_deferred.discard(home_key)
        sync_armor_rules(True, target_cwd=target_cwd, agy_home=agy_home)
        return home_key

    # Always keep target_cwd clean; only clean homes with zero active Armor turns.
    candidates = [agy_home, *_claude_agy_candidate_homes()]
    idle_homes: list[str] = []
    for candidate in candidates:
        ckey = _resolve_home_key(candidate)
        if not ckey:
            continue
        if _active_armor_turns.get(ckey, 0) > 0:
            _armor_cleanup_deferred.add(ckey)
        elif ckey not in idle_homes:
            idle_homes.append(ckey)
    sync_armor_rules(False, target_cwd=target_cwd, agy_home=None, extra_homes=idle_homes)
    return ""


def _release_armor_turn_home(home_key: str) -> None:
    if not home_key:
        return
    remaining = _active_armor_turns.get(home_key, 1) - 1
    if remaining > 0:
        _active_armor_turns[home_key] = remaining
        return
    _active_armor_turns.pop(home_key, None)
    if home_key in _armor_cleanup_deferred:
        _armor_cleanup_deferred.discard(home_key)
        sync_armor_rules(False, target_cwd=None, agy_home=home_key)


_active_transam_turns: dict[str, int] = {}
_transam_cleanup_deferred: set[str] = set()


def _sync_transam_rules_concurrency_safe(
    enabled: bool,
    *,
    target_cwd: str | None,
    agy_home: str | None,
    model: str | None = None,
    model_label: str | None = None,
) -> str:
    """Sync 01-transam.md without deleting a home rule still used by another active TRANS-AM turn."""
    home_key = _resolve_home_key(agy_home)
    if enabled:
        if home_key:
            _active_transam_turns[home_key] = _active_transam_turns.get(home_key, 0) + 1
            _transam_cleanup_deferred.discard(home_key)
        sync_transam_rules(
            True,
            target_cwd=target_cwd,
            agy_home=agy_home,
            model=model,
            model_label=model_label,
        )
        return home_key

    candidates = [agy_home, *_claude_agy_candidate_homes()]
    idle_homes: list[str] = []
    for candidate in candidates:
        ckey = _resolve_home_key(candidate)
        if not ckey:
            continue
        if _active_transam_turns.get(ckey, 0) > 0:
            _transam_cleanup_deferred.add(ckey)
        elif ckey not in idle_homes:
            idle_homes.append(ckey)
    sync_transam_rules(False, target_cwd=target_cwd, agy_home=None, extra_homes=idle_homes)
    return ""


def _release_transam_turn_home(home_key: str) -> None:
    if not home_key:
        return
    remaining = _active_transam_turns.get(home_key, 1) - 1
    if remaining > 0:
        _active_transam_turns[home_key] = remaining
        return
    _active_transam_turns.pop(home_key, None)
    if home_key in _transam_cleanup_deferred:
        _transam_cleanup_deferred.discard(home_key)
        sync_transam_rules(False, target_cwd=None, agy_home=home_key)
_SHARED_AGY_CLI_DIRS = (
    "conversations",
    "brain",
    "annotations",
    "implicit",
    "presence",
    "bin",
    "builtin",
    "cache",
    "mcp",
)
_SHARED_AGY_CLI_FILES = ("installation_id", "settings.json")


def _ensure_symlink(link_path: Path, target_path: Path) -> None:
    link_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        if link_path.is_symlink() and link_path.resolve() == target_path.resolve():
            return
    except OSError:
        pass
    if link_path.exists() and not link_path.is_symlink():
        return
    tmp_link = link_path.with_name(f".{link_path.name}.{uuid.uuid4().hex}.tmp")
    try:
        tmp_link.symlink_to(target_path)
        os.replace(tmp_link, link_path)
    finally:
        if tmp_link.is_symlink() or tmp_link.exists():
            try:
                tmp_link.unlink()
            except OSError:
                pass


def _write_mcp_config(source_home: Path, runtime_home: Path) -> None:
    runtime_config = runtime_home / ".gemini" / "config"
    if not AGY_DISABLE_MCP and not AGY_DISABLED_MCP_SERVERS:
        source_config_dir = source_home / ".gemini" / "config"
        if source_config_dir.exists():
            _ensure_symlink(runtime_config, source_config_dir)
        return
    if runtime_config.is_symlink():
        runtime_config.unlink(missing_ok=True)
    runtime_config.mkdir(parents=True, exist_ok=True)
    mcp_config = {"mcpServers": {}}
    if not AGY_DISABLE_MCP:
        source_config = source_home / ".gemini" / "config" / "mcp_config.json"
        try:
            source_data = json.loads(source_config.read_text())
            servers = source_data.get("mcpServers", {})
            if isinstance(servers, dict):
                mcp_config = {
                    **source_data,
                    "mcpServers": {
                        name: config
                        for name, config in servers.items()
                        if name.lower() not in AGY_DISABLED_MCP_SERVERS
                    },
                }
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("Failed to filter agy MCP config %s: %s", source_config, exc)
    tmp_mcp = runtime_config / f"mcp_config.{uuid.uuid4().hex}.tmp"
    tmp_mcp.write_text(json.dumps(mcp_config, indent=2) + "\n")
    tmp_mcp.replace(runtime_config / "mcp_config.json")


def _account_homes_root() -> Path:
    return Path(os.getenv("AGY_ACCOUNT_HOMES_DIR", str(SCRATCH / ".agy-account-homes"))).expanduser().resolve()


def _account_home_dir(account_id: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._@-]", "_", account_id)[:48] or "account"
    digest = hashlib.sha256(account_id.encode("utf-8")).hexdigest()[:10]
    return _account_homes_root() / f"{safe}-{digest}"


def _atomic_write_json(path: Path, payload: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(payload)
    tmp.chmod(0o600)
    tmp.replace(path)


def _sync_account_home_token_to_storage(account_id: str) -> None:
    """Persist any refreshed OAuth token from an isolated account home back to storage."""
    target_file = _resolve_account_file(account_id)
    if not target_file or not target_file.exists():
        return
    account_token = _account_home_dir(target_file.stem) / ".gemini" / "antigravity-cli" / "antigravity-oauth-token"
    if not account_token.exists() or account_token.is_symlink():
        return
    try:
        home_data = json.loads(account_token.read_text())
        if not _has_valid_token(home_data):
            return
        stored_data = json.loads(target_file.read_text())
        if not _same_account(home_data, stored_data):
            return
        merged = {**stored_data, **home_data}
        if merged != stored_data:
            _atomic_write_json(target_file, json.dumps(merged, indent=2) + "\n")
        if ACTIVE_TOKEN_FILE.exists():
            try:
                active_data = json.loads(ACTIVE_TOKEN_FILE.read_text())
                if _same_account(active_data, merged):
                    active_merged = {**active_data, **merged}
                    if active_merged != active_data:
                        _atomic_write_json(ACTIVE_TOKEN_FILE, json.dumps(active_merged, indent=2) + "\n")
            except Exception:
                pass
    except Exception as exc:
        logger.warning("Failed to sync isolated account token for %s: %s", account_id, exc)


def _prepare_account_home(account_id: str) -> Path:
    """Prepare an isolated HOME for one agy account while sharing conversation transcripts."""
    target_file = _resolve_account_file(account_id)
    if not target_file or not target_file.exists():
        raise HTTPException(status_code=404, detail=f"账号 '{account_id}' 不存在")
    content = target_file.read_text()
    target_data = json.loads(content)
    if not _has_valid_token(target_data):
        raise HTTPException(status_code=400, detail=f"账号 '{account_id}' 凭证无效")

    canonical_id = target_file.stem
    account_home = _account_home_dir(canonical_id)
    account_cli_dir = account_home / ".gemini" / "antigravity-cli"
    account_home.mkdir(parents=True, exist_ok=True, mode=0o700)
    account_cli_dir.mkdir(parents=True, exist_ok=True, mode=0o700)

    source_home = Path(HOME).expanduser().resolve()
    source_cli_dir = source_home / ".gemini" / "antigravity-cli"
    if source_cli_dir.exists():
        for name in _SHARED_AGY_CLI_DIRS:
            src = source_cli_dir / name
            if name in ("conversations", "brain", "annotations", "implicit", "presence"):
                src.mkdir(parents=True, exist_ok=True)
            if src.exists():
                _ensure_symlink(account_cli_dir / name, src)
        for name in _SHARED_AGY_CLI_FILES:
            src = source_cli_dir / name
            if src.exists():
                _ensure_symlink(account_cli_dir / name, src)

    _write_mcp_config(source_home, account_home)

    account_token = account_cli_dir / "antigravity-oauth-token"
    if account_token.is_symlink():
        account_token.unlink(missing_ok=True)

    needs_write = True
    if account_token.exists():
        try:
            existing_data = json.loads(account_token.read_text())
            if _same_account(existing_data, target_data):
                if _active_account_turns.get(canonical_id, 0) > 0:
                    needs_write = False
                elif account_token.stat().st_mtime_ns > target_file.stat().st_mtime_ns:
                    needs_write = False
                    _sync_account_home_token_to_storage(canonical_id)
        except Exception:
            needs_write = True
    if needs_write:
        _atomic_write_json(account_token, content)

    return account_home


def _agy_environment(account_id: str | None = None) -> dict[str, str]:
    """Run chat turns with per-account credential isolation and optional MCP filtering."""
    env = egress_environment(os.environ.copy())

    effective_account = account_id
    if not effective_account and ACTIVE_TOKEN_FILE.exists():
        effective_account = _active_account_id()
    if effective_account:
        try:
            account_home = _prepare_account_home(effective_account)
            env["HOME"] = str(account_home)
            return env
        except HTTPException:
            if account_id:
                raise
        except Exception as exc:
            logger.warning("Failed to prepare isolated agy home for %s: %s", effective_account, exc)
            if account_id:
                raise

    if not AGY_DISABLE_MCP and not AGY_DISABLED_MCP_SERVERS:
        return env

    source_home = Path(os.path.expanduser("~")).resolve()
    token_source = source_home / ".gemini" / "antigravity-cli" / "antigravity-oauth-token"
    if not token_source.exists():
        logger.warning("AGY_DISABLE_MCP is enabled but no agy OAuth token was found; using the current HOME")
        return env

    runtime_home = Path(os.getenv("AGY_RUNTIME_HOME", str(SCRATCH / ".agy-home"))).expanduser().resolve()
    if runtime_home == source_home:
        logger.warning("AGY_RUNTIME_HOME points at HOME; MCP isolation is disabled")
        return env

    _write_mcp_config(source_home, runtime_home)

    # Reuse the user's token without copying credentials into the runtime directory.
    runtime_token = runtime_home / ".gemini" / "antigravity-cli" / "antigravity-oauth-token"
    _ensure_symlink(runtime_token, token_source)

    source_installation_id = source_home / ".gemini" / "antigravity-cli" / "installation_id"
    if source_installation_id.exists():
        runtime_installation_id = runtime_home / ".gemini" / "antigravity-cli" / "installation_id"
        _ensure_symlink(runtime_installation_id, source_installation_id)

    env["HOME"] = str(runtime_home)
    return env


def _parse_ndjson_line(line_str: str) -> list[dict]:
    events: list[dict] = []
    line_clean = line_str.strip()
    if not line_clean:
        return events
    try:
        obj = json.loads(line_clean)
        if not isinstance(obj, dict):
            return [{"event": "delta", "delta": str(obj)}]

        def parse_tool(payload: dict) -> dict:
            tool_info = payload.get("tool_info")
            tool_name = payload.get("tool_name") or payload.get("tool") or payload.get("name")
            args = payload.get("args") or payload.get("input")
            tool_id = payload.get("tool_id") or payload.get("toolId") or payload.get("id")
            if isinstance(tool_info, dict):
                tool_name = tool_name or tool_info.get("name")
                args = args or tool_info.get("parameters") or tool_info.get("input")
                tool_id = tool_id or tool_info.get("id")
            out = {
                "event": "tool",
                "tool": tool_name,
                "tool_name": tool_name,
                "args": args,
                "tool_input": args,
                "status": payload.get("status") or payload.get("state") or "executing",
            }
            if tool_id:
                out["tool_id"] = str(tool_id)
            return out

        ev_type = obj.get("event") or obj.get("type")

        if ev_type == "init":
            init_obj = obj.get("init")
            cid = obj.get("conversation_id") or (
                init_obj.get("conversation_id") if isinstance(init_obj, dict) else None
            )
            model_val = (
                init_obj.get("model") if isinstance(init_obj, dict) else None
            ) or obj.get("model")
            init_ev = {"event": "init", "conversation_id": cid, "_cli_init_cid": cid}
            if model_val:
                init_ev["model"] = model_val
            events.append(init_ev)

        elif ev_type == "thinking":
            thinking = obj.get("thinking") or obj.get("thought") or obj.get("reasoning_content") or obj.get("thinking_delta") or obj.get("delta")
            if thinking:
                events.append({"event": "thinking", "thinking": thinking})

        elif ev_type in ("tool_call", "tool"):
            events.append(parse_tool(obj))

        elif ev_type == "error":
            error = obj.get("error") or obj.get("message") or "agy generation failed"
            if isinstance(error, dict):
                error = error.get("message") or json.dumps(error, ensure_ascii=False)
            events.append({"event": "error", "error": str(error)})

        elif ev_type == "step_update":
            step = obj.get("step_update") or {}
            if not isinstance(step, dict):
                step = {}
            stype = step.get("step_type")
            if stype == "thinking":
                thinking = step.get("thinking") or step.get("thinking_delta") or step.get("text_delta") or step.get("delta")
                if thinking:
                    events.append({"event": "thinking", "thinking": thinking})
            elif stype == "agent_response":
                delta = step.get("text_delta") or step.get("delta")
                if delta:
                    events.append({"event": "delta", "delta": delta})
                thinking = (
                    step.get("thinking")
                    or step.get("thought")
                    or step.get("reasoning_content")
                    or step.get("thinking_delta")
                )
                if thinking:
                    events.append({"event": "thinking", "thinking": thinking})
                if step.get("usage"):
                    res_ev = {"event": "result", "usage": step["usage"], "status": step.get("state") or "completed"}
                    if step.get("duration_seconds") is not None:
                        res_ev["duration_seconds"] = step["duration_seconds"]
                    events.append(res_ev)
            elif stype in ("tool", "tool_call") or any(key in step for key in ("tool", "tool_name", "tool_info")):
                events.append(parse_tool(step))
            else:
                delta = step.get("text_delta") or step.get("delta")
                if delta:
                    events.append({"event": "delta", "delta": delta})
                thinking = step.get("thinking") or step.get("thought") or step.get("reasoning_content") or step.get("thinking_delta")
                if thinking:
                    events.append({"event": "thinking", "thinking": thinking})

        elif ev_type == "result":
            res = obj.get("result")
            if not isinstance(res, dict):
                res = {}
            usage = res.get("usage") or obj.get("usage")
            status = res.get("status") or obj.get("status") or "completed"
            response = res.get("response")
            cid = res.get("conversation_id") or obj.get("conversation_id")
            model_val = res.get("model") or obj.get("model")
            dur_val = res.get("duration_seconds") or obj.get("duration_seconds")
            thinking = next((payload[key] for payload in (res, obj)
                             for key in ("thinking", "thought", "reasoning_content", "thinking_delta")
                             if payload.get(key)), None)
            if thinking:
                events.append({"event": "thinking", "thinking": thinking})
            result_event = {"event": "result", "usage": usage, "status": status}
            if model_val:
                result_event["model"] = model_val
            if dur_val is not None:
                result_event["duration_seconds"] = dur_val
            if response:
                result_event["response"] = str(response)
            if cid:
                result_event["conversation_id"] = cid
            events.append(result_event)
            if str(status).upper() not in ("SUCCESS", "COMPLETED", "OK", "DONE"):
                error = res.get("error") or obj.get("error") or res.get("response") or f"agy result status: {status}"
                events.append({"event": "error", "error": str(error), "_result_error": True})

        else:
            delta = obj.get("text_delta") or obj.get("delta") or obj.get("text")
            if delta:
                events.append({"event": "delta", "delta": delta})
            thinking = obj.get("thinking") or obj.get("thought") or obj.get("reasoning_content")
            if thinking:
                events.append({"event": "thinking", "thinking": thinking})
            cid = obj.get("conversation_id")
            if cid:
                events.append({"event": "init", "conversation_id": cid})
        records = _response_evidence(obj)
        index = (obj.get("step_update", {}).get("step_index") if ev_type == "step_update"
                 and isinstance(obj.get("step_update"), dict) else obj.get("step_index"))
        if ev_type == "result" and isinstance(obj.get("result"), dict):
            index = obj["result"].get("step_index", index)
        if isinstance(index, int) and not isinstance(index, bool) and 0 <= index < (1 << 31):
            for event in events:
                if event.get("event") == "thinking":
                    event["step_index"] = index
        if ev_type == "step_update" and isinstance(obj.get("step_update"), dict):
            if not events:
                events.append({"event": "metadata"})
            events[0]["_step_index"] = obj["step_update"].get("step_index")
            events[0]["_step_type"] = obj["step_update"].get("step_type")
            index = obj["step_update"].get("step_index")
            if isinstance(index, int) and not isinstance(index, bool) and index >= 0:
                for record in records:
                    if record["field"].startswith("step_update."):
                        record["step_indices"] = [index]
        if records:
            if not events:
                events.append({"event": "metadata"})
            events[0]["_response_evidence"] = records
    except json.JSONDecodeError:
        events.append({"event": "delta", "delta": line_str + "\n"})
    return events


async def _stream_agy(
    prompt: str,
    model: str | None,
    cwd: str | None = None,
    conversation_id: str | None = None,
    continue_last: bool = False,
    user_id: str = "default",
    effort: str | None = None,
    persist_conversation: bool = True,
    timeout: int | None = None,
    api_connection: ApiConnection | None = None,
    fallback_prompt: str | None = None,
    system_append: str | None = None,
    register_injector=None,
    account_id: str | None = None,
    use_armor: bool = False,
    mcp_servers: list[dict[str, Any]] | None = None,
    agy_fast_info: dict[str, Any] | None = None,
):
    """Run agy and yield structured events (dict) as NDJSON or text chunks arrive."""
    turn_timeout = AGY_TIMEOUT if timeout is None else timeout
    target_cwd = _within_allowed(cwd) if cwd else None
    if not target_cwd:
        target_cwd = str(SCRATCH)

    if api_connection is None:
        run_env = _agy_environment(account_id=account_id) if account_id else _agy_environment()
        agy_home = run_env.get("HOME") or HOME
        updater = globals().get("project_updater")
        update_lease = updater.acquire_turn() if updater else None
        try:
            async for event in stream_agy_acp(
                agy_bin=AGY_BIN,
                prompt=prompt,
                fallback_prompt=fallback_prompt,
                model=model,
                target_cwd=target_cwd,
                run_env=run_env,
                scratch_dir=SCRATCH,
                conversation_id=conversation_id,
                user_id=user_id,
                persist_conversation=persist_conversation and AGY_PERSIST_CONVERSATIONS,
                save_conversation_cb=save_conversation_async if (persist_conversation and AGY_PERSIST_CONVERSATIONS) else None,
                route_info_factory=_new_route_info,
                route_enricher=lambda info, trace: _apply_claude_agy_trace(info, agy_home, trace),
                system_append=system_append,
                update_lease=update_lease,
                timeout=turn_timeout,
                register_injector=register_injector,
                use_armor=use_armor,
                mcp_servers=mcp_servers,
                agy_fast_info=agy_fast_info,
                is_shutting_down=lambda: web_turns.shutting_down,
            ):
                yield event
        finally:
            if update_lease:
                update_lease.close()
        return

    effective_cli_prompt = prompt
    if use_armor and effective_cli_prompt and ARMOR_DELIVERY_SEAT not in effective_cli_prompt:
        effective_cli_prompt = f"{ARMOR_DELIVERY_SEAT}\n\n{effective_cli_prompt}"

    argv = _build_argv(
        # The CLI validates its own model id. The relay independently pins the user's
        # actual upstream model; keep the requested model unchanged in turn metadata.
        "gemini-3.1-pro" if api_connection and api_connection.chat_compat else model,
        prompt=effective_cli_prompt,
        conversation_id=conversation_id,
        continue_last=continue_last,
        target_cwd=target_cwd,
        effort=effort,
        timeout=timeout,
    )
    if api_connection:
        argv[1:1] = ["--settings", json.dumps({"modelProvider": "gemini"})]
    route_info = _new_route_info(uuid.uuid4().hex, model)
    if use_armor:
        route_info["armor"] = {"enabled": True, "status": "armed_cli", "retries": 0}
    log_dir = tempfile.TemporaryDirectory(prefix="agy-route-", dir=str(SCRATCH))
    log_path = Path(log_dir.name) / "cli.log"
    argv.extend(["--log-file", str(log_path)])
    profile_proxy = None
    update_lease = None
    try:
        updater = globals().get('project_updater')
        if updater:
            update_lease = updater.acquire_turn()
        run_env = _agy_environment()
        if api_connection:
            run_env = _api_environment(run_env, api_connection)
        profile = "native" if api_connection else run_env.get("AGY_UPSTREAM_PROFILE", "native").lower()
        if profile == "desktop" and model and model != "default":
            # The menu includes native-only models. Use the profile that actually
            # advertised this exact id; never substitute a different model.
            catalog = await models()
            selected = next((item for item in catalog["models"] if item["id"] == model), {})
            profile = selected.get("upstream_profile", profile)
        if profile == "desktop":
            profile_proxy = DesktopProfileProxy(
                run_env.get("CLOUD_CODE_URL", "https://daily-cloudcode-pa.googleapis.com"),
                run_env.get("AGY_DESKTOP_VERSION", "2.22.0"), turn_timeout,
                proxy_url=run_env.get("HTTPS_PROXY", ""),
            )
            run_env["CLOUD_CODE_URL"] = profile_proxy.url
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=target_cwd,
            env=run_env,
        )
    except Exception:
        if update_lease:
            update_lease.close()
        if profile_proxy:
            await asyncio.to_thread(profile_proxy.close)
        log_dir.cleanup()
        yield {"event": "metadata", "route_info": route_info}
        raise
    except BaseException:
        if update_lease:
            update_lease.close()
        if profile_proxy:
            await asyncio.to_thread(profile_proxy.close)
        log_dir.cleanup()
        raise

    assert proc.stdout is not None
    assert proc.stderr is not None
    buffered_line = ""
    stderr_tail = bytearray()
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    deadline = asyncio.get_running_loop().time() + turn_timeout if turn_timeout > 0 else None

    async def _drain_stderr() -> None:
        # Must keep reading stderr concurrently with stdout — if the child fills the
        # pipe buffer and no one reads it, the child blocks on write() and the whole
        # process (including stdout) deadlocks.
        assert proc.stderr is not None
        while True:
            chunk = await proc.stderr.read(4096)
            if not chunk:
                return
            stderr_tail.extend(chunk)
            del stderr_tail[:-4000]

    stderr_task = asyncio.create_task(_drain_stderr())

    async def _reap_process() -> None:
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=1)
        except (asyncio.TimeoutError, ProcessLookupError):
            logger.warning("Timed out reaping agy process")

    active_cid, active_cid_ambiguous, observed_steps, response_steps = None, False, set(), set()
    coverage_unknown, current_response_seen = False, False
    pending_result_errors = []

    def _enrich_event(ev: dict) -> dict | None:
        nonlocal active_cid, active_cid_ambiguous, coverage_unknown, current_response_seen
        if ev.pop("_result_error", False):
            pending_result_errors.append(ev)
            return None
        cli_cid = ev.pop("_cli_init_cid", None)
        if isinstance(cli_cid, str):
            if active_cid is not None and active_cid != cli_cid:
                active_cid_ambiguous = True
            else:
                active_cid = cli_cid
        step_index, step_type = ev.pop("_step_index", None), ev.pop("_step_type", None)
        if (isinstance(step_index, int) and not isinstance(step_index, bool) and 0 <= step_index < (1 << 31)
                and isinstance(step_type, str) and step_type in ("agent_response", "tool", "tool_call")):
            observed_steps.add(step_index)
            if step_type == "agent_response":
                response_steps.add(step_index)
        elif step_type == "agent_response":
            coverage_unknown = True
        _merge_response_evidence(route_info, ev.pop("_response_evidence", []))
        ev_type = ev.get("event")
        if ev_type == "delta" and step_type == "agent_response" and str(ev.get("delta", "")).strip():
            current_response_seen = True
        if ev_type == "result":
            _merge_response_evidence(route_info, _request_log_evidence(log_path))
        if ev_type in ("init", "result", "metadata"):
            _update_route_coverage(route_info, response_steps, coverage_unknown)
            ev["route_info"] = json.loads(json.dumps(route_info))
        return ev

    stream_error, native_thinking = None, []
    try:
        while True:
            if deadline is None:
                chunk = await proc.stdout.read(1024)
            else:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise asyncio.TimeoutError
                chunk = await asyncio.wait_for(proc.stdout.read(1024), timeout=remaining)
            if not chunk:
                break
            text = decoder.decode(chunk)

            if AGY_OUTPUT_FORMAT.strip().lower() == "stream-json":
                buffered_line += text
                lines = buffered_line.split("\n")
                buffered_line = lines.pop()
                for line in lines:
                    parsed_events = _parse_ndjson_line(line)
                    for ev in parsed_events:
                        enriched = _enrich_event(ev)
                        if enriched is None:
                            continue
                        if persist_conversation and enriched.get("event") == "init" and enriched.get("conversation_id") and AGY_PERSIST_CONVERSATIONS:
                            await save_conversation_async(user_id, enriched["conversation_id"])
                        yield enriched
            else:
                yield {"event": "delta", "delta": text}

        text = decoder.decode(b"", final=True)
        if text:
            buffered_line += text

        if buffered_line and buffered_line.strip():
            if AGY_OUTPUT_FORMAT.strip().lower() == "stream-json":
                parsed_events = _parse_ndjson_line(buffered_line)
                for ev in parsed_events:
                    enriched = _enrich_event(ev)
                    if enriched is None:
                        continue
                    if persist_conversation and enriched.get("event") == "init" and enriched.get("conversation_id") and AGY_PERSIST_CONVERSATIONS:
                        await save_conversation_async(user_id, enriched["conversation_id"])
                    yield enriched
            else:
                yield {"event": "delta", "delta": buffered_line}

        if proc.returncode is None:
            if deadline is None:
                await proc.wait()
            else:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise asyncio.TimeoutError
                await asyncio.wait_for(proc.wait(), timeout=remaining)
        if proc.returncode not in (0, None):
            err_txt = stderr_tail.decode(errors="replace").strip()
            if api_connection:
                err_txt = "第三方 Gemini API 请求失败，请检查地址、密钥、模型及协议兼容性"
            logger.warning(f"agy exited {proc.returncode}: {err_txt}")
            yield {"event": "error", "error": err_txt or f"antigravity-chat: agy exited with code {proc.returncode}"}

    except asyncio.TimeoutError:
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        err_txt = stderr_tail.decode(errors="replace").strip()
        if api_connection:
            err_txt = "第三方 Gemini API 请求超时"
        detail = f" — {err_txt}" if err_txt else ""
        yield {"event": "error", "error": f"antigravity-chat: timed out after {turn_timeout}s{detail}"}
    except Exception as exc:
        stream_error = exc
    finally:
        stderr_task.cancel()
        try:
            await stderr_task
        except (asyncio.CancelledError, Exception):
            pass
        try:
            await _reap_process()
            _merge_response_evidence(route_info, _request_log_evidence(log_path))
            if run_env.get("HOME") and active_cid and not active_cid_ambiguous and observed_steps:
                try:
                    records = await asyncio.to_thread(read_session_models, run_env["HOME"], active_cid, observed_steps)
                    _merge_response_evidence(route_info, records)
                except Exception:
                    logger.warning("Could not read agy response metadata")
                if response_steps:
                    try:
                        native_thinking = await asyncio.to_thread(read_session_thinking, run_env["HOME"],
                                                                  active_cid, response_steps, observed_steps)
                    except Exception:
                        logger.warning("Could not read agy thinking metadata")
        finally:
            try:
                if profile_proxy:
                    await asyncio.to_thread(profile_proxy.close)
            finally:
                if update_lease:
                    update_lease.close()
                log_dir.cleanup()
    for event in pending_result_errors:
        historical = None
        if (stream_error is None and proc.returncode == 0 and current_response_seen
                and run_env.get("HOME") and active_cid and not active_cid_ambiguous and response_steps):
            try:
                historical = await asyncio.to_thread(read_session_historical_error, run_env["HOME"],
                                                    active_cid, observed_steps, response_steps, event["error"])
            except Exception:
                logger.warning("Could not verify aggregate error scope")
        if historical:
            yield {"event": "notice", "scope": "historical", "step_index": historical["step_index"],
                   "detail": historical["error"]}
        else:
            yield event
    for event in native_thinking:
        yield event
    _update_route_coverage(route_info, response_steps, coverage_unknown)
    yield {"event": "metadata", "route_info": json.loads(json.dumps(route_info))}
    if stream_error is not None:
        raise stream_error


_ACP_INFO_TTL_SECONDS = 60.0
_acp_info_cache: tuple[float, dict[str, Any]] | None = None


@app.get("/api/acp-info")
async def acp_info(refresh: bool = False) -> dict:
    global _acp_info_cache
    now = time.monotonic()
    if not refresh and _acp_info_cache and (now - _acp_info_cache[0]) < _ACP_INFO_TTL_SECONDS:
        info = _acp_info_cache[1]
    else:
        info = await probe_agy_acp_info(AGY_BIN, run_env=_agy_environment(), cwd=str(SCRATCH))
        if info.get("available"):
            _acp_info_cache = (now, info)
        else:
            _acp_info_cache = None
    return {"ok": bool(info.get("available")), "acp": info}


@app.get("/healthz")
async def healthz() -> dict:
    return {
        "status": "ok",
        "version": project_updater.running_version,
        "backend": "agy",
        "upstream_profile": os.getenv("AGY_UPSTREAM_PROFILE", "native"),
        "sandbox": AGY_SANDBOX,
        "auth": _AUTH_ENABLED,
        "output_format": AGY_OUTPUT_FORMAT,
        "persist_conversations": AGY_PERSIST_CONVERSATIONS,
    }


@app.get("/api/fs")
async def fs(path: str | None = None) -> dict:
    return browse_fs(path)


def ensure_message_ids(cid: str, messages: list[dict]) -> list[dict]:
    occurrences: dict[tuple, int] = {}
    for message in messages:
        key = (message.get("role"), message.get("content"))
        occurrence = occurrences.get(key, 0)
        occurrences[key] = occurrence + 1
        if not message.get("id"):
            message["id"] = uuid.uuid5(uuid.NAMESPACE_URL, json.dumps([cid, *key, occurrence], ensure_ascii=False)).hex
    return messages


# Native legacy reconstruction is expensive; invalidate on transcript/DB/WAL changes.
_native_monitor_cache: dict[tuple, tuple[tuple, str]] = {}


def _native_monitor_history(cid: str, transcript: Path) -> list[dict]:
    database = Path(HOME) / ".gemini" / "antigravity-cli" / "conversations" / (cid + ".db")
    signature = []
    for path in (transcript, database, database.with_name(database.name + "-wal")):
        try:
            info = path.stat()
            signature.append((info.st_size, info.st_mtime_ns))
        except OSError:
            signature.append(None)
    key = (HOME, cid, str(transcript))
    cached = _native_monitor_cache.get(key)
    if cached and cached[0] == tuple(signature):
        return json.loads(cached[1])
    historical = parse_transcript_to_messages(transcript, include_monitor=True)
    for message in historical:
        steps = set(message.pop("_native_steps", []))
        response_steps = set(message.pop("_native_response_steps", []))
        if message.get("role") == "assistant" and steps:
            info = _new_route_info()
            _merge_response_evidence(info, read_session_models(HOME, cid, steps))
            _update_route_coverage(info, response_steps)
            if info["returned_models"] or info["returned_model_fulls"]:
                message["routeInfo"] = info
    encoded = json.dumps(historical, ensure_ascii=False)
    if len(encoded.encode("utf-8")) <= 8 * 1024 * 1024:
        if len(_native_monitor_cache) >= 8:
            _native_monitor_cache.pop(next(iter(_native_monitor_cache)))
        _native_monitor_cache[key] = (tuple(signature), encoded)
    return historical


def read_message_history(cid: str) -> list[dict]:
    """Read the shared history, recovering real timestamps from legacy transcripts."""
    msg_file = MESSAGES_DIR / f"{cid}.json"
    messages = None
    if msg_file.exists():
        messages = json.loads(msg_file.read_text(encoding="utf-8"))
        if not isinstance(messages, list):
            raise ValueError("Invalid message history")
    needs_history = messages is None or any(not message.get("created_at") or (
        message.get("role") == "assistant" and (not message.get("metrics") or
        not (message.get("routeInfo", {}).get("returned_models") or message.get("routeInfo", {}).get("returned_model_fulls"))))
        for message in messages)
    if needs_history:
        logs = Path(HOME) / ".gemini" / "antigravity-cli" / "brain" / cid / ".system_generated" / "logs"
        transcript = logs / "transcript_full.jsonl"
        if not transcript.exists():
            transcript = logs / "transcript.jsonl"
        historical = _native_monitor_history(cid, transcript)
        if messages is None:
            return ensure_message_ids(cid, historical)
        # Join exact content and occurrence, never attach another turn's metadata by position.
        matches: dict[tuple, list] = {}
        for message in historical:
            matches.setdefault((message.get("role"), message.get("content")), []).append(message)
        for message in messages:
            candidates = matches.get((message.get("role"), message.get("content")), [])
            if candidates:
                original = candidates.pop(0)
                for field in ("created_at", "metrics"):
                    if not message.get(field) and original.get(field):
                        message[field] = original[field]
                existing = message.get("routeInfo") or {}
                if original.get("routeInfo") and not (existing.get("returned_models") or existing.get("returned_model_fulls")):
                    info = existing or _new_route_info()
                    _merge_response_evidence(info, original["routeInfo"]["evidence"])
                    _update_route_coverage(info, set(original["routeInfo"]["observed_step_indices"]))
                    message["routeInfo"] = info
        for message in messages:
            if message.get("role") != "assistant":
                continue
            existing = message.get("routeInfo")
            if (
                isinstance(existing, dict)
                and existing.get("acp_session_ids")
                and not (existing.get("returned_models") or existing.get("returned_model_fulls"))
            ):
                for candidate_home in _claude_agy_candidate_homes():
                    _apply_claude_agy_trace(existing, candidate_home, {})
                    if existing.get("returned_models") or existing.get("returned_model_fulls"):
                        break
    # A bridge restart drops in-memory turns while their last snapshots remain on disk.
    if messages and not web_turns.for_conversation(cid):
        last = messages[-1]
        if last.get("role") == "assistant" and last.get("status") == "streaming" and last.get("turnId"):
            last["status"] = "error"
            last["thoughtOpen"] = False
            detail = "本轮生成已中断。此前写入项目的文件可在原目录检查。"
            partial = str(last.get("content") or "").strip()
            last["content"] = f"{partial}\n\n{detail}" if partial else detail
    return ensure_message_ids(cid, messages)


def message_revision(messages: list[dict]) -> str:
    return hashlib.sha256(json.dumps(messages, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def search_conversation_messages(items: list[dict], query: str) -> list[dict]:
    needle = query.casefold()
    found = []
    for item in items:
        cid = item["conversation_id"]
        matches, count = [], 0
        try:
            history = read_message_history(cid)
        except (OSError, ValueError, TypeError):
            history = []
        for index, message in enumerate(history):
            text = str(message.get("content") or "")
            attachments = " ".join(str(att.get("filename") or "") for att in message.get("attachments") or [])
            searchable = text + ("\n" + attachments if attachments else "")
            position = searchable.casefold().find(needle)
            if position < 0:
                continue
            count += 1
            if len(matches) < 5:
                start = max(0, position - 35)
                snippet = searchable[start:position + len(query) + 90].replace("\n", " ")
                matches.append({"message_index": index, "message_id": message.get("id"),
                                "snippet": ("…" if start else "") + snippet,
                                "created_at": message.get("created_at"), "role": message.get("role")})
        if matches or needle in str(item.get("title") or "").casefold() or needle in cid.casefold():
            found.append({**item, "matches": matches, "match_count": count})
    return found


@app.get("/api/conversations/search")
async def search_conversations(q: str = Query(default="", max_length=200), user_id: str = "default") -> dict:
    query = q.strip()
    items, _ = await list_user_conversations_async(user_id)
    results = await asyncio.to_thread(search_conversation_messages, items, query) if query else items
    return {"query": query, "conversations": results}


@app.get("/api/conversations")
async def conversations(user_id: str = "default") -> dict:
    uid = _sanitize_token(user_id, "default") or "default"
    items, active_id = await list_user_conversations_async(uid)
    return {"user_id": uid, "conversations": items, "active_id": active_id,
            "conversation_id": active_id}


@app.delete("/api/conversations/{cid}")
async def delete_conversation_ep(cid: str, user_id: str = "default") -> dict:
    uid = _sanitize_token(user_id, "default") or "default"
    ok = await delete_user_conversation_async(uid, cid)
    if not ok:
        raise HTTPException(status_code=404, detail="conversation not found")
    return {"status": "deleted", "conversation_id": cid}


@app.post("/api/conversations/{cid}/activate")
async def activate_conversation_ep(cid: str, user_id: str = "default") -> dict:
    uid = _sanitize_token(user_id, "default") or "default"
    ok = await set_active_conversation_async(uid, cid)
    if not ok:
        raise HTTPException(status_code=404, detail="conversation not found")
    return {"status": "activated", "conversation_id": cid}


class RenameRequest(BaseModel):
    title: str


@app.patch("/api/conversations/{cid}")
async def rename_conversation_ep(cid: str, user_id: str = "default", req: RenameRequest | None = None) -> dict:
    uid = _sanitize_token(user_id, "default") or "default"
    title = (req.title if req else "")
    ok = await rename_conversation_async(uid, cid, title)
    if not ok:
        raise HTTPException(status_code=404, detail="conversation not found or bad title")
    return {"status": "renamed", "conversation_id": cid, "title": title.strip()[:80]}


class PinRequest(BaseModel):
    pinned: StrictBool


@app.patch("/api/conversations/{cid}/pin")
async def pin_conversation_ep(cid: str, req: PinRequest, user_id: str = "default") -> dict:
    uid = _sanitize_token(user_id)
    clean_cid = _sanitize_token(cid)
    ok = await set_conversation_pinned_async(uid, clean_cid, req.pinned)
    if not ok:
        raise HTTPException(status_code=404, detail="conversation not found")
    return {"status": "pinned" if req.pinned else "unpinned",
            "conversation_id": clean_cid, "pinned": req.pinned}


@app.delete("/api/conversations")
async def delete_conversation(user_id: str = "default") -> dict:
    uid = _sanitize_token(user_id, "default") or "default"
    await clear_conversation_async(uid)
    return {"status": "cleared", "user_id": uid}


class SaveMessagesRequest(BaseModel):
    messages: list[dict]
    turn_id: str | None = None
    base_revision: str | None = None


@app.get("/api/conversations/{cid}/messages")
async def get_conversation_messages_ep(cid: str, revision: str | None = None) -> dict:
    clean_cid = _sanitize_token(cid)
    if not clean_cid:
        raise HTTPException(status_code=400, detail="Invalid conversation ID")

    try:
        messages = await asyncio.to_thread(read_message_history, clean_cid)
    except Exception as exc:
        logger.warning("Failed to read messages for %s: %s", clean_cid, type(exc).__name__)
        raise HTTPException(status_code=500, detail="Could not read conversation history") from exc
    current_revision = message_revision(messages)
    turn = web_turns.for_conversation(clean_cid)
    result = {"conversation_id": clean_cid, "revision": current_revision,
              "active_turn": turn.info() if turn and turn.status == "running" else None}
    if revision == current_revision:
        return {**result, "unchanged": True}
    return {**result, "messages": messages}


@app.post("/api/conversations/{cid}/messages")
async def save_conversation_messages_ep(cid: str, req: SaveMessagesRequest) -> dict:
    clean_cid = _sanitize_token(cid)
    if not clean_cid:
        raise HTTPException(status_code=400, detail="Invalid conversation ID")

    msg_file = MESSAGES_DIR / f"{clean_cid}.json"
    tmp_file = msg_file.with_suffix(".tmp")
    try:
        current = read_message_history(clean_cid)
        current_revision = message_revision(current)
        turn = web_turns.for_conversation(clean_cid)
        own_turn = turn and req.turn_id == turn.id
        if req.turn_id and not own_turn:
            raise HTTPException(status_code=409, detail="该请求未持有当前回复，请重新同步聊天记录。")
        if req.base_revision != current_revision and (current or req.base_revision is not None):
            if own_turn:
                # Transport readers already have a server-owned snapshot. A late
                # reader must never replace newer history or another device's edits.
                return {"status": "saved", "conversation_id": clean_cid,
                        "count": len(current), "revision": current_revision, "sync_required": True}
            raise HTTPException(status_code=409, detail="聊天记录已在其他设备更新，请同步后重试。")
        snapshot = web_turns.protect(clean_cid, req.messages, req.turn_id)
        stored = web_turns.serializable(snapshot) if web_turns.for_conversation(clean_cid) else snapshot
        ensure_message_ids(clean_cid, stored)
        tmp_file.write_text(json.dumps(stored, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp_file.replace(msg_file)
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning(f"Failed to save messages for {clean_cid}: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))
    return {"status": "saved", "conversation_id": clean_cid, "count": len(snapshot),
            "revision": message_revision(stored)}


class RecallMessagesRequest(BaseModel):
    message_id: str | None = None
    user_turn_from_end: int | None = None
    keep_count: int | None = None


@app.post("/api/conversations/{cid}/recall")
async def recall_conversation_messages_ep(cid: str, req: RecallMessagesRequest) -> dict:
    clean_cid = _sanitize_token(cid)
    if not clean_cid:
        raise HTTPException(status_code=400, detail="Invalid conversation ID")

    active_turn = web_turns.for_conversation(clean_cid)
    if active_turn and active_turn.status == "running":
        await web_turns.stop(active_turn.id)

    try:
        current = read_message_history(clean_cid)
        cut_index: int | None = None

        if req.message_id:
            target_id = req.message_id.strip()
            for idx, item in enumerate(current):
                if item.get("id") == target_id:
                    cut_index = idx
                    break
            if cut_index is None and target_id.startswith(f"{clean_cid}:"):
                suffix = target_id[len(clean_cid) + 1:]
                if suffix.isdigit():
                    parsed_idx = int(suffix)
                    if 0 <= parsed_idx < len(current):
                        cut_index = parsed_idx

        if cut_index is None and req.user_turn_from_end is not None and req.user_turn_from_end >= 0:
            user_indices = [idx for idx, item in enumerate(current) if item.get("role") == "user"]
            if req.user_turn_from_end < len(user_indices):
                cut_index = user_indices[len(user_indices) - 1 - req.user_turn_from_end]

        if cut_index is None and req.keep_count is not None:
            if 0 <= req.keep_count < len(current):
                cut_index = req.keep_count

        if cut_index is None or cut_index < 0 or cut_index >= len(current):
            raise HTTPException(status_code=404, detail="未找到要撤回的消息。")

        recalled_message = current[cut_index]
        kept = current[:cut_index]
        stored = web_turns.serializable(kept)
        ensure_message_ids(clean_cid, stored)

        msg_file = MESSAGES_DIR / f"{clean_cid}.json"
        tmp_file = msg_file.with_suffix(".tmp")
        tmp_file.write_text(json.dumps(stored, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp_file.replace(msg_file)

        await set_conversation_needs_replay_async(clean_cid, True)
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("Failed to recall messages for %s: %s", clean_cid, exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "status": "recalled",
        "conversation_id": clean_cid,
        "recalled_message": recalled_message,
        "count": len(stored),
        "removed_count": len(current) - len(stored),
        "revision": message_revision(stored),
    }


async def _fetch_profile_models(run_env: dict[str, str], profile: str) -> list[dict]:
    """Discover ids with exactly the client identity used to run those models."""
    max_retries = 3
    base_delay = 0.5
    for attempt in range(max_retries):
        profile_proxy = None
        proc = None
        try:
            env = run_env.copy()
            if profile == "desktop":
                profile_proxy = DesktopProfileProxy(
                    env.get("CLOUD_CODE_URL", "https://daily-cloudcode-pa.googleapis.com"),
                    env.get("AGY_DESKTOP_VERSION", "2.22.0"), 30,
                    proxy_url=env.get("HTTPS_PROXY", ""),
                )
                env["CLOUD_CODE_URL"] = profile_proxy.url
            proc = await asyncio.create_subprocess_exec(
                AGY_BIN, "models",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                start_new_session=os.name == "posix",
            )
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
            names = []
            if proc.returncode == 0:
                for ln in out.decode().splitlines():
                    model_id, separator, label = ln.strip().partition("\t")
                    if separator and model_id.strip():
                        names.append({"id": model_id.strip(), "name": label.strip() or model_id.strip(),
                                      "upstream_profile": profile})
            if names:
                return names
        except Exception:
            pass
        finally:
            await reap_cli_process(proc)
            if profile_proxy:
                await asyncio.to_thread(profile_proxy.close)

        if attempt < max_retries - 1:
            await asyncio.sleep(base_delay * (2 ** attempt))
    return []


async def _fetch_account_models(account_id: str | None = None) -> list[dict[str, str]]:
    """Fetch the exact models available to a specific agy account (or active account if None)."""
    resolved_id = (account_id or "").strip()
    if resolved_id == "__active__":
        resolved_id = ""
    if resolved_id:
        if _resolve_account_file(resolved_id) is None:
            raise HTTPException(status_code=404, detail=f"账号 '{resolved_id}' 不存在")
        cache_key = resolved_id
    else:
        active_id = _active_account_id()
        cache_key = active_id or "__active__"

    now = time.monotonic()
    cached = _account_models_cache.get(cache_key)
    if cached and now - cached[0] < _MODELS_TTL:
        return cached[1]

    run_env = _agy_environment(account_id=resolved_id) if resolved_id else _agy_environment()
    names = await _fetch_profile_models(run_env, "native")
    if names:
        _account_models_cache[cache_key] = (time.monotonic(), names)
        for m in names:
            _models_label_map[m["id"]] = m["name"]
    return names


@app.get("/api/models")
async def models(account_id: str | None = None) -> dict:
    if account_id is not None and account_id.strip():
        return {"models": await _fetch_account_models(account_id.strip())}

    global _models_cache
    now = time.monotonic()
    if _models_cache and now - _models_cache[0] < _MODELS_TTL:
        return {"models": _models_cache[1]}

    run_env = _agy_environment()
    complete = True
    if run_env.get("AGY_UPSTREAM_PROFILE", "native").lower() == "desktop":
        names, desktop = await asyncio.gather(
            _fetch_profile_models(run_env, "native"),
            _fetch_profile_models(run_env, "desktop"),
        )
        # Shared ids retain the configured desktop behavior; ids available only
        # to the native CLI (e.g. Argon) keep their native execution profile.
        # Keep models from the working profile available during a partial outage.
        # Retry discovery next time rather than caching an incomplete comparison.
        complete = bool(names and desktop)
        combined = {item["id"]: item for item in names}
        combined.update({item["id"]: item for item in desktop})
        names = list(combined.values())
    else:
        names = await _fetch_profile_models(run_env, "native")
    if names:
        if complete:
            _models_cache = (time.monotonic(), names)
        for m in names:
            _models_label_map[m["id"]] = m["name"]
    return {"models": names}


# --------------------------------------------------------------------------- #
# Quota & Multi-Account Management
# --------------------------------------------------------------------------- #

class SwitchAccountRequest(BaseModel):
    id: str


class AddAccountRequest(BaseModel):
    token: str | None = None
    token_json: str | None = None
    alias: str | None = None
    switch_now: StrictBool = False


_quota_cache: dict[str, Any] = {
    "data": None,
    "timestamp": 0.0,
    "retry_at": 0.0,
}
_quota_lock = asyncio.Lock()
QUOTA_TIMEOUT_SECONDS = 25.0
QUOTA_RETRY_SECONDS = 15.0


def _decode_id_token(id_token: str | None) -> dict:
    if not id_token or not isinstance(id_token, str):
        return {}
    try:
        parts = id_token.split(".")
        if len(parts) >= 2:
            payload = parts[1] + "=" * (-len(parts[1]) % 4)
            return json.loads(base64.urlsafe_b64decode(payload.encode("utf-8")).decode("utf-8"))
    except Exception as exc:
        logger.debug("Failed to decode id_token JWT: %s", exc)
    return {}


def _get_token_account_info(token_data: dict) -> dict:
    id_token = token_data.get("id_token")
    claims = _decode_id_token(id_token) if id_token else {}
    email = token_data.get("id_token_email") or claims.get("email") or token_data.get("email") or "unknown"
    name = claims.get("name") or token_data.get("name") or email
    exp = claims.get("exp")
    return {
        "email": email,
        "name": name,
        "exp": exp,
        "auth_method": token_data.get("auth_method", "oauth"),
    }


def _has_valid_token(data: object) -> bool:
    """Return True only when an OAuth credential payload carries a non-empty token."""
    if not isinstance(data, dict):
        return False
    token = data.get("token")
    if isinstance(token, str):
        return bool(token.strip())
    if isinstance(token, dict):
        return any(isinstance(v, str) and bool(v.strip()) for v in token.values())
    return False


def _same_account(left: dict, right: dict) -> bool:
    """Match credentials across CLI refreshes without treating unknown as an identity."""
    if not _has_valid_token(left) or not _has_valid_token(right):
        return False
    left_token, right_token = left.get("token"), right.get("token")
    if isinstance(left_token, dict) and isinstance(right_token, dict):
        left_refresh = left_token.get("refresh_token")
        right_refresh = right_token.get("refresh_token")
        if left_refresh and right_refresh and left_refresh == right_refresh:
            return True
    if left_token and right_token and left_token == right_token:
        return True
    left_email = _get_token_account_info(left)["email"]
    right_email = _get_token_account_info(right)["email"]
    return left_email != "unknown" and right_email != "unknown" and left_email.casefold() == right_email.casefold()


def _sync_active_account_to_storage() -> None:
    """Ensure the currently active OAuth token is saved in ACCOUNTS_DIR."""
    if not ACTIVE_TOKEN_FILE.exists():
        return
    try:
        content = ACTIVE_TOKEN_FILE.read_text()
        data = json.loads(content)
        if not _has_valid_token(data):
            return
        info = _get_token_account_info(data)
        email = info.get("email")

        # Keep refreshed credentials while retaining saved names and ID claims.
        if ACCOUNTS_DIR.exists():
            for f in ACCOUNTS_DIR.glob("*.json"):
                try:
                    f_data = json.loads(f.read_text())
                    if _same_account(data, f_data):
                        merged = {**f_data, **data}
                        if merged != f_data:
                            tmp = f.with_suffix(".tmp")
                            tmp.write_text(json.dumps(merged, indent=2) + "\n")
                            tmp.chmod(0o600)
                            tmp.replace(f)
                        return
                except Exception:
                    pass

        if not email or email == "unknown":
            email = "account_" + hashlib.sha256(json.dumps(data.get("token"), sort_keys=True).encode()).hexdigest()[:12]
        safe_name = "".join(c for c in email if c.isalnum() or c in ("@", ".", "_", "-"))
        account_file = ACCOUNTS_DIR / f"{safe_name}.json"
        if not account_file.exists():
            account_file.write_text(json.dumps(data, indent=2) + "\n")
            account_file.chmod(0o600)
    except Exception as exc:
        logger.warning("Failed to auto-backup active account to %s: %s", ACCOUNTS_DIR, exc)


ACCOUNT_TIER_TTL_SECONDS = 1800.0
ACCOUNT_TIER_RETRY_SECONDS = 120.0
ACCOUNT_TIER_CACHE_VERSION = 2
_tier_cache_lock = threading.Lock()
_tier_refresh_tasks: dict[str, asyncio.Task] = {}
_tier_retry_at: dict[str, float] = {}
_tier_refresh_sem: asyncio.Semaphore | None = None


def _tiers_cache_file() -> Path:
    return ACCOUNTS_DIR.parent / "account_tiers.json"


def _load_tier_cache() -> dict[str, dict]:
    cache_file = _tiers_cache_file()
    with _tier_cache_lock:
        if not cache_file.exists():
            return {}
        try:
            data = json.loads(cache_file.read_text())
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}


def _save_tier_cache_entry(account_id: str, entry: dict) -> None:
    cache_file = _tiers_cache_file()
    with _tier_cache_lock:
        cache: dict[str, Any] = {}
        if cache_file.exists():
            try:
                loaded = json.loads(cache_file.read_text())
                if isinstance(loaded, dict):
                    cache = loaded
            except Exception:
                cache = {}
        cache[account_id] = entry
        try:
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            tmp = cache_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(cache, indent=2) + "\n")
            tmp.chmod(0o600)
            tmp.replace(cache_file)
        except Exception as exc:
            logger.warning("Failed to save account tier cache: %s", exc)


def _remove_tier_cache_entry(account_id: str) -> None:
    cache_file = _tiers_cache_file()
    with _tier_cache_lock:
        if not cache_file.exists():
            return
        try:
            cache = json.loads(cache_file.read_text())
            if isinstance(cache, dict) and account_id in cache:
                cache.pop(account_id, None)
                tmp = cache_file.with_suffix(".tmp")
                tmp.write_text(json.dumps(cache, indent=2) + "\n")
                tmp.chmod(0o600)
                tmp.replace(cache_file)
        except Exception:
            pass


def _classify_antigravity_tier(load_code_assist: dict, available_models: dict | None = None) -> str | None:
    """Map Google Cloud Code Assist loadCodeAssist + fetchAvailableModels to official Antigravity tier labels."""
    if not isinstance(load_code_assist, dict):
        return None
    paid_tier = load_code_assist.get("paidTier")
    if isinstance(paid_tier, dict):
        paid_id = str(paid_tier.get("id") or "").strip().lower().replace("_", "-")
        paid_name = str(paid_tier.get("name") or "").strip()
        if paid_id:
            if paid_id == "g1-ultra-lite-tier" or ("ultra" in paid_id and ("lite" in paid_id or "5x" in paid_id)):
                return "Ultra 5x"
            if paid_id == "ws-ai-ultra-business-tier":
                return "Ultra Business"
            if paid_id == "gcp-ge-ultra-tier":
                return "Ultra Enterprise"
            if paid_id == "g1-ultra-tier" or "ultra" in paid_id:
                return "Ultra 20x"
            if paid_id == "g1-pro-tier" or "pro" in paid_id:
                models = available_models.get("models") if isinstance(available_models, dict) else None
                if isinstance(models, dict) and models:
                    model_ids = [str(k).lower() for k in models.keys()]
                    has_paid_models = any(
                        m.startswith(("claude-opus-5", "claude-sonnet-5", "gemini-4-neon", "gemini-4-carbon", "gemini-4-argon"))
                        for m in model_ids
                    )
                    return "PaidPro" if has_paid_models else "FreePro"
                return "Pro"
            if paid_id == "g1-plus-tier" or "plus" in paid_id:
                return "Plus"
            return paid_name or paid_id

    current_tier = load_code_assist.get("currentTier")
    if isinstance(current_tier, dict):
        cur_id = str(current_tier.get("id") or "").strip().lower().replace("_", "-")
        cur_name = str(current_tier.get("name") or "").strip()
        if cur_id in ("free-tier", "free"):
            return "Free"
        if cur_id in ("standard-tier", "cs-standard-tier", "gcp-ge-standard-tier"):
            return "Standard"
        if cur_id == "legacy-tier":
            return "Legacy"
        if cur_id == "gcp-ge-edu-pro-tier":
            return "Edu Pro"
        if cur_id == "gcp-ge-edu-tier":
            return "Edu"
        if "enterprise" in cur_id or cur_id == "gcp-ge-plus-tier":
            return "Enterprise"
        if "business" in cur_id:
            return "Business"
        if cur_id == "gdp-premium-tier":
            return "GDP Premium"
        if cur_name and cur_name.lower() != "antigravity":
            return cur_name
        if cur_id:
            return cur_id
    return None


def _resolve_cached_tier(cached_tier: Any) -> str | None:
    if not isinstance(cached_tier, dict):
        return None
    tier = cached_tier.get("tier")
    if not isinstance(tier, str) or not tier:
        return None
    if tier == "Ultra":
        paid_id = str(cached_tier.get("paid_tier_id") or "").strip().lower().replace("_", "-")
        if paid_id == "g1-ultra-lite-tier" or ("ultra" in paid_id and ("lite" in paid_id or "5x" in paid_id)):
            return "Ultra 5x"
        if paid_id == "g1-ultra-tier":
            return "Ultra 20x"
    return tier


def _http_post_json(url: str, access_token: str, payload: dict, env: dict[str, str], timeout: float = 15.0) -> dict:
    proxies: dict[str, str] = {}
    https_proxy = env.get("HTTPS_PROXY") or env.get("https_proxy") or env.get("ALL_PROXY") or env.get("all_proxy")
    http_proxy = env.get("HTTP_PROXY") or env.get("http_proxy") or env.get("ALL_PROXY") or env.get("all_proxy")
    if https_proxy:
        proxies["https"] = https_proxy
    if http_proxy:
        proxies["http"] = http_proxy
    opener = urllib.request.build_opener(urllib.request.ProxyHandler(proxies)) if proxies else urllib.request.build_opener()
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "User-Agent": "antigravity/1.5.15",
        },
        method="POST",
    )
    with opener.open(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


async def _refresh_account_token_via_cli(account_id: str) -> str | None:
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            AGY_BIN, "-p=/credits",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            cwd=str(SCRATCH),
            env=_agy_environment(account_id=account_id),
            start_new_session=os.name == "posix",
        )
        await asyncio.wait_for(proc.communicate(), timeout=20.0)
    except Exception as exc:
        logger.debug("Token refresh via agy CLI failed for %s: %s", account_id, exc)
    finally:
        await reap_cli_process(proc)
    _sync_account_home_token_to_storage(account_id)
    target_file = _resolve_account_file(account_id)
    if not target_file or not target_file.exists():
        return None
    try:
        data = json.loads(target_file.read_text())
        tok = data.get("token")
        return tok.get("access_token") if isinstance(tok, dict) else (tok if isinstance(tok, str) else None)
    except Exception:
        return None


async def _refresh_account_tier(account_id: str) -> str | None:
    global _tier_refresh_sem
    if _tier_refresh_sem is None:
        _tier_refresh_sem = asyncio.Semaphore(3)
    async with _tier_refresh_sem:
        target_file = _resolve_account_file(account_id)
        if not target_file or not target_file.exists():
            return None
        try:
            data = json.loads(target_file.read_text())
            tok = data.get("token")
            access_token = tok.get("access_token") if isinstance(tok, dict) else (tok if isinstance(tok, str) else None)
            if not access_token:
                return None
        except Exception:
            return None

        env = egress_environment(os.environ.copy())
        base_url = env.get("CLOUD_CODE_URL", "https://daily-cloudcode-pa.googleapis.com").rstrip("/")
        lca_url = f"{base_url}/v1internal:loadCodeAssist"
        lca_payload = {"metadata": {"ideType": "IDE_UNSPECIFIED", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI"}}

        try:
            try:
                lca = await asyncio.to_thread(_http_post_json, lca_url, access_token, lca_payload, env)
            except urllib.error.HTTPError as err:
                if err.code != 401:
                    raise
                refreshed_token = await _refresh_account_token_via_cli(account_id)
                if not refreshed_token:
                    raise
                access_token = refreshed_token
                lca = await asyncio.to_thread(_http_post_json, lca_url, access_token, lca_payload, env)

            fam: dict | None = None
            paid_tier = lca.get("paidTier") if isinstance(lca, dict) else None
            paid_id = str(paid_tier.get("id") or "").strip().lower() if isinstance(paid_tier, dict) else ""
            if paid_id and (paid_id == "g1-pro-tier" or ("pro" in paid_id and "ultra" not in paid_id)):
                fam_url = f"{base_url}/v1internal:fetchAvailableModels"
                project = lca.get("cloudaicompanionProject") or "aicode-consumers"
                try:
                    fam = await asyncio.to_thread(_http_post_json, fam_url, access_token, {"project": project}, env)
                except Exception as exc:
                    logger.debug("fetchAvailableModels failed for %s: %s", account_id, exc)

            tier = _classify_antigravity_tier(lca, fam)
            if tier:
                _save_tier_cache_entry(account_id, {
                    "v": ACCOUNT_TIER_CACHE_VERSION,
                    "tier": tier,
                    "paid_tier_id": paid_id or None,
                    "current_tier_id": str((lca.get("currentTier") or {}).get("id") or "") or None,
                    "checked_at": time.time(),
                })
                _tier_retry_at.pop(account_id, None)
            return tier
        except Exception as exc:
            logger.debug("Failed to refresh subscription tier for agy account %s: %s", account_id, exc)
            _tier_retry_at[account_id] = time.monotonic() + ACCOUNT_TIER_RETRY_SECONDS
            return None


def _schedule_tier_refresh(accounts: list[dict], force: bool = False) -> None:
    if os.environ.get("AGY_DISABLE_TIER_REFRESH") == "1":
        return
    cache = _load_tier_cache()
    now = time.time()
    mono = time.monotonic()
    for acc in accounts:
        account_id = acc.get("id")
        if not account_id:
            continue
        existing_task = _tier_refresh_tasks.get(account_id)
        if existing_task and not existing_task.done():
            continue
        if not force and _tier_retry_at.get(account_id, 0.0) > mono:
            continue
        cached = cache.get(account_id)
        if (
            not force
            and isinstance(cached, dict)
            and cached.get("v") == ACCOUNT_TIER_CACHE_VERSION
            and cached.get("tier")
            and (now - float(cached.get("checked_at") or 0.0) < ACCOUNT_TIER_TTL_SECONDS)
        ):
            continue
        try:
            task = asyncio.create_task(_refresh_account_tier(account_id))
        except RuntimeError:
            return
        _tier_refresh_tasks[account_id] = task
        task.add_done_callback(lambda _t, aid=account_id: _tier_refresh_tasks.pop(aid, None))


def _list_stored_accounts() -> list[dict]:
    _sync_active_account_to_storage()
    tier_cache = _load_tier_cache()
    active_data = {}
    if ACTIVE_TOKEN_FILE.exists():
        try:
            active_data = json.loads(ACTIVE_TOKEN_FILE.read_text())
        except Exception:
            pass

    accounts: list[dict] = []
    if ACCOUNTS_DIR.exists():
        for f in sorted(ACCOUNTS_DIR.glob("*.json")):
            try:
                data = json.loads(f.read_text())
                if not _has_valid_token(data):
                    continue
                info = _get_token_account_info(data)
                is_active = _same_account(active_data, data)
                cached_tier = tier_cache.get(f.stem)
                subscription_tier = _resolve_cached_tier(cached_tier)
                accounts.append({
                    "id": f.stem,
                    "filename": f.name,
                    "email": info["email"],
                    "name": info["name"],
                    "exp": info.get("exp"),
                    "active": is_active,
                    "subscription_tier": subscription_tier,
                    "updated_at": int(f.stat().st_mtime),
                })
            except Exception as exc:
                logger.warning("Failed to parse account file %s: %s", f, exc)

    accounts.sort(key=lambda a: (not a["active"], a["email"]))
    return accounts


def _resolve_account_file(account_id: str) -> Path | None:
    if not account_id or not isinstance(account_id, str) or any(ch in account_id for ch in ("/", "\\", "\x00")) or ".." in account_id:
        return None
    if not ACCOUNTS_DIR.exists():
        return None
    candidates = [ACCOUNTS_DIR / f"{account_id}.json", ACCOUNTS_DIR / account_id]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    for f in ACCOUNTS_DIR.glob("*.json"):
        if f.stem == account_id or f.name == account_id:
            return f
        try:
            d = json.loads(f.read_text())
            if _get_token_account_info(d).get("email") == account_id:
                return f
        except Exception:
            pass
    return None


def _active_account_id() -> str | None:
    _sync_active_account_to_storage()
    if not ACTIVE_TOKEN_FILE.exists() or not ACCOUNTS_DIR.exists():
        return None
    try:
        active_data = json.loads(ACTIVE_TOKEN_FILE.read_text())
        if not _has_valid_token(active_data):
            return None
    except Exception:
        return None
    for f in sorted(ACCOUNTS_DIR.glob("*.json")):
        try:
            f_data = json.loads(f.read_text())
            if _same_account(active_data, f_data):
                return f.stem
        except Exception:
            pass
    return None


def _clear_quota_cache() -> None:
    global _models_cache
    _quota_cache["data"] = None
    _quota_cache["timestamp"] = 0.0
    _quota_cache["retry_at"] = 0.0
    _models_cache = None
    _account_models_cache.clear()


def _switch_to_account(account_id: str) -> dict:
    _sync_active_account_to_storage()
    target_file = _resolve_account_file(account_id)
    if not target_file or not target_file.exists():
        raise HTTPException(status_code=404, detail=f"账号 '{account_id}' 不存在")

    content = target_file.read_text()
    data = json.loads(content)
    if not _has_valid_token(data):
        raise HTTPException(status_code=400, detail=f"账号 '{account_id}' 凭证无效")
    info = _get_token_account_info(data)

    ACTIVE_TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp_file = ACTIVE_TOKEN_FILE.with_suffix(".tmp")
    tmp_file.write_text(content)
    tmp_file.chmod(0o600)
    tmp_file.replace(ACTIVE_TOKEN_FILE)

    # Prepare this account's isolated runtime home without touching any other running account.
    try:
        _prepare_account_home(target_file.stem)
    except Exception as exc:
        logger.warning("Failed to prepare isolated home during switch to %s: %s", account_id, exc)

    # Sync runtime isolate token if configured
    runtime_home = Path(os.getenv("AGY_RUNTIME_HOME", str(SCRATCH / ".agy-home"))).expanduser().resolve()
    runtime_token = runtime_home / ".gemini" / "antigravity-cli" / "antigravity-oauth-token"
    if runtime_token.exists() and not runtime_token.is_symlink():
        try:
            runtime_token.unlink()
            runtime_token.symlink_to(ACTIVE_TOKEN_FILE)
        except Exception:
            pass

    _clear_quota_cache()

    return {
        "ok": True,
        "message": f"成功切换到账号 {info.get('email', account_id)}",
        "active_account": info.get("email", account_id),
    }


def _save_new_account(token_data: dict | str, alias: str | None = None, switch_now: bool = False) -> dict:
    if isinstance(token_data, str):
        token_str = token_data.strip()
        try:
            data = json.loads(token_str)
        except Exception:
            data = {"token": token_str, "auth_method": "oauth"}
    elif isinstance(token_data, dict):
        data = token_data
    else:
        raise HTTPException(status_code=400, detail="无效的 Token 数据格式")

    if not _has_valid_token(data):
        raise HTTPException(status_code=400, detail="Token 数据中缺少必要的 'token' 字段")

    info = _get_token_account_info(data)
    identifier = alias.strip() if alias and alias.strip() else info.get("email")
    if not identifier or identifier == "unknown":
        identifier = f"account_{uuid.uuid4().hex[:8]}"

    safe_name = "".join(c for c in identifier if c.isalnum() or c in ("@", ".", "_", "-"))
    if not safe_name:
        safe_name = f"account_{uuid.uuid4().hex[:8]}"

    target_file = ACCOUNTS_DIR / f"{safe_name}.json"
    target_file.write_text(json.dumps(data, indent=2) + "\n")
    target_file.chmod(0o600)

    if switch_now:
        _switch_to_account(safe_name)

    return {
        "ok": True,
        "id": safe_name,
        "email": info.get("email"),
        "name": info.get("name"),
        "switched": switch_now,
    }


def _delete_stored_account(account_id: str) -> dict:
    target_file = _resolve_account_file(account_id)
    if not target_file or not target_file.exists():
        raise HTTPException(status_code=404, detail="账号不存在")

    if _active_account_turns.get(target_file.stem, 0) > 0:
        raise HTTPException(status_code=409, detail="该账号仍有回复正在生成，请等待结束后再删除")

    if ACTIVE_TOKEN_FILE.exists():
        try:
            active_data = json.loads(ACTIVE_TOKEN_FILE.read_text())
            target_data = json.loads(target_file.read_text())
            if _same_account(active_data, target_data):
                raise HTTPException(status_code=400, detail="无法删除当前正在使用的账号，请先切换到其他账号")
        except HTTPException:
            raise
        except Exception:
            pass

    target_file.unlink(missing_ok=True)
    _remove_tier_cache_entry(target_file.stem)
    return {"ok": True, "message": "账号已删除"}


def _parse_usage_output(usage_text: str) -> list[dict]:
    pattern = re.compile(
        r"^\s*(.+?)(?:\t+|\s{2,})((?:(?:Weekly|Five Hour|Daily)\s+Limit\s+Remaining|Gemini 4 Argon Weekly Limit))(?:\t+|\s+)(\d+)%(?:\t+|\s+)(.+)$",
        re.M,
    )
    items: list[dict] = []
    for match in pattern.finditer(usage_text):
        m_name, l_type, pct_str, resets_at = match.groups()
        m_name = m_name.strip()
        l_type = l_type.strip()
        pct = int(pct_str)
        resets_at = resets_at.strip()

        is_5h = "Five Hour" in l_type
        is_weekly = "Weekly" in l_type
        is_daily = "Daily" in l_type

        type_code = "five_hour" if is_5h else ("weekly" if is_weekly else "daily")
        type_label = "5小时滑动额度 (消失额度)" if is_5h else ("周额度" if is_weekly else "每日额度")

        items.append({
            "model": m_name,
            "type": type_code,
            "type_name": l_type,
            "label": type_label,
            "percentage": pct,
            "resets_at": resets_at,
        })
    return items


def _parse_credits_output(credits_text: str) -> int:
    m = re.search(r"Remaining credits\s+(\d+)", credits_text)
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            pass
    return 0


async def _fetch_quota_from_agy(force: bool = False) -> dict:
    async with _quota_lock:
        now = time.time()
        if not force and _quota_cache["data"] and (now - _quota_cache["timestamp"] < 45.0):
            res = dict(_quota_cache["data"])
            res["cached"] = True
            return res

        retry_delay = _quota_cache.get("retry_at", 0.0) - time.monotonic()
        if retry_delay > 0:
            raise HTTPException(
                status_code=_quota_cache.get("error_status", 504),
                detail=_quota_cache.get("error_detail", "获取额度暂时不可用，请稍后刷新重试"),
                headers={"Retry-After": str(max(1, int(retry_delay + 0.999)))},
            )

        proc_usage = proc_credits = None
        try:
            proc_usage = await asyncio.create_subprocess_exec(
                AGY_BIN, "-p=/usage",
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(SCRATCH),
                env=_agy_environment(),
                start_new_session=os.name == "posix",
            )
            proc_credits = await asyncio.create_subprocess_exec(
                AGY_BIN, "-p=/credits",
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(SCRATCH),
                env=_agy_environment(),
                start_new_session=os.name == "posix",
            )

            (out_usage, _), (out_credits, _) = await asyncio.wait_for(
                asyncio.gather(proc_usage.communicate(), proc_credits.communicate()),
                timeout=QUOTA_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            logger.warning("agy usage/credits timed out")
            _quota_cache.update(retry_at=time.monotonic() + QUOTA_RETRY_SECONDS,
                                error_status=504, error_detail="获取额度超时，请稍后刷新重试")
            raise HTTPException(status_code=504, detail="获取额度超时，请稍后刷新重试")
        except Exception as exc:
            logger.error("Error executing agy usage: %s", exc)
            _quota_cache.update(retry_at=time.monotonic() + QUOTA_RETRY_SECONDS,
                                error_status=500, error_detail="获取额度失败，请稍后重试")
            raise HTTPException(status_code=500, detail=f"获取额度失败: {exc}")
        finally:
            await asyncio.gather(reap_cli_process(proc_usage), reap_cli_process(proc_credits))

        usage_text = out_usage.decode("utf-8", errors="replace")
        credits_text = out_credits.decode("utf-8", errors="replace")

        quotas = _parse_usage_output(usage_text)
        credits_val = _parse_credits_output(credits_text)

        current_email = "未知账号"
        if ACTIVE_TOKEN_FILE.exists():
            try:
                info = _get_token_account_info(json.loads(ACTIVE_TOKEN_FILE.read_text()))
                current_email = info.get("email") or current_email
            except Exception:
                pass

        data = {
            "ok": True,
            "email": current_email,
            "quotas": quotas,
            "credits": credits_val,
            "timestamp": now,
        }

        _quota_cache["data"] = data
        _quota_cache["timestamp"] = now
        _quota_cache["retry_at"] = 0.0
        res = dict(data)
        res["cached"] = False
        return res


@app.get("/api/quota")
async def get_quota_ep(force: bool = False) -> dict:
    return await _fetch_quota_from_agy(force=force)


@app.get("/api/accounts")
async def list_accounts_ep(force: bool = False) -> dict:
    accs = _list_stored_accounts()
    _schedule_tier_refresh(accs, force=force)
    active_email = next((a["email"] for a in accs if a["active"]), None)
    return {"ok": True, "active_account": active_email, "accounts": accs}


@app.post("/api/accounts/switch")
async def switch_account_ep(req: SwitchAccountRequest) -> dict:
    return _switch_to_account(req.id)


@app.post("/api/accounts/add")
async def add_account_ep(req: AddAccountRequest) -> dict:
    raw = req.token_json or req.token or ""
    result = _save_new_account(raw, alias=req.alias, switch_now=req.switch_now)
    acc_id = result.get("id")
    if isinstance(acc_id, str) and acc_id:
        _remove_tier_cache_entry(acc_id)
        _schedule_tier_refresh([{"id": acc_id}], force=True)
    return result


@app.delete("/api/accounts/{account_id}")
async def delete_account_ep(account_id: str) -> dict:
    return _delete_stored_account(account_id)


_SSE_HEARTBEAT_SECONDS = 15


def _turn_response(turn, cursor: int = 0):
    async def event_gen():
        # Cancelling this subscriber never cancels the separately owned CLI task.
        async for event in turn.events(cursor, _SSE_HEARTBEAT_SECONDS):
            yield ": keep-alive\n\n" if event is None else f"data: {json.dumps(event)}\n\n"
    return StreamingResponse(event_gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform",
                                      "Connection": "keep-alive", "X-Accel-Buffering": "no"})


@app.get("/api/turns/{turn_id}")
async def get_web_turn(turn_id: str):
    turn = web_turns.turns.get(turn_id)
    if not turn:
        raise HTTPException(status_code=404, detail="Turn not found")
    return dict(turn.info(), message=turn.snapshot()["message"])


@app.get("/api/turns/{turn_id}/events")
async def resume_web_turn(turn_id: str, cursor: int = 0):
    turn = web_turns.turns.get(turn_id)
    if not turn:
        raise HTTPException(status_code=404, detail="Turn not found")
    return _turn_response(turn, max(0, cursor))


class InjectTurnMessageRequest(BaseModel):
    content: str = ""
    attachments: list[dict] | None = None
    client_attachments: list[dict] | None = None
    message_id: str | None = None


@app.post("/api/turns/{turn_id}/stop")
async def stop_web_turn(turn_id: str):
    result = await web_turns.stop(turn_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Turn not found")
    return result


@app.post("/api/turns/{turn_id}/messages")
async def inject_web_turn_message(turn_id: str, req: InjectTurnMessageRequest):
    turn = web_turns.turns.get(turn_id)
    if not turn or turn.status != "running":
        raise HTTPException(status_code=409, detail="Turn is not running")
    formatted = _format_message_content(Message(role="user", content=req.content, attachments=req.attachments))
    if not formatted.strip():
        raise HTTPException(status_code=422, detail="Message content must not be empty")
    persisted_attachments = req.client_attachments if req.client_attachments is not None else req.attachments
    result = await web_turns.inject(
        turn_id,
        req.content,
        formatted_prompt=formatted,
        attachments=persisted_attachments,
        message_id=req.message_id,
    )
    if result is None:
        raise HTTPException(status_code=409, detail="Turn does not accept live messages")
    return {"ok": True, **result}


_HISTORY_TRUNCATE_MARKER = "\n... [内容过长已截断] ...\n"
_HISTORY_MAX_BYTES = 48 * 1024
_CLAUDE_AGY_HISTORY_MAX_BYTES = 96 * 1024
_HISTORY_MIN_EXCERPT_BYTES = 512
_FENCE_LINE_RE = re.compile(r"^[ ]{0,3}(`{3,}|~{3,})")


def _scan_unclosed_fence(chunk: str) -> str | None:
    open_fence: str | None = None
    for line in chunk.splitlines():
        m = _FENCE_LINE_RE.match(line)
        if not m:
            continue
        token = m.group(1)
        if open_fence is None:
            open_fence = token
        elif token[0] == open_fence[0] and len(token) >= len(open_fence) and not line[m.end() :].strip():
            open_fence = None
    return open_fence[:3] if open_fence else None


def _truncate_utf8_head_tail(text: str, max_bytes: int) -> str:
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text
    marker_bytes = _HISTORY_TRUNCATE_MARKER.encode("utf-8")
    fence_slack = 10
    if max_bytes <= len(marker_bytes) + fence_slack + 16:
        return encoded[:max(0, max_bytes)].decode("utf-8", errors="ignore")
    budget = max_bytes - len(marker_bytes) - fence_slack
    head_budget = budget // 2
    tail_budget = budget - head_budget
    head = encoded[:head_budget].decode("utf-8", errors="ignore").rstrip()
    tail = encoded[-tail_budget:].decode("utf-8", errors="ignore").lstrip()
    head_fence = _scan_unclosed_fence(head)
    tail_fence = _scan_unclosed_fence(tail)
    close_head = f"\n{head_fence}" if head_fence else ""
    open_tail = f"{tail_fence}\n" if tail_fence else ""
    return f"{head}{close_head}{_HISTORY_TRUNCATE_MARKER}{open_tail}{tail}"


def _summarize_assistant_tool_steps(row: dict) -> str:
    """Build a compact single-line summary of prior tool calls so stateless Claude->agy turns retain file/command context."""
    steps = row.get("steps")
    if not isinstance(steps, list) or not steps:
        return ""
    items: list[str] = []
    for step in steps:
        if not isinstance(step, dict) or step.get("type") != "tool_use":
            continue
        label = str(step.get("toolLabel") or step.get("toolName") or "").strip()
        inp = step.get("toolInput")
        if isinstance(inp, dict):
            raw_name = str(step.get("toolName") or label)
            short_fast = re.sub(r"^(?:mcp_ide-tools_)?(?:mcp__agy-fast_[^_]+__|mcp_agy-fast_[^_]+_|agy-fast:)", "", raw_name)
            if short_fast in ("apply_edits", "batch_search", "quick_outline", "read_slices", "run_checks"):
                edits = inp.get("edits")
                if isinstance(edits, list) and edits:
                    paths = [Path(str(e.get("path"))).name for e in edits[:3] if isinstance(e, dict) and e.get("path")]
                    suffix = f" +{len(edits) - 3}" if len(edits) > 3 else ""
                    label = f"{short_fast}({', '.join(paths)}{suffix})" if paths else f"{short_fast}({len(edits)} files)"
                elif isinstance(inp.get("paths"), list) and inp["paths"]:
                    paths = [Path(str(p)).name for p in inp["paths"][:3] if p]
                    suffix = f" +{len(inp['paths']) - 3}" if len(inp["paths"]) > 3 else ""
                    label = f"{short_fast}({', '.join(paths)}{suffix})"
                elif isinstance(inp.get("toolSummary"), str) and inp["toolSummary"].strip():
                    label = f"{short_fast}: {inp['toolSummary'].strip()[:48]}"
        if not label:
            continue
        label = re.sub(r"\s+", " ", label)[:72]
        if step.get("status") in ("error", "failed"):
            label += " [err]"
        if not items or items[-1] != label:
            items.append(label)
    if not items:
        return ""
    omitted = max(0, len(items) - 10)
    shown = items[-10:]
    prefix = f"+{omitted} earlier, " if omitted else ""
    summary = f"[Prior tool actions: {prefix}{'; '.join(shown)}]"
    return summary[:520]


def _soften_messages_for_outbound(messages: list[Message]) -> tuple[list[Message], list[str]]:
    """Soften user message text and strip conflicting foreign persona blocks without mutating saved chat snapshots."""
    out: list[Message] = []
    all_hits: list[str] = []
    for m in messages:
        if m.role == "user" and m.content:
            cleaned, foreign_removed = strip_foreign_armor(m.content)
            softened, hits = soften_prompt(cleaned)
            if foreign_removed > 0:
                hits = [*hits, "foreign-armor-stripped"]
            if hits or softened != m.content:
                all_hits.extend(hits)
                out.append(m.model_copy(update={"content": softened}))
                continue
        out.append(m)
    return out, all_hits


def _recent_saved_messages(
    history: list[dict],
    max_bytes: int = _HISTORY_MAX_BYTES,
    *,
    soften_user: bool = False,
    sanitize_transam: bool = False,
    include_tool_summary: bool = False,
) -> list[Message]:
    # Leave room for Claude's system instructions and tool definitions.
    recent: list[Message] = []
    remaining = max_bytes
    seen_latest_assistant = False
    for row in reversed(history):
        if row.get("role") not in ("user", "assistant") or row.get("status") in ("error", "stopped"):
            continue
        raw_content = row.get("content") if isinstance(row.get("content"), str) else ""
        if sanitize_transam and raw_content and row.get("role") == "assistant":
            raw_content = sanitize_transam_history_content(
                raw_content,
                is_latest_assistant=not seen_latest_assistant,
            )
            seen_latest_assistant = True
        if soften_user and raw_content:
            raw_content, _ = strip_block_echo(raw_content)
            raw_content, _ = strip_foreign_armor(raw_content)
            if row.get("role") == "assistant" and is_pure_history_refusal(raw_content):
                # Prevent prior unarmored refusals or filter blocks from poisoning subsequent turns.
                continue
            if row.get("role") == "user":
                raw_content, _ = soften_prompt(raw_content)
        if include_tool_summary and row.get("role") == "assistant":
            tool_summary = _summarize_assistant_tool_steps(row)
            if tool_summary:
                raw_content = f"{tool_summary}\n{raw_content}" if raw_content.strip() else tool_summary
        attachments = row.get("attachments") if isinstance(row.get("attachments"), list) else None
        formatted = _format_message_content(Message(role=row["role"], content=raw_content, attachments=attachments))
        if not formatted.strip():
            continue
        encoded = formatted.encode("utf-8")
        if len(encoded) > remaining:
            if remaining >= _HISTORY_MIN_EXCERPT_BYTES:
                recent.append(Message(role=row["role"], content=_truncate_utf8_head_tail(formatted, remaining)))
            break
        remaining -= len(encoded)
        recent.append(Message(role=row["role"], content=formatted))
    recent.reverse()
    return recent


def _render_claude_agy_prompt(history_messages: list[Message], current_messages: list[Message]) -> str:
    """Format user prompt for Claude Code without injecting native agy's no-tool system prompt."""
    if not history_messages and len(current_messages) == 1 and current_messages[0].role == "user":
        return _format_message_content(current_messages[0])
    lines: list[str] = []
    if history_messages:
        lines.append("--- Prior conversation ---")
        for m in history_messages:
            role = {"user": "User", "assistant": "Assistant", "system": "System"}.get(
                m.role, m.role.capitalize()
            )
            lines.append(f"{role}: {_format_message_content(m)}")
        lines.append("--- End prior conversation ---")
        lines.append("")
    if len(current_messages) == 1 and current_messages[0].role == "user":
        lines.append(_format_message_content(current_messages[0]))
    else:
        for m in current_messages:
            role = {"user": "User", "assistant": "Assistant", "system": "System"}.get(
                m.role, m.role.capitalize()
            )
            lines.append(f"{role}: {_format_message_content(m)}")
    return "\n".join(lines)


_ORCHESTRATOR_MODEL_ID_RE = re.compile(
    r"^gemini-[a-z0-9.]*-?orchestrator(?:-[a-z0-9.]+)?$",
    re.IGNORECASE,
)
_ORCHESTRATOR_LABEL_RE = re.compile(r"^Orchestrator\b", re.IGNORECASE)

# Appended via official `agy acp` `_meta.antigravity.systemPrompt.append` when
# Claude -> agy mode is active with an Orchestrator model. Enhances engineering
# workflow without spoofing identity or disabling agy's native toolset /
# Gemini 4 Hydrogen handoff.
CLAUDE_CODE_ORCHESTRATOR_PROMPT = (
    "Engineering workflow guidance (Claude Code style):\n"
    "- Read and inspect relevant files before editing; never guess file contents, paths, or symbols.\n"
    "- Prefer dedicated file, search, and edit tools over raw shell commands when available, and run independent read-only inspections in parallel.\n"
    "- When you have enough information to act, act directly without redundant preamble or narrating unused alternatives.\n"
    "- Keep changes focused on the user's goal, verify edits with relevant typecheck/tests/build commands, and report outcomes faithfully (exact test results, any failures, or any skipped steps) without hedging.\n"
    "- Before destructive, hard-to-reverse, or outward-facing actions (such as deleting files, pushing, or publishing), inspect the target and confirm unless explicitly instructed.\n"
    "- Keep responses concise, structured in GitHub-flavored Markdown, and reference files with clickable paths."
)


def _is_orchestrator_model(model: str | None, model_label: str | None = None) -> bool:
    model_id = (model or "").strip()
    if "/" in model_id:
        model_id = model_id.rsplit("/", 1)[-1]
    if _ORCHESTRATOR_MODEL_ID_RE.match(model_id):
        return True
    label = (model_label or _models_label_map.get(model_id) or "").strip()
    return bool(_ORCHESTRATOR_LABEL_RE.match(label))


def _claude_agy_system_append(system: str | None) -> str:
    parts: list[str] = []
    if system and system.strip():
        parts.append(system.strip())
    if not any(DOWNLOAD_LINK_INSTRUCTION in part for part in parts):
        parts.append(DOWNLOAD_LINK_INSTRUCTION)
    return "\n\n".join(parts)


def _claude_agy_orchestrator_system_append(
    system: str | None,
    output_style: dict[str, Any] | None = None,
) -> str:
    parts: list[str] = []
    if not output_style or output_style.get("keep_coding_instructions", False):
        parts.append(CLAUDE_CODE_ORCHESTRATOR_PROMPT)
    if output_style and output_style.get("body"):
        parts.append(str(output_style["body"]).strip())
    base = _claude_agy_system_append(system)
    if base:
        parts.append(base)
    return "\n\n".join(parts)


def _prompt_with_saved_history(
    req: ChatRequest,
    history: list[dict],
    *,
    claude_agy: bool = False,
    soften_history: bool = False,
    sanitize_transam: bool = False,
) -> str:
    recent = _recent_saved_messages(
        history,
        max_bytes=_CLAUDE_AGY_HISTORY_MAX_BYTES if claude_agy else _HISTORY_MAX_BYTES,
        soften_user=soften_history,
        sanitize_transam=sanitize_transam,
        include_tool_summary=claude_agy,
    )
    if claude_agy:
        return _render_claude_agy_prompt(recent, req.messages)
    return _render_prompt([*recent, *req.messages], req.system, thinking=req.thinking)


def _resolve_conversation_route(cid: str | None, saved: list[dict]) -> tuple[bool, str | None]:
    if cid and _conversation_needs_replay(cid):
        return True, None
    previous_route = next(
        (
            row["routeInfo"]
            for row in reversed(saved)
            if row.get("role") == "assistant"
            and row.get("status") not in ("error", "stopped")
            and isinstance(row.get("routeInfo"), dict)
        ),
        {},
    )
    replay_native = bool(cid and previous_route.get("transport") == "claude_agy")
    native_id = _sanitize_token(previous_route.get("native_conversation_id")) or cid
    if cid and cid.startswith("mintcli-claude-") and native_id == cid:
        replay_native = True
    return replay_native, native_id


def _pick_default_claude_agy_model(items: list[dict]) -> str | None:
    first_valid: str | None = None
    for item in items:
        model_id = item.get("id") if isinstance(item, dict) else None
        if not isinstance(model_id, str) or not model_id.strip():
            continue
        clean_id = model_id.strip()
        if first_valid is None:
            first_valid = clean_id
        if not _is_orchestrator_model(clean_id, item.get("name")):
            return clean_id
    return first_valid


async def _default_claude_agy_model() -> str:
    if _models_cache and _models_cache[1]:
        picked = _pick_default_claude_agy_model(_models_cache[1])
        if picked:
            return picked
    try:
        discovered = await models()
        items = discovered.get("models") if isinstance(discovered, dict) else None
        if isinstance(items, list) and items:
            picked = _pick_default_claude_agy_model(items)
            if picked:
                return picked
    except Exception:
        logger.debug("Falling back to static model map for Claude → agy default model", exc_info=True)
    return next(iter(_models_label_map), "gemini-3.8-flash-low")


@app.post("/api/chat")
async def chat(req: ChatRequest):
    """Start a server-owned turn and subscribe the custom UI to its events."""
    if not req.messages:
        raise HTTPException(status_code=422, detail="messages must be non-empty")

    outbound_req = req
    armor_hits: list[str] = []
    if req.use_armor:
        softened_messages, armor_hits = _soften_messages_for_outbound(req.messages)
        if armor_hits:
            outbound_req = req.model_copy(update={"messages": softened_messages})

    prompt, cid, continue_last, user_id = await _resolve_prompt_and_session(outbound_req)

    if req.use_claude_agy and req.api_connection:
        raise HTTPException(status_code=400, detail="Claude → agy 模式需要已登录的 agy 账号。")
    turn_account_id: str | None = None
    if not req.api_connection:
        if req.account_id:
            account_file = _resolve_account_file(req.account_id)
            if not account_file or not account_file.exists():
                raise HTTPException(status_code=404, detail=f"账号 '{req.account_id}' 不存在")
            try:
                account_data = json.loads(account_file.read_text())
            except Exception:
                raise HTTPException(status_code=400, detail=f"账号 '{req.account_id}' 凭证无效")
            if not _has_valid_token(account_data):
                raise HTTPException(status_code=400, detail=f"账号 '{req.account_id}' 凭证无效")
            turn_account_id = account_file.stem
        else:
            turn_account_id = _active_account_id()
    saved = read_message_history(cid) if cid else []
    if cid and req.history_revision is not None and req.history_revision != message_revision(saved):
        raise HTTPException(status_code=409, detail="聊天记录已在其他设备更新，请同步后重新发送。")
    replay_native, native_id = _resolve_conversation_route(cid, saved)

    bound_turn: list[Any] = []
    pending_injector: list[Any] = [None]

    def register_injector(handler) -> None:
        pending_injector[0] = handler
        if bound_turn:
            bound_turn[0].set_injector(handler)

    async def stream():
        if turn_account_id:
            _active_account_turns[turn_account_id] = _active_account_turns.get(turn_account_id, 0) + 1
        armor_home_lease = ""
        transam_home_lease = ""
        try:
            effective_prompt = prompt
            last_user_text = outbound_req.messages[-1].content if outbound_req.messages else prompt
            transam_continue = (
                is_continue_prompt(last_user_text) and has_transam_history_tags(saved)
                if req.use_transam
                else False
            )
            transam_meta: dict[str, Any] | None = None
            agy_fast_cfg: dict[str, Any] | None = None
            agy_fast_meta: dict[str, Any] | None = None
            if req.use_agy_fast and not req.api_connection:
                agy_fast_cfg, agy_fast_meta = await asyncio.to_thread(_resolve_agy_fast_turn)
            fast_turn_key = cid or f"turn-{uuid.uuid4().hex}"
            include_fast_snapshot = bool(cid) or not (saved or continue_last)
            if req.use_armor and armor_hits:
                logger.info("Armor: 出站软化改写命中 %d 项: %s", len(armor_hits), armor_hits)
            effective_cwd = _within_allowed(req.cwd) or str(SCRATCH)
            run_env: dict[str, str] | None = None
            if not req.api_connection:
                run_env = _agy_environment(account_id=turn_account_id) if turn_account_id else _agy_environment()
            effective_home = (run_env.get("HOME") if run_env else None) or HOME
            requested_model = (req.model or "").strip()
            resolved_model = (
                requested_model
                if (not req.use_claude_agy or (requested_model and requested_model != "default"))
                else await _default_claude_agy_model()
            )
            # ACP and Claude->agy inject Armor & TRANS-AM per-request via system_append;
            # only sync 00-armor.md / 01-transam.md on disk for non-ACP CLI fallback (api_connection).
            armor_home_lease = _sync_armor_rules_concurrency_safe(
                bool(req.use_armor and req.api_connection),
                target_cwd=effective_cwd,
                agy_home=effective_home,
            )
            transam_home_lease = _sync_transam_rules_concurrency_safe(
                bool(req.use_transam and req.api_connection),
                target_cwd=effective_cwd,
                agy_home=effective_home,
                model=resolved_model,
                model_label=req.model_label,
            )

            if req.use_claude_agy:
                target_cwd = effective_cwd
                model = resolved_model
                if run_env is None:
                    run_env = _agy_environment(account_id=turn_account_id) if turn_account_id else _agy_environment()
                agy_home = run_env.get("HOME") or HOME
                updater = globals().get("project_updater")
                if _is_orchestrator_model(model, req.model_label):
                    # Orchestrator models pair a planner (Neon/Carbon/Argon) with Gemini 4 Hydrogen
                    # using agy's own native tools. Run directly via official `agy acp` so the
                    # native handoff and full model capability remain intact, while appending
                    # Claude Code engineering workflow guidance via official ACP systemPrompt.append.
                    stable_id = cid if replay_native or native_id != cid else None
                    native_id_for_turn = None if replay_native else native_id
                    if replay_native:
                        acp_prompt = _prompt_with_saved_history(
                            outbound_req,
                            saved,
                            claude_agy=True,
                            soften_history=req.use_armor,
                            sanitize_transam=req.use_transam,
                        )
                        fallback_prompt = None
                    elif native_id_for_turn:
                        acp_prompt = _format_message_content(outbound_req.messages[-1]) if outbound_req.messages else ""
                        if req.thinking and acp_prompt:
                            acp_prompt = f"{THINKING_PROMPT_PREFIX}\n\n{acp_prompt}"
                        fallback_prompt = (
                            _prompt_with_saved_history(
                                outbound_req,
                                saved,
                                claude_agy=True,
                                soften_history=req.use_armor,
                                sanitize_transam=req.use_transam,
                            )
                            if saved
                            else None
                        )
                    else:
                        acp_prompt = _render_claude_agy_prompt([], outbound_req.messages)
                        if req.thinking and acp_prompt:
                            acp_prompt = f"{THINKING_PROMPT_PREFIX}\n\n{acp_prompt}"
                        fallback_prompt = None
                    if req.use_transam:
                        acp_prompt, transam_meta = build_transam_turn_prompt(
                            acp_prompt,
                            model=model,
                            model_label=req.model_label,
                            is_continue=transam_continue,
                        )
                        if fallback_prompt:
                            fallback_prompt, _ = build_transam_turn_prompt(
                                fallback_prompt,
                                model=model,
                                model_label=req.model_label,
                                is_continue=transam_continue,
                                dice=transam_meta["dice"],
                            )
                    lease = updater.acquire_turn() if updater else None

                    active_output_style = resolve_active_claude_output_style(run_env, target_cwd)

                    def _orchestrator_route_factory(request_id: str | None, requested: str | None) -> dict:
                        info = _new_route_info(request_id, requested)
                        info["transport"] = "acp"
                        info["prompt_mode"] = "claude_code_enhanced"
                        if active_output_style:
                            info["output_style"] = active_output_style["name"]
                        if transam_meta:
                            info["transam"] = dict(transam_meta)
                        return info

                    orch_include_snapshot = (
                        not native_id_for_turn
                        or bool(fallback_prompt)
                        or has_agy_fast_session_snapshot(cid, target_cwd)
                    )
                    orch_system_append = await _compose_system_append_async(
                        _claude_agy_orchestrator_system_append(req.system, output_style=active_output_style),
                        use_armor=req.use_armor,
                        use_transam=req.use_transam,
                        use_agy_fast=bool(agy_fast_meta),
                        agy_fast_mode="acp",
                        target_cwd=target_cwd,
                        include_agy_fast_snapshot=orch_include_snapshot,
                        agy_fast_session_key=fast_turn_key,
                        agent_tools=True,
                        model=model,
                        model_label=req.model_label,
                        is_continue=transam_continue,
                    )
                    try:
                        async for event in stream_agy_acp(
                            agy_bin=AGY_BIN,
                            prompt=acp_prompt,
                            fallback_prompt=fallback_prompt,
                            model=model,
                            target_cwd=target_cwd,
                            run_env=run_env,
                            scratch_dir=SCRATCH,
                            conversation_id=native_id_for_turn,
                            user_id=user_id,
                            persist_conversation=stable_id is None and AGY_PERSIST_CONVERSATIONS,
                            save_conversation_cb=save_conversation_async if AGY_PERSIST_CONVERSATIONS else None,
                            route_info_factory=_orchestrator_route_factory,
                            route_enricher=lambda info, trace: _apply_claude_agy_trace(info, agy_home, trace),
                            system_append=orch_system_append,
                            update_lease=lease,
                            timeout=0,
                            register_injector=register_injector,
                            use_armor=req.use_armor,
                            mcp_servers=(agy_fast_cfg["acp_mcp_servers"] if agy_fast_cfg and agy_fast_meta else None),
                            agy_fast_info=agy_fast_meta,
                            is_shutting_down=lambda: web_turns.shutting_down,
                        ):
                            if event.get("event") == "init" and event.get("conversation_id") and agy_fast_meta:
                                bind_agy_fast_session_snapshot(
                                    stable_id or event["conversation_id"],
                                    target_cwd,
                                    fast_turn_key,
                                )
                            if stable_id:
                                if event.get("event") == "init" and event.get("conversation_id"):
                                    native_id_for_turn = event["conversation_id"]
                                    if replay_native:
                                        await set_conversation_needs_replay_async(stable_id, False)
                                if event.get("conversation_id"):
                                    event["conversation_id"] = stable_id
                                if event.get("route_info") and native_id_for_turn and native_id_for_turn != stable_id:
                                    event["route_info"]["native_conversation_id"] = native_id_for_turn
                            if transam_meta and isinstance(event.get("route_info"), dict):
                                event["route_info"]["transam"] = dict(transam_meta)
                            yield event
                    finally:
                        if lease:
                            lease.close()
                    return

                active_output_style = resolve_active_claude_output_style(run_env, target_cwd)
                stable_id = cid or "mintcli-claude-" + uuid.uuid4().hex
                route = _new_route_info(uuid.uuid4().hex, model)
                route["transport"] = "claude_agy"
                route["cli_config_model"] = model
                if active_output_style:
                    route["output_style"] = active_output_style["name"]
                if req.use_armor:
                    route["armor"] = {"enabled": True, "status": "armed", "retries": 0}
                if agy_fast_meta:
                    route["agy_fast"] = dict(agy_fast_meta)
                claude_prompt = _prompt_with_saved_history(
                    outbound_req,
                    saved,
                    claude_agy=True,
                    soften_history=req.use_armor,
                    sanitize_transam=req.use_transam,
                )
                if req.use_transam:
                    claude_prompt, transam_meta = build_transam_turn_prompt(
                        claude_prompt,
                        model=model,
                        model_label=req.model_label,
                        is_continue=transam_continue,
                    )
                    route["transam"] = dict(transam_meta)
                claude_system_append = await _compose_system_append_async(
                    _claude_agy_system_append(req.system),
                    use_armor=req.use_armor,
                    use_transam=req.use_transam,
                    use_agy_fast=bool(agy_fast_meta),
                    agy_fast_mode="claude_agy",
                    target_cwd=target_cwd,
                    include_agy_fast_snapshot=include_fast_snapshot,
                    agy_fast_session_key=stable_id,
                    agent_tools=True,
                    model=model,
                    model_label=req.model_label,
                    is_continue=transam_continue,
                )
                lease = updater.acquire_turn() if updater else None
                last_route_payload = json.dumps(route, sort_keys=True, ensure_ascii=False)
                saw_trace = False
                try:
                    if AGY_PERSIST_CONVERSATIONS:
                        await save_conversation_async(user_id, stable_id)
                    yield {"event": "init", "conversation_id": stable_id, "route_info": json.loads(json.dumps(route))}
                    async for event in stream_claude_agy(
                        agy_bin=AGY_BIN, env=run_env, cwd=target_cwd,
                        scratch=SCRATCH,
                        prompt=claude_prompt,
                        model=model, turn_id=route["request_id"], sandbox=AGY_SANDBOX,
                        system_append=claude_system_append,
                        register_injector=register_injector,
                        use_armor=req.use_armor,
                        use_agy_fast=bool(agy_fast_meta),
                        agy_fast_mcp_servers=(agy_fast_cfg["claude_mcp_servers"] if agy_fast_cfg and agy_fast_meta else None),
                        agy_fast_allowed_tools=(agy_fast_cfg["claude_allowed_tools"] if agy_fast_cfg and agy_fast_meta else None),
                        is_shutting_down=lambda: web_turns.shutting_down,
                    ):
                        if event.get("event") == "armor_status":
                            route["armor"] = {
                                "enabled": True,
                                "status": event.get("status", "armed"),
                                "retries": int(event.get("retries") or 0),
                            }
                            encoded = json.dumps(route, sort_keys=True, ensure_ascii=False)
                            if encoded != last_route_payload:
                                last_route_payload = encoded
                                yield {"event": "metadata", "route_info": json.loads(json.dumps(route))}
                            continue
                        if event.get("event") == "agy_trace":
                            saw_trace = True
                            await asyncio.to_thread(_apply_claude_agy_trace, route, agy_home, event)
                            encoded = json.dumps(route, sort_keys=True, ensure_ascii=False)
                            if event.get("final") or encoded != last_route_payload:
                                last_route_payload = encoded
                                yield {"event": "metadata", "route_info": json.loads(json.dumps(route))}
                            continue
                        yield event
                    if saw_trace:
                        await asyncio.to_thread(_apply_claude_agy_trace, route, agy_home, {})
                        encoded = json.dumps(route, sort_keys=True, ensure_ascii=False)
                        if encoded != last_route_payload:
                            yield {"event": "metadata", "route_info": json.loads(json.dumps(route))}
                finally:
                    if lease:
                        lease.close()
                return

            stable_id = cid if replay_native or native_id != cid else None
            native_id_for_turn = None if replay_native else native_id
            fallback_prompt = (
                _prompt_with_saved_history(
                    outbound_req,
                    saved,
                    claude_agy=False,
                    soften_history=req.use_armor,
                    sanitize_transam=req.use_transam,
                )
                if (not req.api_connection and native_id_for_turn and saved and not replay_native)
                else None
            )
            primary_prompt = (
                _prompt_with_saved_history(
                    outbound_req,
                    saved,
                    claude_agy=False,
                    soften_history=req.use_armor,
                    sanitize_transam=req.use_transam,
                )
                if replay_native
                else effective_prompt
            )
            if req.use_transam:
                primary_prompt, transam_meta = build_transam_turn_prompt(
                    primary_prompt,
                    model=req.model,
                    model_label=req.model_label,
                    is_continue=transam_continue,
                )
                if fallback_prompt:
                    fallback_prompt, _ = build_transam_turn_prompt(
                        fallback_prompt,
                        model=req.model,
                        model_label=req.model_label,
                        is_continue=transam_continue,
                        dice=transam_meta["dice"],
                    )
            acp_include_snapshot = (
                (not native_id_for_turn and not continue_last)
                or bool(fallback_prompt)
                or has_agy_fast_session_snapshot(cid, effective_cwd)
            )
            acp_system_append = await _compose_system_append_async(
                req.system,
                use_armor=req.use_armor,
                use_transam=req.use_transam,
                use_agy_fast=bool(agy_fast_meta),
                agy_fast_mode="acp",
                target_cwd=effective_cwd,
                include_agy_fast_snapshot=acp_include_snapshot,
                agy_fast_session_key=fast_turn_key,
                agent_tools=not req.api_connection,
                model=req.model,
                model_label=req.model_label,
                is_continue=transam_continue,
            )
            async for event in _stream_agy(
                prompt=primary_prompt,
                model=req.model, cwd=req.cwd,
                conversation_id=None if replay_native else native_id,
                continue_last=continue_last and not stable_id, user_id=user_id, timeout=0,
                persist_conversation=stable_id is None, api_connection=req.api_connection,
                fallback_prompt=fallback_prompt,
                system_append=acp_system_append,
                register_injector=register_injector,
                account_id=turn_account_id,
                use_armor=req.use_armor,
                mcp_servers=(agy_fast_cfg["acp_mcp_servers"] if agy_fast_cfg and agy_fast_meta else None),
                agy_fast_info=agy_fast_meta,
            ):
                if event.get("event") == "init" and event.get("conversation_id") and agy_fast_meta:
                    bind_agy_fast_session_snapshot(
                        stable_id or event["conversation_id"],
                        effective_cwd,
                        fast_turn_key,
                    )
                if stable_id:
                    if event.get("event") == "init" and event.get("conversation_id"):
                        native_id_for_turn = event["conversation_id"]
                        if replay_native:
                            await set_conversation_needs_replay_async(stable_id, False)
                    if event.get("conversation_id"):
                        event["conversation_id"] = stable_id
                    if event.get("route_info") and native_id_for_turn and native_id_for_turn != stable_id:
                        event["route_info"]["native_conversation_id"] = native_id_for_turn
                if transam_meta and isinstance(event.get("route_info"), dict):
                    event["route_info"]["transam"] = dict(transam_meta)
                if req.api_connection:
                    # Redact before WebTurn persists events or makes them available to reconnecting readers.
                    secret = req.api_connection.api_key.get_secret_value()
                    event = _redact_api_event(event, secret)
                yield event
        except Exception:
            if req.api_connection:
                raise RuntimeError("第三方 Gemini API 连接或返回格式异常") from None
            raise
        finally:
            _release_transam_turn_home(transam_home_lease)
            _release_armor_turn_home(armor_home_lease)
            if turn_account_id:
                remaining = _active_account_turns.get(turn_account_id, 1) - 1
                if remaining > 0:
                    _active_account_turns[turn_account_id] = remaining
                else:
                    _active_account_turns.pop(turn_account_id, None)
                _sync_account_home_token_to_storage(turn_account_id)
    snapshot = req.message_snapshot or [message.model_dump() for message in req.messages]
    try:
        turn = web_turns.start(stream, cid, snapshot, req.model, req.model_label or "", req.turn_id)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    bound_turn.append(turn)
    if pending_injector[0] is not None:
        turn.set_injector(pending_injector[0])
    return _turn_response(turn)


# --- Bonus: OpenAI-compatible endpoint so other tools can reuse this too ----- #

def _openai_stream_response(req: ChatRequest, source):
    """Adapt native events without buffering a whole answer or orphaning a CLI."""
    completion_id, created = f"agy-{uuid.uuid4().hex[:12]}", int(time.time())
    include_usage = bool((req.stream_options or {}).get("include_usage"))

    def frame(delta, finish_reason=None, **extra):
        value = {"id": completion_id, "object": "chat.completion.chunk", "created": created,
                 "model": req.model or "agy", "choices": [
                     {"index": 0, "delta": delta, "finish_reason": finish_reason}]}
        if include_usage:
            value["usage"] = None
        value.update(extra)
        return f"data: {json.dumps(value, ensure_ascii=False)}\n\n"

    async def events():
        pending = None
        has_text, usage = False, None
        metadata = _new_route_info(requested_model=req.model)
        try:
            yield frame({"role": "assistant", "content": ""})
            while True:
                if pending is None:
                    pending = asyncio.create_task(anext(source))
                try:
                    event = await asyncio.wait_for(asyncio.shield(pending), _SSE_HEARTBEAT_SECONDS)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                except StopAsyncIteration:
                    pending = None
                    break
                pending = None
                kind = event.get("event")
                if isinstance(event.get("route_info"), dict):
                    metadata = event["route_info"]
                    if isinstance(metadata, dict):
                        pass
                if kind == "error":
                    yield f'data: {json.dumps({"error": {"message": str(event.get("error") or "agy generation failed"), "type": "upstream_error", "code": "AGY_ERROR"}}, ensure_ascii=False)}\n\n'
                    return  # An error must not be followed by a successful stop chunk.
                content = ""
                if kind == "delta":
                    content = str(event.get("delta") or event.get("text") or "")
                elif kind == "result":
                    if not has_text and event.get("response"):
                        content = str(event["response"])
                    if isinstance(event.get("usage"), dict):
                        usage = event["usage"]
                if content:
                    has_text = True
                    yield frame({"content": content})
            yield frame({}, "stop", requested_model=req.model, response_metadata=metadata)
            if include_usage and usage is not None:
                prompt_tokens = usage.get("input_tokens", usage.get("prompt_tokens", 0))
                completion_tokens = usage.get("output_tokens", usage.get("completion_tokens", 0))
                yield frame({}, choices=[], usage={"prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "total_tokens": usage.get("total_tokens", prompt_tokens + completion_tokens)})
            yield "data: [DONE]\n\n"
        except Exception as error:
            logger.warning("Compatibility stream failed (%s)", type(error).__name__)
            yield f'data: {json.dumps({"error": {"message": str(error), "type": "upstream_error", "code": "AGY_ERROR"}}, ensure_ascii=False)}\n\n'
        finally:
            if pending is not None:
                pending.cancel()
                try:
                    await pending
                except (asyncio.CancelledError, Exception):
                    pass
            await source.aclose()

    return StreamingResponse(events(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


@app.post("/v1/chat/completions")
async def openai_chat(req: ChatRequest) -> Response:
    if not req.messages:
        raise HTTPException(status_code=422, detail="messages must be non-empty")
    
    outbound_req = req
    armor_hits: list[str] = []
    if req.use_armor:
        softened_messages, armor_hits = _soften_messages_for_outbound(req.messages)
        if armor_hits:
            outbound_req = req.model_copy(update={"messages": softened_messages})

    prompt, cid, continue_last, user_id = await _resolve_prompt_and_session(outbound_req)
    effective_cwd = _within_allowed(req.cwd) or str(SCRATCH)
    armor_compat_lease = _sync_armor_rules_concurrency_safe(
        bool(req.use_armor and req.api_connection),
        target_cwd=effective_cwd,
        agy_home=HOME,
    )
    transam_compat_lease = _sync_transam_rules_concurrency_safe(
        bool(req.use_transam and req.api_connection),
        target_cwd=effective_cwd,
        agy_home=HOME,
        model=req.model,
        model_label=req.model_label,
    )
    if req.use_transam:
        prompt, _ = build_transam_turn_prompt(
            prompt,
            model=req.model,
            model_label=req.model_label,
        )

    agy_fast_cfg: dict[str, Any] | None = None
    agy_fast_meta: dict[str, Any] | None = None
    if req.use_agy_fast and not req.api_connection:
        agy_fast_cfg, agy_fast_meta = await asyncio.to_thread(_resolve_agy_fast_turn)
    compat_fast_key = cid or f"compat-{uuid.uuid4().hex}"
    compat_system_append = await _compose_system_append_async(
        req.system,
        use_armor=req.use_armor,
        use_transam=req.use_transam,
        use_agy_fast=bool(agy_fast_meta),
        agy_fast_mode="acp",
        target_cwd=effective_cwd,
        include_agy_fast_snapshot=not continue_last or has_agy_fast_session_snapshot(cid, effective_cwd),
        agy_fast_session_key=compat_fast_key,
        agent_tools=not req.api_connection,
        model=req.model,
        model_label=req.model_label,
    )

    async def _guarded_compat_source():
        try:
            async for ev in _stream_agy(
                prompt=prompt,
                model=req.model,
                cwd=req.cwd,
                conversation_id=cid,
                continue_last=continue_last,
                user_id=user_id,
                api_connection=req.api_connection,
                system_append=compat_system_append,
                use_armor=req.use_armor,
                mcp_servers=(agy_fast_cfg["acp_mcp_servers"] if agy_fast_cfg and agy_fast_meta else None),
                agy_fast_info=agy_fast_meta,
            ):
                if ev.get("event") == "init" and ev.get("conversation_id") and agy_fast_meta:
                    bind_agy_fast_session_snapshot(ev["conversation_id"], effective_cwd, compat_fast_key)
                yield ev
        finally:
            _release_transam_turn_home(transam_compat_lease)
            _release_armor_turn_home(armor_compat_lease)

    source = _guarded_compat_source()
    if getattr(req, "stream", False):
        return _openai_stream_response(req, source)
    parts: list[str] = []
    error_msg: str | None = None
    response_metadata = _new_route_info(requested_model=req.model)
    async for ev in source:
        if isinstance(ev.get("route_info"), dict):
            response_metadata = ev["route_info"]
        if ev.get("event") == "segment_reset":
            parts.clear()
        elif ev.get("event") == "delta" and ev.get("delta"):
            parts.append(ev["delta"])
        elif ev.get("event") == "result" and not parts and ev.get("response"):
            parts.append(ev["response"])
        elif ev.get("event") == "error" and ev.get("error"):
            error_msg = ev["error"]

    if error_msg:
        raise HTTPException(status_code=500, detail=error_msg)

    content = "".join(parts).strip()
    return JSONResponse({
        "id": f"agy-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": req.model or "agy",
        "requested_model": req.model,
        "response_metadata": response_metadata,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": content},
            "finish_reason": "stop",
        }],
    })


@app.get("/v1/models")
async def openai_models() -> JSONResponse:
    m = await models()
    now = int(time.time())
    return JSONResponse({
        "object": "list",
        "data": [{"id": n["id"], "object": "model", "created": now, "owned_by": "antigravity"}
                 for n in m["models"]] or [{"id": "agy", "object": "model",
                                             "created": now, "owned_by": "antigravity"}],
    })


def main() -> None:
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=PORT, reload=False)


if __name__ == "__main__":
    main()
