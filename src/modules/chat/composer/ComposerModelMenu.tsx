import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';

import type { ProviderModelOption } from '@/shared/types';
import { cn } from '@/shared/utils';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSeparator,
} from '@/modules/chat/composer/ComposerMenuPrimitives';
import {
  findActiveChoiceInGroup,
  groupModelsByThinkingEffort,
  isChoiceSelected,
  resolveActiveModelEffort,
  type ModelEffortChoice,
} from '@/modules/chat/utils/modelEffortGroups';

type EffortOption = NonNullable<ProviderModelOption['effort']>['values'][number];

type ComposerModelMenuProps = {
  effort: string;
  /** Effort values the active provider/model accepts when the catalog is still loading. */
  effortOptions: EffortOption[];
  onSelectEffort: (effort: string) => void;
  model: string;
  /** Model catalog for the active provider; empty hides the section unless fallback efforts exist. */
  modelOptions: ProviderModelOption[];
  onSelectModel: (model: string) => void;
  /** Combined setter used when switching both model and reasoning effort in one click. */
  onSelectModelAndEffort?: (model: string, effort: string) => void;
  /** False when an external API relay overrides per-model reasoning effort parameters. */
  allowOptionEffort?: boolean;
  modelsLoading: boolean;
};

const PRIMARY_MENU_WIDTH = 256;
const SUBMENU_MIN_SPACE = 196;

/**
 * Rendered by chat's ChatComposer as a two-level popover: primary rows group
 * variants of the same model together, and each model's thinking/reasoning
 * strengths open in a second-level submenu (side flyout on desktop, drill-down
 * on narrow mobile screens).
 */
function ComposerModelMenu({
  effort,
  effortOptions,
  onSelectEffort,
  model,
  modelOptions,
  onSelectModel,
  onSelectModelAndEffort,
  allowOptionEffort = true,
  modelsLoading,
}: ComposerModelMenuProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const [activeGroupKey, setActiveGroupKey] = useState<string | null>(null);
  const [submenuOffsetTop, setSubmenuOffsetTop] = useState(0);
  const [primaryCardHeight, setPrimaryCardHeight] = useState(0);
  const primaryCardRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(
    isOpen,
    close,
    PRIMARY_MENU_WIDTH,
  );

  useEffect(() => {
    if (!isOpen) {
      setActiveGroupKey(null);
      setSubmenuOffsetTop(0);
    }
  }, [isOpen]);

  const defaultEffortLabel = t('composer.effortDefault', { defaultValue: 'Default' });
  const groups = useMemo(
    () =>
      groupModelsByThinkingEffort(modelOptions, {
        allowOptionEffort,
        defaultEffortLabel,
        fallbackEffortOptions: effortOptions,
        activeModel: model,
      }),
    [allowOptionEffort, defaultEffortLabel, effortOptions, model, modelOptions],
  );

  const activeSummary = useMemo(
    () => resolveActiveModelEffort(groups, model, effort, defaultEffortLabel),
    [defaultEffortLabel, effort, groups, model],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const element = primaryCardRef.current;
    if (element) {
      setPrimaryCardHeight(element.clientHeight);
    }
  }, [groups, isOpen, modelsLoading]);

  const activeGroup = useMemo(
    () =>
      activeGroupKey
        ? groups.find((group) => group.key === activeGroupKey && group.choices.length > 0) ?? null
        : null,
    [activeGroupKey, groups],
  );

  const handleSelectChoice = useCallback(
    (choice: ModelEffortChoice) => {
      if (choice.effortValue !== undefined) {
        if (choice.modelValue !== model) {
          if (onSelectModelAndEffort) {
            onSelectModelAndEffort(choice.modelValue, choice.effortValue);
          } else {
            onSelectModel(choice.modelValue);
            onSelectEffort(choice.effortValue);
          }
        } else {
          onSelectEffort(choice.effortValue);
        }
      } else {
        onSelectModel(choice.modelValue);
      }
      setIsOpen(false);
    },
    [model, onSelectEffort, onSelectModel, onSelectModelAndEffort],
  );

  const openGroupSubmenu = useCallback((groupKey: string, rowElement?: HTMLElement | null) => {
    setActiveGroupKey(groupKey);
    const cardElement = primaryCardRef.current;
    if (cardElement) {
      setPrimaryCardHeight(cardElement.clientHeight);
      if (rowElement) {
        const cardRect = cardElement.getBoundingClientRect();
        const rowRect = rowElement.getBoundingClientRect();
        setSubmenuOffsetTop(Math.max(0, rowRect.top - cardRect.top - 4));
      }
    }
  }, []);

  if (groups.length === 0 && !modelsLoading) {
    return null;
  }

  const ariaLabel = t('composer.modelMenu', {
    defaultValue: 'Select model and reasoning effort',
  });
  const modelHeading = t('composer.model', { defaultValue: 'Model' });
  const reasoningHeading = t('composer.reasoning', { defaultValue: 'Reasoning' });

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const canOpenRight = anchor ? anchor.right >= SUBMENU_MIN_SPACE : false;
  const canOpenLeft = anchor
    ? viewportWidth - anchor.right - PRIMARY_MENU_WIDTH >= SUBMENU_MIN_SPACE
    : false;
  const canShowSideSubmenu = viewportWidth >= 520 && (canOpenRight || canOpenLeft);
  const openSubmenuOnRight = canOpenRight || !canOpenLeft;

  const estimatedSubmenuHeight = activeGroup
    ? Math.min(anchor?.maxHeight ?? 360, 34 + activeGroup.choices.length * 36)
    : 0;
  const alignSubmenuToBottom =
    primaryCardHeight > 0 && estimatedSubmenuHeight > primaryCardHeight;
  const clampedSubmenuTop =
    primaryCardHeight > 0
      ? Math.max(0, Math.min(submenuOffsetTop, Math.max(0, primaryCardHeight - estimatedSubmenuHeight)))
      : 0;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        className="flex h-8 max-w-24 shrink-0 items-center gap-1 rounded-lg border border-border/60 bg-muted/40 px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted sm:max-w-60"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        <span className="truncate">{activeSummary.modelLabel}</span>
        {activeSummary.showEffortBadge && activeSummary.effortLabel && (
          <span className="hidden shrink-0 text-muted-foreground sm:inline">
            · {activeSummary.effortLabel}
          </span>
        )}
      </button>

      {isOpen &&
        anchor &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-[100]"
            style={{
              right: anchor.right,
              bottom: anchor.bottom,
            }}
          >
            <div className="relative">
              <div
                ref={primaryCardRef}
                role="menu"
                aria-label={ariaLabel}
                className="min-w-52 overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl"
                style={{
                  maxHeight: anchor.maxHeight,
                  width: Math.min(PRIMARY_MENU_WIDTH, anchor.maxWidth),
                }}
              >
                {!canShowSideSubmenu && activeGroup ? (
                  <>
                    <ComposerMenuItem
                      role="menuitem"
                      icon={<ChevronLeft className="h-3.5 w-3.5 text-muted-foreground" />}
                      label={activeGroup.label}
                      isSelected={false}
                      onSelect={() => setActiveGroupKey(null)}
                      className="font-medium"
                    />
                    <ComposerMenuSeparator />
                    <ComposerMenuHeading>{reasoningHeading}</ComposerMenuHeading>
                    {activeGroup.choices.map((choice) => (
                      <ComposerMenuItem
                        key={choice.key}
                        label={choice.label}
                        description={choice.description}
                        isSelected={isChoiceSelected(choice, model, effort)}
                        onSelect={() => handleSelectChoice(choice)}
                      />
                    ))}
                  </>
                ) : (
                  <>
                    <ComposerMenuHeading>{modelHeading}</ComposerMenuHeading>
                    {groups.length === 0 && modelsLoading && (
                      <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
                        {t('composer.loadingModels', { defaultValue: 'Loading models…' })}
                      </p>
                    )}
                    {groups.map((group) => {
                      if (group.choices.length === 0 && group.directOption) {
                        const directOption = group.directOption;
                        const isSelected = directOption.value === model;
                        return (
                          <ComposerMenuItem
                            key={group.key}
                            label={group.label}
                            description={group.description}
                            isSelected={isSelected}
                            onMouseEnter={() => {
                              if (canShowSideSubmenu) {
                                setActiveGroupKey(null);
                              }
                            }}
                            onSelect={() => {
                              onSelectModel(directOption.value);
                              setIsOpen(false);
                            }}
                          />
                        );
                      }

                      const activeChoice = findActiveChoiceInGroup(group, model, effort);
                      const isGroupSelected = activeChoice !== null;
                      const isSubmenuOpen = activeGroup?.key === group.key;

                      return (
                        <ComposerMenuItem
                          key={group.key}
                          role="menuitem"
                          ariaHaspopup="menu"
                          ariaExpanded={isSubmenuOpen}
                          label={group.label}
                          description={group.description}
                          isSelected={isGroupSelected}
                          onMouseEnter={(event) => {
                            if (canShowSideSubmenu) {
                              openGroupSubmenu(group.key, event.currentTarget);
                            }
                          }}
                          onSelect={(event) => {
                            openGroupSubmenu(group.key, event.currentTarget);
                          }}
                          className={cn(
                            isSubmenuOpen && 'bg-accent/70',
                            isGroupSelected && 'font-medium',
                          )}
                          trailing={
                            <>
                              {activeChoice && (
                                <span className="text-xs font-normal text-muted-foreground">
                                  {activeChoice.label}
                                </span>
                              )}
                              {isGroupSelected && !activeChoice && (
                                <Check className="h-3.5 w-3.5 text-foreground" />
                              )}
                              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                            </>
                          }
                        />
                      );
                    })}
                  </>
                )}
              </div>

              {canShowSideSubmenu && activeGroup && (
                <div
                  className={cn(
                    'absolute z-[101]',
                    openSubmenuOnRight ? 'left-full pl-1.5' : 'right-full pr-1.5',
                  )}
                  style={
                    alignSubmenuToBottom
                      ? { bottom: 0 }
                      : { top: clampedSubmenuTop }
                  }
                >
                  <div
                    role="menu"
                    aria-label={`${activeGroup.label} · ${reasoningHeading}`}
                    className="min-w-44 max-w-60 overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl"
                    style={{ maxHeight: anchor.maxHeight }}
                  >
                    <ComposerMenuHeading>{reasoningHeading}</ComposerMenuHeading>
                    {activeGroup.choices.map((choice) => (
                      <ComposerMenuItem
                        key={choice.key}
                        label={choice.label}
                        description={choice.description}
                        isSelected={isChoiceSelected(choice, model, effort)}
                        onSelect={() => handleSelectChoice(choice)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** Memoized: the composer re-renders on every keystroke and none of this menu's props change while typing. */
export default memo(ComposerModelMenu);
