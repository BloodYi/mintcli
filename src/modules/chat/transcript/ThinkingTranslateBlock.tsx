import * as React from 'react';
import { Languages, Loader2 } from 'lucide-react';

import {
  getCachedThinkingTranslation,
  shouldAutoTranslateThinking,
  translateThinkingText,
} from '@/modules/antigravity';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/modules/chat/transcript/Reasoning';
import { readStoredUiPreferences } from '@/shared/uiPreferences';
import { subscribeToUserPreferences } from '@/shared/userSettings';
import { cn } from '@/shared/utils';

export const ToolGroupExpandedContext = React.createContext<boolean>(false);

type ThinkingTranslateBlockProps = {
  text: string;
  isStreaming?: boolean;
  defaultOpen?: boolean;
  isExporting?: boolean;
  className?: string;
  renderContent: (displayText: string, showingTranslation: boolean) => React.ReactNode;
};

function useAutoThinkTranslateEnabled(): boolean {
  const [enabled, setEnabled] = React.useState(() => readStoredUiPreferences().agyThinkTranslate);
  React.useEffect(
    () =>
      subscribeToUserPreferences(() => {
        setEnabled(readStoredUiPreferences().agyThinkTranslate);
      }),
    [],
  );
  return enabled;
}

/**
 * Wraps the Reasoning accordion with an always-available translate button
 * plus automatic translation when the global `agyThinkTranslate` toggle is on.
 */
export const ThinkingTranslateBlock = React.memo<ThinkingTranslateBlockProps>(
  ({ text, isStreaming = false, defaultOpen, isExporting = false, className, renderContent }) => {
    const autoTranslate = useAutoThinkTranslateEnabled();
    const inExpandedToolGroup = React.useContext(ToolGroupExpandedContext);
    const cleaned = text.trim();

    const [isOpen, setIsOpen] = React.useState<boolean>(() => defaultOpen ?? isStreaming);
    const [translated, setTranslated] = React.useState<string | null>(() =>
      cleaned ? getCachedThinkingTranslation(cleaned) : null,
    );
    const [showTranslated, setShowTranslated] = React.useState<boolean>(() => Boolean(translated));
    const [translating, setTranslating] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const mountedRef = React.useRef(true);
    const wasStreamingRef = React.useRef(isStreaming);
    const autoTriedTextRef = React.useRef<string | null>(null);
    const prevTextRef = React.useRef(cleaned);

    React.useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
      };
    }, []);

    // Sync cached translation when thinking text updates.
    React.useEffect(() => {
      if (prevTextRef.current !== cleaned) {
        prevTextRef.current = cleaned;
        const cached = cleaned ? getCachedThinkingTranslation(cleaned) : null;
        setTranslated(cached);
        setShowTranslated(Boolean(cached));
        setError(null);
        autoTriedTextRef.current = null;
      }
    }, [cleaned]);

    const runTranslate = React.useCallback(
      async (openOnStart: boolean) => {
        if (!cleaned || translating) return;
        if (openOnStart) setIsOpen(true);
        setTranslating(true);
        setError(null);
        try {
          const result = await translateThinkingText(cleaned);
          if (!mountedRef.current || prevTextRef.current !== cleaned) return;
          setTranslated(result);
          setShowTranslated(true);
        } catch (err) {
          if (!mountedRef.current) return;
          setError(err instanceof Error ? err.message : '翻译失败');
        } finally {
          if (mountedRef.current) setTranslating(false);
        }
      },
      [cleaned, translating],
    );

    // Auto-translate when enabled:
    // 1) right after a live thinking block finishes streaming,
    // 2) when the user opens a thinking block while auto-translate is on, OR
    // 3) when the user expands a collapsed tool group containing thinking steps.
    React.useEffect(() => {
      const justFinishedStreaming = wasStreamingRef.current && !isStreaming;
      wasStreamingRef.current = isStreaming;

      if (!autoTranslate || isExporting || isStreaming || !cleaned) return;
      if (translated !== null || translating) return;
      if (autoTriedTextRef.current === cleaned) return;
      if (!justFinishedStreaming && !isOpen && !inExpandedToolGroup) return;
      if (!shouldAutoTranslateThinking(cleaned)) return;

      autoTriedTextRef.current = cleaned;
      const shouldOpen = (justFinishedStreaming && defaultOpen !== false) || inExpandedToolGroup;
      void runTranslate(shouldOpen);
    }, [autoTranslate, cleaned, defaultOpen, inExpandedToolGroup, isExporting, isOpen, isStreaming, runTranslate, translated, translating]);

    const handleButtonClick = (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (translating) return;
      if (translated !== null) {
        setShowTranslated((prev) => !prev);
        if (!isOpen) setIsOpen(true);
        return;
      }
      void runTranslate(true);
    };

    const showingTranslation = Boolean(translated && showTranslated);
    const displayText = showingTranslation && translated ? translated : text;
    const preventAutoClose = Boolean(
      translating
      || showingTranslation
      || (autoTranslate && cleaned && shouldAutoTranslateThinking(cleaned)),
    );

    return (
      <Reasoning
        isStreaming={isStreaming}
        open={isExporting ? true : isOpen}
        onOpenChange={setIsOpen}
        defaultOpen={defaultOpen}
        disableAutoClose={preventAutoClose}
        className={className}
      >
        <div className="flex items-center justify-between gap-2">
          <ReasoningTrigger className="w-auto min-w-0 flex-1" />
          {!isExporting && cleaned && !isStreaming && (
            <div className="flex shrink-0 items-center gap-1.5">
              {showingTranslation && (
                <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400">
                  已译
                </span>
              )}
              <button
                type="button"
                disabled={translating}
                onClick={handleButtonClick}
                title={
                  translating
                    ? '正在使用配置的翻译模型翻译思考内容…'
                    : translated !== null
                      ? showTranslated
                        ? '切换回原始思考内容'
                        : '查看翻译后的思考内容'
                      : '点击翻译这段思考内容'
                }
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors',
                  showingTranslation
                    ? 'border-violet-500/40 bg-violet-500/10 text-violet-600 hover:bg-violet-500/20 dark:text-violet-400'
                    : 'border-border/70 bg-muted/40 text-muted-foreground hover:bg-accent hover:text-foreground',
                  'disabled:cursor-wait disabled:opacity-60',
                )}
              >
                {translating ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    <span>翻译中</span>
                  </>
                ) : (
                  <>
                    <Languages className="h-3 w-3" />
                    <span>{translated !== null ? (showTranslated ? '原文' : '译文') : error ? '重试' : '翻译'}</span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>
        <ReasoningContent>
          {error && (
            <p className="mb-2 text-xs text-red-500">{error}</p>
          )}
          {renderContent(displayText, showingTranslation)}
        </ReasoningContent>
      </Reasoning>
    );
  },
);
ThinkingTranslateBlock.displayName = 'ThinkingTranslateBlock';
