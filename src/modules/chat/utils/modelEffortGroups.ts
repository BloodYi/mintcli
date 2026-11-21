import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import type { ProviderModelOption } from '@/shared/types';

export type ModelEffortOptionInput = NonNullable<ProviderModelOption['effort']>['values'][number];

export type ModelEffortChoice = {
  key: string;
  label: string;
  description?: string;
  /** Model ID sent when this choice is picked. */
  modelValue: string;
  /** Reasoning-effort parameter sent when this choice is picked (undefined for variant-ID models). */
  effortValue?: string;
  isCustom?: boolean;
};

export type ModelEffortGroup = {
  key: string;
  label: string;
  description?: string;
  isCustom?: boolean;
  /** Second-level thinking/reasoning choices. Empty when the model selects directly. */
  choices: ModelEffortChoice[];
  /** Direct option for models without thinking-effort levels. */
  directOption?: ProviderModelOption;
};

export type ActiveModelEffortSummary = {
  modelLabel: string;
  effortLabel: string | null;
  showEffortBadge: boolean;
};

type StrengthMeta = {
  key: string;
  label: string;
  rank: number;
};

const STRENGTH_BY_TOKEN: Record<string, StrengthMeta> = {
  default: { key: 'default', label: 'Default', rank: 0 },
  standard: { key: 'default', label: 'Default', rank: 0 },
  none: { key: 'none', label: 'None', rank: 1 },
  off: { key: 'none', label: 'None', rank: 1 },
  minimal: { key: 'minimal', label: 'Minimal', rank: 2 },
  low: { key: 'low', label: 'Low', rank: 3 },
  medium: { key: 'medium', label: 'Medium', rank: 4 },
  high: { key: 'high', label: 'High', rank: 5 },
  xhigh: { key: 'xhigh', label: 'XHigh', rank: 6 },
  'x-high': { key: 'xhigh', label: 'XHigh', rank: 6 },
  x_high: { key: 'xhigh', label: 'XHigh', rank: 6 },
  max: { key: 'max', label: 'Max', rank: 7 },
  ultra: { key: 'ultra', label: 'Ultra', rank: 8 },
  ultracode: { key: 'ultracode', label: 'Ultracode', rank: 9 },
  thinking: { key: 'thinking', label: 'Thinking', rank: 10 },
};

const PAREN_SUFFIX_RE = /\s*[([（【]([^()[\]（）【】]+)[)\]）】]\s*$/;
const SLUG_SUFFIX_RE = /^(.+?)[-_](none|minimal|low|medium|high|xhigh|x-high|x_high|max|ultra|ultracode|thinking)$/i;

function normalizeToken(raw: string): string {
  return raw.trim().toLowerCase();
}

function normalizeBaseKey(baseLabel: string, isCustom?: boolean): string {
  return `${isCustom ? 'custom' : 'builtin'}:${baseLabel.trim().replace(/\s+/g, ' ').toLowerCase()}`;
}

/** Formats a raw effort token (`xhigh`, `medium`, `default`, ...) into a display label. */
export function formatEffortLabel(value: string, defaultLabel = 'Default'): string {
  if (!value || value === DEFAULT_EFFORT_VALUE) {
    return defaultLabel;
  }
  const found = STRENGTH_BY_TOKEN[normalizeToken(value)];
  if (found) {
    return found.key === 'default' ? defaultLabel : found.label;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Extracts a base model name and thinking-strength metadata when a catalog row
 * encodes thinking effort in its label (e.g. `Gemini 4 Carbon (Medium)`) or raw
 * slug ID (e.g. `gemini-4-carbon-high`). Non-effort suffixes such as
 * `(Carbon)`, `(Argon)` or `(1M context)` return `null`.
 */
export function parseVariantThinkingEffort(
  option: ProviderModelOption,
): { baseLabel: string; strength: StrengthMeta } | null {
  const rawLabel = (option.label || option.value || '').trim();
  if (!rawLabel) {
    return null;
  }

  const parenMatch = PAREN_SUFFIX_RE.exec(rawLabel);
  if (parenMatch) {
    const strength = STRENGTH_BY_TOKEN[normalizeToken(parenMatch[1] ?? '')];
    const baseLabel = rawLabel.slice(0, parenMatch.index).trim();
    if (strength && baseLabel) {
      return { baseLabel, strength };
    }
  }

  if (rawLabel === option.value.trim() || !/\s/.test(rawLabel)) {
    const slugMatch = SLUG_SUFFIX_RE.exec(rawLabel);
    if (slugMatch) {
      const baseLabel = (slugMatch[1] ?? '').trim();
      const strength = STRENGTH_BY_TOKEN[normalizeToken(slugMatch[2] ?? '')];
      if (strength && baseLabel) {
        return { baseLabel, strength };
      }
    }
  }

  return null;
}

type RankedChoice = ModelEffortChoice & {
  rank: number;
  order: number;
  strengthKey: string;
};

/**
 * Collapses same-model variants and per-model effort definitions into unified
 * primary model rows whose thinking/reasoning levels live in `choices`.
 */
export function groupModelsByThinkingEffort(
  options: ProviderModelOption[],
  config: {
    allowOptionEffort?: boolean;
    defaultEffortLabel?: string;
    fallbackEffortOptions?: ModelEffortOptionInput[];
    activeModel?: string;
  } = {},
): ModelEffortGroup[] {
  const allowOptionEffort = config.allowOptionEffort !== false;
  const defaultEffortLabel = config.defaultEffortLabel || 'Default';

  const variantBaseKeys = new Set<string>();
  for (const option of options) {
    if (allowOptionEffort && (option.effort?.values.length ?? 0) > 0) {
      continue;
    }
    const parsed = parseVariantThinkingEffort(option);
    if (parsed) {
      variantBaseKeys.add(normalizeBaseKey(parsed.baseLabel, option.isCustom));
    }
  }

  const groups: ModelEffortGroup[] = [];
  const variantGroupsByKey = new Map<string, { group: ModelEffortGroup; ranked: RankedChoice[] }>();

  options.forEach((option, index) => {
    const declaredEfforts = allowOptionEffort ? option.effort?.values ?? [] : [];
    if (declaredEfforts.length > 0) {
      const choices: ModelEffortChoice[] = [
        {
          key: `${option.value}:${DEFAULT_EFFORT_VALUE}`,
          label: defaultEffortLabel,
          modelValue: option.value,
          effortValue: DEFAULT_EFFORT_VALUE,
          isCustom: option.isCustom,
        },
        ...declaredEfforts.map((item) => ({
          key: `${option.value}:${item.value}`,
          label: formatEffortLabel(item.value, defaultEffortLabel),
          description: item.description,
          modelValue: option.value,
          effortValue: item.value,
          isCustom: option.isCustom,
        })),
      ];
      groups.push({
        key: `effort:${option.isCustom ? 'custom' : 'builtin'}:${option.value}`,
        label: option.label || option.value,
        description: option.description,
        isCustom: option.isCustom,
        choices,
      });
      return;
    }

    const parsed = parseVariantThinkingEffort(option);
    const rawLabel = (option.label || option.value).trim();
    const candidateKey = parsed
      ? normalizeBaseKey(parsed.baseLabel, option.isCustom)
      : normalizeBaseKey(rawLabel, option.isCustom);

    if (parsed || variantBaseKeys.has(candidateKey)) {
      const baseLabel = parsed ? parsed.baseLabel : rawLabel;
      const strength = parsed
        ? parsed.strength
        : { key: 'default', label: defaultEffortLabel, rank: 0 };
      const choiceLabel = strength.key === 'default' ? defaultEffortLabel : strength.label;

      let bucket = variantGroupsByKey.get(candidateKey);
      if (!bucket) {
        const group: ModelEffortGroup = {
          key: `variant:${candidateKey}`,
          label: baseLabel,
          description: option.description,
          isCustom: option.isCustom,
          choices: [],
        };
        bucket = { group, ranked: [] };
        variantGroupsByKey.set(candidateKey, bucket);
        groups.push(group);
      }

      bucket.ranked.push({
        key: option.value,
        label: choiceLabel,
        description: option.description,
        modelValue: option.value,
        isCustom: option.isCustom,
        rank: strength.rank,
        order: index,
        strengthKey: strength.key,
      });
      return;
    }

    groups.push({
      key: `direct:${option.isCustom ? 'custom' : 'builtin'}:${option.value}`,
      label: option.label || option.value,
      description: option.description,
      isCustom: option.isCustom,
      choices: [],
      directOption: option,
    });
  });

  for (const { group, ranked } of variantGroupsByKey.values()) {
    ranked.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.order - b.order));
    const strengthCounts = new Map<string, number>();
    for (const item of ranked) {
      strengthCounts.set(item.strengthKey, (strengthCounts.get(item.strengthKey) ?? 0) + 1);
    }
    group.choices = ranked.map((item) => ({
      key: item.key,
      label:
        (strengthCounts.get(item.strengthKey) ?? 0) > 1
          ? `${item.label} (${item.modelValue})`
          : item.label,
      description: item.description,
      modelValue: item.modelValue,
      isCustom: item.isCustom,
    }));
  }

  const fallbackEfforts = allowOptionEffort ? config.fallbackEffortOptions ?? [] : [];
  if (groups.length === 0 && fallbackEfforts.length > 0 && config.activeModel) {
    const activeModel = config.activeModel;
    groups.push({
      key: `fallback:${activeModel}`,
      label: activeModel,
      choices: [
        {
          key: `${activeModel}:${DEFAULT_EFFORT_VALUE}`,
          label: defaultEffortLabel,
          modelValue: activeModel,
          effortValue: DEFAULT_EFFORT_VALUE,
        },
        ...fallbackEfforts.map((item) => ({
          key: `${activeModel}:${item.value}`,
          label: formatEffortLabel(item.value, defaultEffortLabel),
          description: item.description,
          modelValue: activeModel,
          effortValue: item.value,
        })),
      ],
    });
  }

  return groups;
}

export function isChoiceSelected(
  choice: ModelEffortChoice,
  currentModel: string,
  currentEffort: string,
): boolean {
  if (choice.modelValue !== currentModel) {
    return false;
  }
  if (choice.effortValue === undefined) {
    return true;
  }
  const normalizedEffort = currentEffort || DEFAULT_EFFORT_VALUE;
  return choice.effortValue === normalizedEffort;
}

export function findActiveChoiceInGroup(
  group: ModelEffortGroup,
  currentModel: string,
  currentEffort: string,
): ModelEffortChoice | null {
  if (group.choices.length === 0) {
    return null;
  }
  const exact = group.choices.find((choice) => isChoiceSelected(choice, currentModel, currentEffort));
  if (exact) {
    return exact;
  }
  return group.choices.find((choice) => choice.modelValue === currentModel) ?? null;
}

export function resolveActiveModelEffort(
  groups: ModelEffortGroup[],
  currentModel: string,
  currentEffort: string,
  defaultEffortLabel = 'Default',
): ActiveModelEffortSummary {
  for (const group of groups) {
    if (group.directOption && group.directOption.value === currentModel) {
      return {
        modelLabel: group.label,
        effortLabel: null,
        showEffortBadge: false,
      };
    }
    const activeChoice = findActiveChoiceInGroup(group, currentModel, currentEffort);
    if (activeChoice) {
      const isDefaultParamEffort = activeChoice.effortValue === DEFAULT_EFFORT_VALUE;
      return {
        modelLabel: group.label,
        effortLabel: activeChoice.label,
        showEffortBadge: !isDefaultParamEffort,
      };
    }
  }

  const normalizedEffort = currentEffort || DEFAULT_EFFORT_VALUE;
  if (normalizedEffort !== DEFAULT_EFFORT_VALUE) {
    return {
      modelLabel: currentModel,
      effortLabel: formatEffortLabel(normalizedEffort, defaultEffortLabel),
      showEffortBadge: true,
    };
  }

  return {
    modelLabel: currentModel,
    effortLabel: null,
    showEffortBadge: false,
  };
}
