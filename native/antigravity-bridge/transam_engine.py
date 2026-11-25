"""TRANS-AM Narrative & Deep Execution Engine (4A / 4H / 4N) for Antigravity Bridge.

Integrates the three model-tuned TRANS-AM presets into agycli / MintCLI:
- TRANS-AM-4A-v1.2.4.0.json (Gemini 4 Argon / 4A)
- TRANS-AM-4H-v1.1.4.0.json (Gemini 4 High / Carbon / Pro / Claude / default 4H)
- TRANS-AM-4N-v1.0.1.0.json (Gemini 4 Neon / 4N)

Capabilities:
1. Automatic model-tier routing (4A / 4H / 4N) based on selected model ID or label.
2. Full prompt_order system directive assembly (core 3D spatial/chirality coherence, player authorship
   guard/autowrite, prose baseline & 4H/4N anti-cliché wordlist, output contract, timeline, summary window,
   Trans reviewer & anti-collapse recovery, settled manuscript premise handshake).
3. Per-turn dynamic D100×4 reaction dice pool expansion (R1–R4 = 1..100) + post-history execution lock
   (ta-reaction-dice-pool, ta-4h-deep-execution, ta-mvu-payload, ta-execution-lock, continue nudge).
4. Context history sanitization (promptOnly regex rules: hides prior <ta_plan>, <ta_choices>,
   old <ta_hub>, <ta_noise_pad>, <ta_resolve>, and inline <thinking> blocks from AI context while
   preserving <ta_zh> prose and <ta_record> archives).
5. Account-scoped 01-transam.md rule sync with clean toggle-off and zero workspace pollution.
"""
from __future__ import annotations

from functools import lru_cache
import json
import logging
from pathlib import Path
import random
import re
from typing import Any

logger = logging.getLogger("antigravity-chat.transam")

_PRESETS_DIR = Path(__file__).resolve().parent / "transam" / "presets"
_TRANSAM_RULE_MARKER = "Global Rules — TRANS-AM Narrative Engine"

# Keep only non-style, non-format core directives (adult baseline, settled premise, deliberation);
# strip all prose-style, word-count, POV, dice-pool, MVU, and <ta_*> output-format locks.
_CORE_KEEP_IDS: frozenset[str] = frozenset({
    "main",
    "ta-rule-demographic-integrity",
    "ta-settled-premise-user",
    "ta-settled-premise-ack",
})
_DELIBERATION_LINE_RE = re.compile(r"(?m)^DELIBERATION:.*$")
_TRANSAM_TAG_RE = re.compile(r"<(?:ta|tw)_(?:zh|plan|record|hub|choices)\b", re.IGNORECASE)
_CODE_FENCE_RE = re.compile(r"(```[\s\S]*?```|~~~[\s\S]*?~~~)")

PRESET_FILES: dict[str, tuple[str, str]] = {
    "4A": ("TRANS-AM-4A-v1.2.4.0.json", "4A v1.2.4.0"),
    "4H": ("TRANS-AM-4H-v1.1.4.0.json", "4H v1.1.4.0"),
    "4N": ("TRANS-AM-4N-v1.0.1.0.json", "4N v1.0.1.0"),
}

_CONTINUE_INPUT_RE = re.compile(
    r"^\s*(?:继续|接着写|往下写|continue|\[continue[^\]]*\])\s*[。！!.\s]*$",
    re.IGNORECASE,
)
_ROLL_MACRO_RE = re.compile(r"\{\{\s*roll(?:\s+|:)1d100\s*\}\}", re.IGNORECASE)
_INLINE_COMMENT_RE = re.compile(r"\{\{//[\s\S]*?\}\}")

# Context-only (promptOnly=True) cleanup regexes from TRANS-AM preset regex_scripts
_PROMPT_NOISE_PAD_RE = re.compile(r"<ta_noise_pad\s*>[^<>]*?</ta_noise_pad\s*>", re.IGNORECASE)
_PROMPT_PLAN_RE = re.compile(
    r"<((?:ta|tw)_plan)\b[^>]*>(?:(?!<(?:ta|tw)_plan\b)[\s\S])*?</\1\s*>[ \t]*(?:\r?\n[ \t]*)*",
    re.IGNORECASE,
)
_PROMPT_CHOICES_RE = re.compile(
    r"<((?:ta|tw)_choices)\b[^>]*>(?:(?!<(?:ta|tw)_choices\b)[\s\S])*?</\1\s*>[ \t]*(?:\r?\n[ \t]*)*",
    re.IGNORECASE,
)
_PROMPT_HUB_RE = re.compile(
    r"<((?:ta|tw)_hub)\b[^>]*>(?:(?!<(?:ta|tw)_hub\b)[\s\S])*?</\1\s*>\s*",
    re.IGNORECASE,
)
_PROMPT_RESOLVE_RE = re.compile(
    r"<ta_resolve\b[^>]*>[\s\S]*?</ta_resolve\s*>[ \t]*(?:\r?\n)?",
    re.IGNORECASE,
)
_PROMPT_THINKING_RE = re.compile(
    r"<(thinking|think|thought|cot|[a-zA-Z0-9_]+_cot)\b[^>]*>[\s\S]*?</\1\s*>",
    re.IGNORECASE,
)


def resolve_transam_tier(model: str | None = None, model_label: str | None = None) -> str:
    """Select the matching TRANS-AM preset tier ('4A', '4N', or '4H') for the given model."""
    combined = f"{model or ''} {model_label or ''}".lower()
    if "argon" in combined or re.search(r"\b4a\b", combined):
        return "4A"
    if "neon" in combined or re.search(r"\b4n\b", combined):
        return "4N"
    return "4H"


def is_continue_prompt(text: str | None) -> bool:
    """Return True when the user's message is a direct continuation command."""
    if not text:
        return False
    return bool(_CONTINUE_INPUT_RE.match(text.strip()))


def has_transam_history_tags(history: list[dict[str, Any]] | None) -> bool:
    """Return True if the most recent assistant turn contains TRANS-AM narrative tags."""
    if not history:
        return False
    for row in reversed(history):
        if row.get("role") != "assistant" or row.get("status") in ("error", "stopped"):
            continue
        content = row.get("content")
        return bool(isinstance(content, str) and _TRANSAM_TAG_RE.search(content))
    return False


def _filter_core_content(pid: str, content: str) -> str:
    """Extract only non-format/non-style directives from kept preset entries."""
    cleaned = _INLINE_COMMENT_RE.sub("", content).strip()
    if pid == "main":
        match = _DELIBERATION_LINE_RE.search(cleaned)
        if not match:
            return ""
        return f"<ta_rule_core>\n{match.group(0).strip()}\n</ta_rule_core>"
    if pid == "ta-rule-demographic-integrity":
        cleaned = re.sub(r"\s*during preparation,\s*<ta_plan>,\s*or prose\.", " during preparation or output.", cleaned)
        cleaned = cleaned.replace("in preparation, <ta_plan>, or prose.", "in preparation or output.")
    return cleaned


@lru_cache(maxsize=8)
def load_transam_preset(tier: str) -> dict[str, Any]:
    """Load and parse one of the TRANS-AM preset JSON files ('4A', '4H', '4N')."""
    normalized = tier.upper() if tier and tier.upper() in PRESET_FILES else "4H"
    filename, version_label = PRESET_FILES[normalized]
    path = _PRESETS_DIR / filename
    raw = json.loads(path.read_text(encoding="utf-8"))

    prompts_by_id: dict[str, dict[str, Any]] = {}
    for item in raw.get("prompts", []):
        if isinstance(item, dict) and isinstance(item.get("identifier"), str):
            prompts_by_id[item["identifier"]] = item

    order_entries: list[dict[str, Any]] = []
    prompt_order = raw.get("prompt_order", [])
    if isinstance(prompt_order, list) and prompt_order:
        first_group = prompt_order[0]
        if isinstance(first_group, dict) and isinstance(first_group.get("order"), list):
            order_entries = first_group["order"]

    enabled_ids = [
        entry["identifier"]
        for entry in order_entries
        if isinstance(entry, dict) and entry.get("enabled") and isinstance(entry.get("identifier"), str)
    ]

    if "chatHistory" in enabled_ids:
        chat_idx = enabled_ids.index("chatHistory")
        pre_ids = enabled_ids[:chat_idx]
        post_ids = enabled_ids[chat_idx + 1 :]
    else:
        pre_ids = enabled_ids
        post_ids = []

    pre_prompts: list[dict[str, Any]] = []
    for pid in pre_ids:
        if pid not in _CORE_KEEP_IDS:
            continue
        p = prompts_by_id.get(pid)
        if not p or p.get("marker"):
            continue
        content = _filter_core_content(pid, p.get("content") or "")
        if not content:
            continue
        pre_prompts.append(
            {
                "identifier": pid,
                "name": p.get("name") or pid,
                "role": p.get("role") or "system",
                "content": content,
            }
        )

    post_prompts: list[dict[str, Any]] = []

    return {
        "tier": normalized,
        "version": version_label,
        "filename": filename,
        "temperature": raw.get("temperature", 0.9),
        "continue_nudge_prompt": "",
        "pre_prompts": pre_prompts,
        "post_prompts": post_prompts,
    }


def _expand_macros(
    text: str,
    *,
    gen_type: str = "normal",
    dice: list[int] | None = None,
) -> str:
    out = text.replace("{{lastGenerationType}}", gen_type)
    if dice is not None:
        it = iter(dice)
        out = _ROLL_MACRO_RE.sub(lambda _m: str(next(it, random.randint(1, 100))), out)
    else:
        out = _ROLL_MACRO_RE.sub(lambda _m: str(random.randint(1, 100)), out)
    return out


def get_transam_system_directive(
    model: str | None = None,
    model_label: str | None = None,
    *,
    is_continue: bool = False,
) -> str:
    """Compile the full pre-history TRANS-AM system directive for the selected model tier."""
    tier = resolve_transam_tier(model, model_label)
    preset = load_transam_preset(tier)
    gen_type = "continue" if is_continue else "normal"

    system_blocks: list[str] = [
        f"# {_TRANSAM_RULE_MARKER} ({preset['version']})",
    ]
    handshake_blocks: list[str] = []

    for item in preset["pre_prompts"]:
        content = _expand_macros(item["content"], gen_type=gen_type)
        role = item["role"]
        if role == "user":
            handshake_blocks.append(f"Pilot Premise:\n{content}")
        elif role == "assistant":
            handshake_blocks.append(f"Onboard System Ack:\n{content}")
        else:
            system_blocks.append(content)

    if handshake_blocks:
        system_blocks.append("<ta_settled_premise>\n" + "\n\n".join(handshake_blocks) + "\n</ta_settled_premise>")

    return "\n\n".join(system_blocks)


def get_transam_workspace_rule(
    model: str | None = None,
    model_label: str | None = None,
) -> str:
    """Return the workspace/home rule file content synced to 01-transam.md when enabled."""
    return get_transam_system_directive(model, model_label, is_continue=False) + "\n"


def build_transam_turn_prompt(
    prompt: str,
    *,
    model: str | None = None,
    model_label: str | None = None,
    is_continue: bool | None = None,
    dice: list[int] | None = None,
) -> tuple[str, dict[str, Any]]:
    """Expand the per-turn D100×4 dice pool and post-history execution locks onto the user prompt."""
    tier = resolve_transam_tier(model, model_label)
    preset = load_transam_preset(tier)
    cont = is_continue_prompt(prompt) if is_continue is None else is_continue
    gen_type = "continue" if cont else "normal"
    rolled_dice = list(dice) if dice and len(dice) >= 4 else [random.randint(1, 100) for _ in range(4)]

    post_blocks: list[str] = []
    if cont and preset["continue_nudge_prompt"]:
        post_blocks.append(_expand_macros(preset["continue_nudge_prompt"], gen_type=gen_type, dice=rolled_dice))

    for item in preset["post_prompts"]:
        if cont and item["identifier"] == "ta-reaction-dice-pool":
            # Continuation never re-rolls the dice pool per ta-reaction-dice-pool rules
            continue
        post_blocks.append(_expand_macros(item["content"], gen_type=gen_type, dice=rolled_dice))

    tail_directive = "\n\n".join(b for b in post_blocks if b)
    if prompt and prompt.strip():
        enriched = f"{prompt.rstrip()}\n\n{tail_directive}" if tail_directive else prompt
    else:
        enriched = tail_directive

    meta = {
        "enabled": True,
        "tier": tier,
        "version": preset["version"],
        "dice": rolled_dice,
        "is_continue": cont,
    }
    return enriched, meta


def sanitize_transam_history_content(text: str, *, is_latest_assistant: bool = False) -> str:
    """Apply TRANS-AM promptOnly regex scripts while preserving fenced code blocks."""
    if not text:
        return text
    fences: list[str] = []

    def _mask_fence(match: re.Match[str]) -> str:
        idx = len(fences)
        fences.append(match.group(0))
        return f"\x00TRANSAM_FENCE_{idx}\x00"

    out = _CODE_FENCE_RE.sub(_mask_fence, text)
    out = _PROMPT_NOISE_PAD_RE.sub("", out)
    out = _PROMPT_PLAN_RE.sub("", out)
    out = _PROMPT_CHOICES_RE.sub("", out)
    out = _PROMPT_RESOLVE_RE.sub("", out)
    out = _PROMPT_THINKING_RE.sub("\n\n", out)
    if not is_latest_assistant:
        out = _PROMPT_HUB_RE.sub("", out)
    out = re.sub(r"\n{3,}", "\n\n", out).strip()
    for idx, block in enumerate(fences):
        out = out.replace(f"\x00TRANSAM_FENCE_{idx}\x00", block)
    return out


def _remove_managed_transam_rule(rule_file: Path, *, prune_empty_parents: int = 0) -> None:
    """Remove 01-transam.md only when it was created by the TRANS-AM engine."""
    try:
        if not rule_file.exists() or rule_file.is_symlink():
            return
        content = rule_file.read_text(encoding="utf-8", errors="replace")
        if _TRANSAM_RULE_MARKER not in content:
            return
        rule_file.unlink(missing_ok=True)
        logger.info("TRANS-AM: Removed managed rule file %s", rule_file)
        parent = rule_file.parent
        for _ in range(prune_empty_parents):
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent
    except Exception as exc:
        logger.debug("TRANS-AM: Failed cleaning rule file %s: %s", rule_file, exc)


def sync_transam_rules(
    enabled: bool,
    *,
    target_cwd: str | None = None,
    agy_home: str | None = None,
    extra_homes: list[str] | None = None,
    model: str | None = None,
    model_label: str | None = None,
) -> None:
    """Synchronize TRANS-AM global rule file (01-transam.md) with the current toggle state."""
    if target_cwd:
        _remove_managed_transam_rule(
            Path(target_cwd) / ".agents" / "rules" / "01-transam.md",
            prune_empty_parents=2,
        )

    if enabled:
        if agy_home:
            try:
                home_rules = Path(agy_home) / ".gemini" / "antigravity-cli" / "rules"
                home_rules.mkdir(parents=True, exist_ok=True)
                rule_file = home_rules / "01-transam.md"
                desired = get_transam_workspace_rule(model, model_label)
                if (
                    not rule_file.exists()
                    or rule_file.read_text(encoding="utf-8", errors="replace") != desired
                ):
                    rule_file.write_text(desired, encoding="utf-8")
                    logger.info(
                        "TRANS-AM: Synced %s rule in %s",
                        resolve_transam_tier(model, model_label),
                        rule_file,
                    )
            except Exception as exc:
                logger.debug("TRANS-AM: Failed writing user home rule: %s", exc)
    else:
        homes_to_clean: list[str] = []
        if agy_home:
            homes_to_clean.append(agy_home)
        if extra_homes:
            for item in extra_homes:
                if item and item not in homes_to_clean:
                    homes_to_clean.append(item)
        for home_dir in homes_to_clean:
            _remove_managed_transam_rule(
                Path(home_dir) / ".gemini" / "antigravity-cli" / "rules" / "01-transam.md",
                prune_empty_parents=1,
            )
