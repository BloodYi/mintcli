import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";

import { DEFAULT_EFFORT_VALUE } from "@/shared/constants";
import type { LLMProvider, ProviderModelOption } from "@/shared/types";
import { Badge, CommandGroup, CommandItem, LLMProviderLogo } from "@/shared/ui";
import {
  findActiveChoiceInGroup,
  groupModelsByThinkingEffort,
  isChoiceSelected,
} from "@/modules/chat/utils/modelEffortGroups";

/**
 * One branch of the model picker.
 *
 * `provider` is what selecting a model in this branch sets, kept separate from
 * the branch itself so a branch does not have to be a provider.
 */
export type ModelGroup = {
  key: string;
  provider: LLMProvider;
  name: string;
  models: ProviderModelOption[];
};

type ModelGroupListProps = {
  groups: ModelGroup[];
  provider: LLMProvider;
  currentModel: string;
  currentEffort?: string;
  allowOptionEffort?: boolean;
  defaultEffortLabel?: string;
  loading: boolean;
  /** While searching, every branch is shown open — a hit inside a collapsed one would be invisible. */
  searching: boolean;
  onSelect: (provider: LLMProvider, model: string, effort?: string) => void;
  loadingLabel: string;
};

const STORAGE_KEY = "model-groups-collapsed";

function readCollapsed(): string[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed.filter((key) => typeof key === "string") : [];
  } catch {
    return [];
  }
}

export default function ModelGroupList({
  groups,
  provider,
  currentModel,
  currentEffort = DEFAULT_EFFORT_VALUE,
  allowOptionEffort = true,
  defaultEffortLabel = "Default",
  loading,
  searching,
  onSelect,
  loadingLabel,
}: ModelGroupListProps) {
  const [collapsedKeys, setCollapsedKeys] = useState<string[]>(readCollapsed);
  const [expandedModelKey, setExpandedModelKey] = useState<string | null>(null);
  const collapsed = useMemo(() => new Set(collapsedKeys), [collapsedKeys]);

  const toggle = useCallback((key: string) => {
    setCollapsedKeys((previous) => (previous.includes(key)
      ? previous.filter((entry) => entry !== key)
      : [...previous, key]));
  }, []);

  // Persisted from an effect, not from the updater: React may run an updater
  // more than once or throw its result away, and only committed state should
  // reach storage.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsedKeys));
    } catch {
      // A closed branch is a convenience; not being able to remember it is no reason to fail.
    }
  }, [collapsedKeys]);

  return (
    <>
      {groups.map((group, index) => {
        const isCollapsed = collapsed.has(group.key) && !searching;
        const groupedModels = groupModelsByThinkingEffort(group.models, {
          allowOptionEffort,
          defaultEffortLabel,
        });

        return (
          <CommandGroup
            key={group.key}
            className={
              index > 0
                ? "border-t border-border/40 [&_[cmdk-group-heading]]:mt-1 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                : "[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
            }
            heading={
              <button
                type="button"
                onClick={() => toggle(group.key)}
                className="flex w-full items-center gap-1.5 text-left hover:text-foreground"
                aria-expanded={!isCollapsed}
              >
                {isCollapsed ? (
                  <ChevronRight className="h-3 w-3 shrink-0" />
                ) : (
                  <ChevronDown className="h-3 w-3 shrink-0" />
                )}
                <LLMProviderLogo provider={group.provider} className="h-3.5 w-3.5 shrink-0" />
                {group.name}
                <span className="ml-auto text-[10px] font-normal normal-case tracking-normal text-muted-foreground">
                  {groupedModels.length}
                </span>
              </button>
            }
          >
            {groupedModels.length === 0 && loading ? (
              <CommandItem disabled className="ml-4 border-l border-border/40 pl-4 text-muted-foreground">
                {loadingLabel}
              </CommandItem>
            ) : null}

            {/*
              A collapsed branch still needs one item: cmdk hides a group whose
              items are all gone, and a vanished heading cannot be clicked open
              again. This row doubles as that click target.
            */}
            {isCollapsed && groupedModels.length > 0 ? (
              <CommandItem
                value={`${group.name} show`}
                onSelect={() => toggle(group.key)}
                className="ml-4 border-l border-border/40 pl-4 text-[11px] text-muted-foreground"
              >
                {groupedModels.length} hidden — click to show
              </CommandItem>
            ) : null}

            {!isCollapsed && groupedModels.map((modelGroup) => {
              if (modelGroup.choices.length === 0 && modelGroup.directOption) {
                const directModel = modelGroup.directOption;
                const isSelected = provider === group.provider && currentModel === directModel.value;

                return (
                  <CommandItem
                    key={`${group.key}-${directModel.value}`}
                    value={`${group.name} ${directModel.label} ${directModel.description || ""}`}
                    onSelect={() => onSelect(group.provider, directModel.value)}
                    className="ml-4 border-l border-border/40 pl-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate">{directModel.label}</span>
                        {directModel.isCustom && (
                          <Badge className="h-4 shrink-0 rounded-full px-1.5 text-[8px]">Custom</Badge>
                        )}
                      </div>
                      {directModel.label !== directModel.value && (
                        <div className="truncate font-mono text-[10px] text-muted-foreground">
                          {directModel.value}
                        </div>
                      )}
                    </div>
                    {isSelected && <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />}
                  </CommandItem>
                );
              }

              const fullGroupKey = `${group.key}:${modelGroup.key}`;
              const isModelExpanded = searching || expandedModelKey === fullGroupKey;
              const activeChoice = provider === group.provider
                ? findActiveChoiceInGroup(modelGroup, currentModel, currentEffort)
                : null;
              const searchKeywords = modelGroup.choices
                .map((choice) => `${choice.label} ${choice.modelValue}`)
                .join(" ");

              return (
                <div key={fullGroupKey} className="contents">
                  <CommandItem
                    value={`${group.name} ${modelGroup.label} ${modelGroup.description || ""} ${searchKeywords}`}
                    onSelect={() => {
                      setExpandedModelKey((previous) => (
                        previous === fullGroupKey ? null : fullGroupKey
                      ));
                    }}
                    className="ml-4 border-l border-border/40 pl-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">{modelGroup.label}</span>
                        {modelGroup.isCustom && (
                          <Badge className="h-4 shrink-0 rounded-full px-1.5 text-[8px]">Custom</Badge>
                        )}
                      </div>
                      {modelGroup.description && (
                        <div className="truncate text-[11px] text-muted-foreground">
                          {modelGroup.description}
                        </div>
                      )}
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-1.5">
                      {activeChoice && (
                        <span className="text-xs text-muted-foreground">{activeChoice.label}</span>
                      )}
                      {isModelExpanded ? (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </div>
                  </CommandItem>

                  {isModelExpanded && modelGroup.choices.map((choice) => {
                    const isSelected =
                      provider === group.provider
                      && isChoiceSelected(choice, currentModel, currentEffort);

                    return (
                      <CommandItem
                        key={`${fullGroupKey}:${choice.key}`}
                        value={`${group.name} ${modelGroup.label} ${choice.label} ${choice.modelValue} ${choice.description || ""}`}
                        onSelect={() => onSelect(group.provider, choice.modelValue, choice.effortValue)}
                        className="ml-8 border-l border-border/50 py-1.5 pl-3"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-[13px]">{choice.label}</span>
                          {choice.description ? (
                            <span className="block truncate text-[10px] text-muted-foreground">
                              {choice.description}
                            </span>
                          ) : choice.effortValue === undefined && choice.label !== choice.modelValue ? (
                            <span className="block truncate font-mono text-[10px] text-muted-foreground">
                              {choice.modelValue}
                            </span>
                          ) : null}
                        </div>
                        {isSelected && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-primary" />}
                      </CommandItem>
                    );
                  })}
                </div>
              );
            })}
          </CommandGroup>
        );
      })}
    </>
  );
}
