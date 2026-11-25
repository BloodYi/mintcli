"""Minimal-impact Thinking Language Follower engine for MintCLI Antigravity Bridge.

Design principles for preserving coding capability:
1. Keep the system prompt directive completely static so upstream Prompt Cache is never invalidated.
2. Strip fenced/inline code, stack traces, diffs, paths, URLs, and code identifiers before detecting
   the user's natural language, preventing English error dumps from flipping Chinese/Japanese/Korean turns
   and preventing quoted CJK test literals from flipping English turns.
3. Inject a ~25-token transient `<system-reminder>` only at the outbound wire boundary when needed
   (zero extra tokens for normal English coding prompts; zero mutation of saved history or other plugins),
   explicitly preserving code snippets, symbols, paths, commands, raw errors, and technical terms verbatim.
"""

from __future__ import annotations

import re
from typing import Sequence

THINK_LANG_SYSTEM_DIRECTIVE = (
    "# Thinking Language Policy\n"
    "CRITICAL: Match the natural language of the user's latest message in BOTH your internal thinking/reasoning "
    "(thought blocks, chain-of-thought, planning, and tool-use reflections) AND your final response.\n"
    "- 无论系统提示、代码、日志或工具返回是否为英文，你的内部思考过程（thinking / thought）都必须从第一句起始终使用与用户最新自然语言提问相同的语言输出（例如用户用中文提问，则思考过程全程使用简体中文；用户用日文/韩文/英文提问，则使用对应语言）。\n"
    "- Keep code snippets, identifiers, file paths, CLI commands, API names, technical terms, and exact error/log quotes in their original form, while writing all reasoning and explanations around them in the user's language.\n"
    "- Do NOT drift back to English during multi-step tool calls or after reading English files/tool outputs; maintain the user's language throughout every thinking block of the turn."
)

_REMINDER_MARKER = "<!-- think-lang-reminder -->"

_SYSTEM_BLOCK_RE = re.compile(
    r"<(?:system-reminder|external_system_instructions)\b[^>]*>[\s\S]*?</(?:system-reminder|external_system_instructions)>",
    re.IGNORECASE,
)
_FENCED_CODE_RE = re.compile(r"(?:```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))")
_INLINE_CODE_RE = re.compile(r"`[^`\n]+`")
_ATTACHMENT_TAG_RE = re.compile(r"\[附带(?:图片|文件):[^\]]+\]")
_URL_RE = re.compile(r"(?:https?|wss?|file|ftp|ssh)://[^\s<>\"\)\]]+", re.IGNORECASE)
_ISO_LOG_PREFIX_RE = re.compile(r"^\s*\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}")
_DIFF_INDEX_RE = re.compile(r"^index [0-9a-f]{6,}\.\.[0-9a-f]{6,}")
_COMPILER_GUTTER_RE = re.compile(r"^(?:\d+\s*[|│]|-->\s+\S+:\d+|goroutine \d+ \[)")

# Match inline ASCII exception signatures while stopping before any non-ASCII char, newline, or new sentence.
_INLINE_ERROR_RE = re.compile(
    r"\b[A-Z][A-Za-z0-9_.]*(?:Error|Exception|Warning|Fault|Panic|Failure)\s*:\s*"
    r"(?:[\x20-\x7e]+?(?=(?:[.?!]\s+[A-Z]|$))|[\x20-\x7e]+)"
)

_FILE_PATH_RE = re.compile(
    r"(?:[A-Za-z]:\\[\\\w.\-]+|(?:\.\.?/)?[\w.\-]+/[\w./\-]+|\b[\w.\-]+\."
    r"(?:tsx?|jsx?|mjs|cjs|py|pyi|rs|go|java|kt|swift|cpp|cc|c|h|hpp|cs|rb|php|vue|svelte|"
    r"css|scss|less|html?|jsonc?|ya?ml|toml|ini|cfg|conf|md|mdx|sql|sh|bash|zsh|ps1|lock|log|txt))"
    r"(?::\d+(?::\d+)?)?",
    re.IGNORECASE,
)

_CODE_IDENT_RE = re.compile(
    r"\b(?:[a-z]+(?:[A-Z][a-z0-9]*)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+|"
    r"[A-Za-z0-9]+_[A-Za-z0-9_]+|[A-Z][A-Z0-9]{2,}|0x[0-9a-fA-F]+|[0-9a-f]{7,40})\b"
)

_SHORT_QUOTED_RE = re.compile(r"""(?:"(?:[^"\\\n]|\\.){1,40}"|'(?:[^'\\\n]|\\.){1,40}')""")

_KANA_RE = re.compile(r"[぀-ゟ゠-ヿ]")
_HANGUL_RE = re.compile(r"[가-힯ᄀ-ᇿ㄰-㆏]")
_CJK_RE = re.compile(r"[一-鿿]")
_CYRILLIC_RE = re.compile(r"[Ѐ-ӿ]")
_LATIN_WORD_RE = re.compile(r"\b[A-Za-z]{2,}\b")

_EN_FUNCTION_WORDS = frozenset({
    "the", "is", "are", "was", "were", "be", "to", "of", "and", "in", "that", "have", "it",
    "for", "not", "on", "with", "as", "you", "do", "at", "this", "but", "by", "from", "they",
    "we", "can", "will", "my", "all", "would", "there", "what", "so", "up", "out", "if",
    "about", "who", "get", "which", "when", "make", "like", "just", "know", "take", "into",
    "could", "see", "other", "than", "then", "now", "look", "only", "come", "its", "over",
    "think", "also", "use", "how", "our", "work", "first", "well", "way", "even", "new",
    "want", "because", "any", "these", "give", "most", "why", "does", "should", "please",
    "fix", "check", "explain", "help", "refactor", "update", "add", "remove",
})

_SIMP_CHARS_RE = re.compile(
    r"[们这为国个说时来会没对开进还发经现样动点线错报请帮让给从头实长问记认议级联调设试"
    r"块帧栈异优缓逻辑变参数组类码显态应处据库网链执输读写译断环构验检题结语随关闭启择响]"
)
_TRAD_CHARS_RE = re.compile(
    r"[們這為國個說時來會沒對開進還發經現樣動點線錯報請幫讓給從頭實長問記認議級聯調設試"
    r"塊幀棧異優緩邏輯變參數組類碼顯態應處據庫網鏈執輸讀寫譯斷環構驗檢題結語隨關閉啟擇響體學與後裡麼]"
)

_TURN_REMINDERS: dict[str, str] = {
    "zh-CN": (
        "请按以下步骤处理：\n"
        "1. 在内部思考（thought）中，全程使用简体中文逐点分析（保留代码片段、标识符、路径、报错原文与技术术语原样，不要使用英文句子思考）；\n"
        "2. 按上述要求使用简体中文完成作答。"
    ),
    "zh-TW": (
        "請按以下步驟處理：\n"
        "1. 在內部思考（thought）中，全程使用繁體中文逐點分析（保留程式碼片段、識別符、路徑、報錯原文與技術術語原樣，不要使用英文句子思考）；\n"
        "2. 按上述要求使用繁體中文完成作答。"
    ),
    "ja": (
        "以下の手順で処理してください：\n"
        "1. 内部思考（thought）では、終始日本語で順を追って分析すること（コード断片・識別子・パス・エラー原文・技術用語はそのまま保持し、英語の文で思考しないこと）；\n"
        "2. 上記の要求に従って日本語で回答すること。"
    ),
    "ko": (
        "다음 단계에 따라 처리하세요:\n"
        "1. 내부 사고(thought)에서는 처음부터 끝까지 한국어로 단계별 분석을 수행하세요(코드 조각, 식별자, 경로, 오류 원문 및 기술 용어는 원문 그대로 유지하고 영어 문장으로 사고하지 마세요);\n"
        "2. 위 요청에 따라 한국어로 답변을 완료하세요."
    ),
    "ru": (
        "Выполните запрос по следующим шагам:\n"
        "1. Во внутреннем размышлении (thought) ведите пошаговый анализ полностью на русском языке (сохраняя код, идентификаторы, пути, ошибки и термины без перевода, не используя английские предложения);\n"
        "2. Выполните запрос выше и ответьте на русском языке."
    ),
}

_EN_SWITCH_REMINDER = (
    "Follow these steps for this turn:\n"
    "1. Conduct your entire internal thinking (thought) in English while keeping code symbols and paths verbatim;\n"
    "2. Complete the request above and reply in English."
)


def get_think_lang_system_directive() -> str:
    return THINK_LANG_SYSTEM_DIRECTIVE


def _is_stack_or_log_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return True
    if stripped.startswith("at ") and ("(" in stripped or ":" in stripped or "/" in stripped or "\\" in stripped):
        return True
    if stripped == "Traceback (most recent call last):" or (stripped.startswith('File "') and ", line " in stripped):
        return True
    if stripped.startswith(("diff --git ", "--- a/", "+++ b/", "@@ -")) or _DIFF_INDEX_RE.match(stripped):
        return True
    if _COMPILER_GUTTER_RE.match(stripped):
        return True
    if _ISO_LOG_PREFIX_RE.match(stripped) and stripped.isascii():
        return True
    return False


def _filter_non_prose_lines(lines: list[str]) -> list[str]:
    kept: list[str] = []
    in_py_frame = False
    for raw_line in lines:
        stripped = raw_line.strip()
        if not stripped:
            in_py_frame = False
            continue
        if stripped == "Traceback (most recent call last):":
            in_py_frame = False
            continue
        if stripped.startswith('File "') and ", line " in stripped:
            in_py_frame = True
            continue
        if in_py_frame:
            # Skip indented source line and Python 3.11+ caret/tilde underline right after `File "...", line N`
            if raw_line.startswith((" ", "\t")) or set(stripped) <= {"^", "~", " "}:
                continue
            in_py_frame = False
        if _is_stack_or_log_line(raw_line):
            continue
        kept.append(raw_line)
    return kept


def _strip_non_prose(text: str, *, strip_quotes: bool) -> str:
    cleaned = _SYSTEM_BLOCK_RE.sub(" ", text)
    cleaned = _FENCED_CODE_RE.sub(" ", cleaned)
    cleaned = _INLINE_CODE_RE.sub(" ", cleaned)
    cleaned = _ATTACHMENT_TAG_RE.sub(" ", cleaned)
    cleaned = _URL_RE.sub(" ", cleaned)
    cleaned = "\n".join(_filter_non_prose_lines(cleaned.splitlines()))
    if strip_quotes:
        cleaned = _SHORT_QUOTED_RE.sub(" ", cleaned)
    cleaned = _INLINE_ERROR_RE.sub(" ", cleaned)
    cleaned = _FILE_PATH_RE.sub(" ", cleaned)
    cleaned = _CODE_IDENT_RE.sub(" ", cleaned)
    return cleaned.strip()


def _classify_clean_prose(prose: str) -> str | None:
    if not prose:
        return None
    kana = len(_KANA_RE.findall(prose))
    hangul = len(_HANGUL_RE.findall(prose))
    cjk = len(_CJK_RE.findall(prose))
    cyrillic = len(_CYRILLIC_RE.findall(prose))
    non_latin = kana + hangul + cjk + cyrillic

    latin_words = _LATIN_WORD_RE.findall(prose)
    en_func_hits = sum(1 for w in latin_words if w.lower() in _EN_FUNCTION_WORDS)

    if non_latin == 0:
        if len(latin_words) >= 2 or en_func_hits >= 1:
            return "en"
        return None

    # Guard against English prose containing tiny unquoted CJK literals (e.g. "Fix bug when input has 中文 chars")
    if len(latin_words) >= 5 and en_func_hits >= 1 and non_latin <= 2 and non_latin * 3 < len(latin_words):
        return "en"

    if kana >= 2 or (kana >= 1 and kana * 4 >= cjk):
        return "ja"
    if hangul >= 1 and hangul >= cjk:
        return "ko"
    if cyrillic >= 2 and cyrillic > cjk:
        return "ru"
    if cjk >= 1:
        simp = len(_SIMP_CHARS_RE.findall(prose))
        trad = len(_TRAD_CHARS_RE.findall(prose))
        return "zh-TW" if trad > simp else "zh-CN"
    return None


def _detect_single_message_lang(text: str | None) -> str | None:
    if not text or not text.strip():
        return None
    # Prefer unquoted prose so quoted literals like slugify("中文") in an English question do not misfire.
    lang = _classify_clean_prose(_strip_non_prose(text, strip_quotes=True))
    if lang is not None:
        return lang
    return _classify_clean_prose(_strip_non_prose(text, strip_quotes=False))


def detect_think_target_lang(
    user_text: str | None,
    history_user_texts: Sequence[str] | None = None,
) -> tuple[str | None, bool]:
    """Detect `(target_lang, switched_to_en_from_non_en)` from user prose after stripping code & stack traces."""
    prior_lang: str | None = None
    if history_user_texts:
        for item in reversed(history_user_texts):
            detected = _detect_single_message_lang(item)
            if detected is not None:
                prior_lang = detected
                break

    current_lang = _detect_single_message_lang(user_text)
    if current_lang is None:
        return prior_lang, False

    switched_to_en = bool(current_lang == "en" and prior_lang is not None and prior_lang != "en")
    return current_lang, switched_to_en


def build_think_lang_turn_reminder(target_lang: str | None, *, switched_to_en: bool = False) -> str:
    """Return a compact `<system-reminder>` suffix, or empty string when English needs no extra nudge."""
    if not target_lang:
        return ""
    if target_lang == "en":
        return _EN_SWITCH_REMINDER if switched_to_en else ""
    return _TURN_REMINDERS.get(target_lang, "")


def has_think_lang_reminder(text: str | None) -> bool:
    if not text:
        return False
    if _EN_SWITCH_REMINDER in text:
        return True
    return any(rem in text for rem in _TURN_REMINDERS.values())


def append_think_lang_reminder(
    prompt: str,
    *,
    user_text: str | None = None,
    history_user_texts: Sequence[str] | None = None,
) -> tuple[str, str | None]:
    """Append a transient `<system-reminder>` to `prompt` without altering code blocks or saved history."""
    if not prompt or not prompt.strip():
        return prompt, None
    target_lang, switched_to_en = detect_think_target_lang(
        user_text if user_text is not None else prompt,
        history_user_texts=history_user_texts,
    )
    if has_think_lang_reminder(prompt):
        return prompt, target_lang
    reminder = build_think_lang_turn_reminder(target_lang, switched_to_en=switched_to_en)
    if not reminder:
        return prompt, target_lang
    return f"{prompt.rstrip()}\n\n{reminder}", target_lang


def collect_user_history_texts(saved: Sequence[dict] | None, prior_messages: Sequence[object] | None = None) -> list[str]:
    """Extract chronological raw user message strings from saved conversation records and prior request messages."""
    texts: list[str] = []
    if saved:
        for row in saved:
            if isinstance(row, dict) and row.get("role") == "user":
                content = row.get("content")
                if isinstance(content, str) and content.strip():
                    texts.append(content)
    if prior_messages:
        for msg in prior_messages:
            role = getattr(msg, "role", None) if not isinstance(msg, dict) else msg.get("role")
            content = getattr(msg, "content", None) if not isinstance(msg, dict) else msg.get("content")
            if role == "user" and isinstance(content, str) and content.strip():
                texts.append(content)
    return texts
