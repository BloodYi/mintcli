import React, { memo, useMemo, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useTranslation } from 'react-i18next';

import { MermaidDiagram } from '@/modules/code-editor';
import { MarkdownDownload } from '@/modules/chat/transcript/MarkdownDownload';
import { MarkdownImage } from '@/modules/chat/transcript/MarkdownImage';
import { MarkdownVideo } from '@/modules/chat/transcript/MarkdownVideo';
import { isImagePath, isVideoPath } from '@/modules/chat/transcript/markdownMedia';
import { normalizeInlineCodeFences } from '@/modules/chat/utils/chatFormatting';
import { normalizeLatexDelimiters } from '@/modules/chat/utils/latexDelimiters';
import { copyTextToClipboard } from '@/shared/utils';
import { SyntaxHighlighter } from '@/shared/syntaxHighlighter';
import { usePaletteOps } from '@/modules/command-palette';
import { buildSyntaxTheme } from '@/modules/chat/utils/syntaxHighlightTheme';
import type { PrismStyleSheet } from '@/modules/chat/utils/syntaxHighlightTheme';

type MarkdownProps = {
  children: React.ReactNode;
  className?: string;
  /** Render single newlines as hard line breaks (for user-typed messages). */
  breaks?: boolean;
};

// Links to the wider web (or in-page anchors) keep normal browser navigation;
// everything else is treated as a workspace file reference.
const isExternalHref = (href?: string): boolean =>
  !!href && (/^(https?:|mailto:|tel:|data:)/i.test(href) || href.startsWith('#'));

// Read the trailing `:line` / `:line:col` suffix so the editor can reveal it.
// Both this and stripLineSuffix are anchored at the end, so callers pass an
// already-trimmed reference.
const lineFromRef = (value: string): number | null => {
  const match = value.match(/:(\d+)(?::\d+)?$/);
  return match ? Number(match[1]) : null;
};

// Strip a trailing `:line` / `:line:col` suffix (e.g. `src/foo.ts:130`).
const stripLineSuffix = (value: string): string => value.replace(/:\d+(?::\d+)?$/, '');

// A usable file path contains a separator or a filename with an extension.
const looksLikeFilePath = (value?: string): value is string => {
  if (!value) {
    return false;
  }
  const cleaned = stripLineSuffix(value.trim());
  if (!cleaned || cleaned === '#') {
    return false;
  }
  return /[\\/]/.test(cleaned) || /\.[a-z0-9]+$/i.test(cleaned);
};

// Extract plain text from link children so a reference rendered only as link
// text (e.g. `[src/foo.ts]()` with an empty href) can still be opened.
const childrenToText = (children: React.ReactNode): string => {
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map(childrenToText).join('');
  }
  if (React.isValidElement(children)) {
    return childrenToText((children.props as { children?: React.ReactNode }).children);
  }
  return '';
};

// The only delimiter `remark-math` recognizes with `singleDollarTextMath` off.
// `\(…\)` and `\[…\]` are already rewritten to `$$` by normalizeLatexDelimiters,
// so this one probe covers both notations.
const MATH_DELIMITER = /\$\$/;

const EMPTY_PLUGINS: never[] = [];

type CodeBlockProps = {
  node?: any;
  className?: string;
  children?: React.ReactNode;
  /** Set by the custom `pre` renderer: this code element is a fenced/indented block. */
  forceBlock?: boolean;
};

// `node` is destructured out so react-markdown's hast node never reaches the DOM.
const CodeBlock = ({ node: _node, className, children, forceBlock, ...props }: CodeBlockProps) => {
  const { t } = useTranslation('chat');
  const [copied, setCopied] = useState(false);
  // Fenced blocks carry a trailing newline in the tree; trim it so the
  // highlighter doesn't render an empty final line.
  const raw = (Array.isArray(children) ? children.join('') : String(children ?? '')).replace(/\n$/, '');
  // react-markdown v9+ dropped the `inline` prop: block code is whatever the
  // `pre` renderer hands us (forceBlock). Multiline is kept as a safety net.
  const shouldInline = !forceBlock && !/[\r\n]/.test(raw);

  if (shouldInline) {
    return (
      <code
        className={`whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted px-1.5 py-0.5 font-mono text-[0.875em] text-foreground ${className || ''
          }`}
        {...props}
      >
        {children}
      </code>
    );
  }

  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : 'text';
  const languageLabel = language.charAt(0).toUpperCase() + language.slice(1);

  if (language === 'mermaid') {
    return <MermaidDiagram code={raw} />;
  }

  return (
    <div className="group my-3 overflow-hidden rounded-xl border border-border bg-muted/50 shadow-sm dark:bg-zinc-900">
      {/* Label row shares the block's background — no divider, ChatGPT-style */}
      <div className="flex items-center justify-between px-4 pt-2">
        <span className="select-none text-xs text-muted-foreground">{languageLabel}</span>
        <button
          type="button"
          onClick={() =>
            copyTextToClipboard(raw).then((success) => {
              if (success) {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }
            })
          }
          className={`rounded-md p-1 transition-opacity focus-visible:opacity-100 ${copied
            ? 'text-green-600 opacity-100 dark:text-green-500'
            : 'text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100'
            }`}
          title={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
          aria-label={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
        >
          {copied ? (
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
            </svg>
          )}
        </button>
      </div>

      <SyntaxHighlighter
        language={language}
        style={syntaxTheme.style}
        customStyle={{
          margin: 0,
          borderRadius: 0,
          fontSize: '0.8125rem',
          lineHeight: 1.6,
          padding: '0.5rem 1rem 1rem',
          // The container owns the background so the label row and code read as one panel.
          background: 'transparent',
        }}
        codeTagProps={{
          style: {
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            background: 'transparent',
          },
        }}
      >
        {raw}
      </SyntaxHighlighter>
    </div>
  );
};

/**
 * One style object for both themes: switching between the two Prism objects
 * re-tokenized every mounted code block, so the theme-dependent values are CSS
 * variables and the toggle is a style recalculation instead.
 */
const syntaxTheme = buildSyntaxTheme(oneLight as PrismStyleSheet, oneDark as PrismStyleSheet);

// The `:root`/`.dark` declarations backing syntaxTheme.style. Injected once
// because the values are derived from the Prism theme objects at runtime and so
// cannot live in index.css. ThemeContext toggles `.dark` on <html>, which is
// what repaints the tokens.
const SYNTAX_THEME_STYLE_ELEMENT_ID = 'cc-syntax-theme';
if (!document.getElementById(SYNTAX_THEME_STYLE_ELEMENT_ID)) {
  const styleElement = document.createElement('style');
  styleElement.id = SYNTAX_THEME_STYLE_ELEMENT_ID;
  styleElement.textContent = syntaxTheme.css;
  document.head.appendChild(styleElement);
}

const markdownComponents = {
  code: CodeBlock,
  // Workspace image paths are fetched through the authenticated files route;
  // a bare <img src> would resolve against the web origin and 404.
  img: MarkdownImage,
  // Fenced/indented code arrives as <pre><code>. Re-render the child CodeBlock
  // with `forceBlock` so it always gets the block treatment (react-markdown v9+
  // no longer passes an `inline` flag), and skip the outer <pre> so Tailwind
  // Typography doesn't wrap the highlighter in a second dark shell.
  pre: ({ children }: { children?: React.ReactNode }) => {
    const child = Array.isArray(children) ? children.find(React.isValidElement) : children;
    if (React.isValidElement(child) && child.type === CodeBlock) {
      return <CodeBlock {...(child.props as CodeBlockProps)} forceBlock />;
    }
    return <>{children}</>;
  },
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-3 border-l-2 border-primary/50 pl-4 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-t border-border" />,
  p: ({ children }: { children?: React.ReactNode }) => <div className="mb-2 last:mb-0">{children}</div>,
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="mb-2 list-outside list-disc space-y-1 pl-5 marker:text-current last:mb-0">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="mb-2 list-outside list-decimal space-y-1 pl-5 marker:text-current last:mb-0">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => <li className="[&>div:last-child]:mb-0 [&>div]:mb-1">{children}</li>,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border">
      {/* my-0 cancels Tailwind Typography's table margin, which would show as blank bands inside the border */}
      <table className="my-0 min-w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => <thead className="bg-muted/60">{children}</thead>,
  tr: ({ children }: { children?: React.ReactNode }) => (
    <tr className="[&:last-child>td]:border-b-0">{children}</tr>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border-b border-border px-3 py-2 text-left font-semibold text-foreground">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border-b border-border/60 px-3 py-2 align-top">{children}</td>
  ),
};

const TRANSAM_TAG_HINT = /<(?:ta|tw)_(?:plan|zh|source|time|status|npc_inner|hub|record|choices|speech_src|speech_zh|noise_pad|user_record|resolve)\b|<bbs_start\b/i;

export function formatTransAmMarkdown(input: string): string {
  if (!input || !TRANSAM_TAG_HINT.test(input)) {
    return input;
  }
  const codeFences: string[] = [];
  let out = input.replace(/```[\s\S]*?(?:```|$)/g, (match) => {
    const idx = codeFences.length;
    codeFences.push(match);
    return `\x00TA_FENCE_${idx}\x00`;
  });

  // Strip noise pads, user_record, and resolve markers
  out = out.replace(/<ta_noise_pad\s*>[^<>]*?<\/ta_noise_pad\s*>/gi, '');
  out = out.replace(/<(?:ta|tw)_user_record\b[^>]*>[\s\S]*?<\/(?:ta|tw)_user_record\s*>/gi, '');
  out = out.replace(/<ta_resolve\b[^>]*>[\s\S]*?<\/ta_resolve\s*>[ \t]*(?:\r?\n)?/gi, '');

  // Format <ta_plan> creative brief
  out = out.replace(
    /<(?:ta|tw)_plan\s*>([\s\S]*?)<\/(?:ta|tw)_plan\s*>/gi,
    (_m, body: string) => {
      const lines = body.trim().split(/\r?\n/).map((l) => `> ${l}`).join('\n');
      return `\n\n> 🧠 **TRANS-AM 创作简报**\n${lines}\n\n`;
    },
  );

  // Format <ta_time> / <bbs_start>
  out = out.replace(
    /<(bbs_start|(?:ta|tw)_time)\b[^>]*>\s*([^<>\r\n]+?)\s*<\/\1\s*>/gi,
    (_m, _tag, timeText: string) => `\n\n> 🕒 **${timeText.trim()}**\n\n`,
  );

  // Format bilingual dialogue <ta_speech_src>...<ta_speech_zh>...
  out = out.replace(
    /<(?:ta|tw)_speech_src\b[^>]*>([\s\S]*?)<\/(?:ta|tw)_speech_(?:src|zh)\s*>\s*<(?:ta|tw)_speech_zh\b[^>]*>([\s\S]*?)<\/(?:ta|tw)_speech_zh\s*>/gi,
    (_m, src: string, zh: string) => {
      const s = src.trim();
      const z = zh.trim();
      return s === z ? z : `${s}（${z}）`;
    },
  );
  out = out.replace(/<\/?(?:ta|tw)_speech_(?:src|zh)\b[^>]*>/gi, '');

  // Unwrap <ta_zh> and <ta_source>
  out = out.replace(/<\/?(?:ta|tw)_(?:zh|source)\b[^>]*>/gi, '\n\n');

  // Format <ta_status>
  out = out.replace(
    /<(?:ta|tw)_status\b[^>]*>([\s\S]*?)<\/(?:ta|tw)_status\s*>/gi,
    (_m, statusText: string) => `\n\n> 📡 **TRANS-AM 状态**：${statusText.trim()}\n\n`,
  );

  // Format <ta_npc_inner>
  out = out.replace(
    /<(?:ta|tw)_npc_inner\b[^>]*>([\s\S]*?)<\/(?:ta|tw)_npc_inner\s*>/gi,
    (_m, innerText: string) => {
      const lines = innerText.trim().split(/\r?\n/).map((l) => `> ${l}`).join('\n');
      return `\n\n> 💭 **人物心声**\n${lines}\n\n`;
    },
  );

  // Format <ta_hub>
  out = out.replace(
    /<(?:ta|tw)_hub\s*>([\s\S]*?)<\/(?:ta|tw)_hub\s*>/gi,
    (_m, hubJson: string) => `\n\n\`\`\`json\n${hubJson.trim()}\n\`\`\`\n\n`,
  );

  // Format <ta_record>
  out = out.replace(
    /<(?:ta|tw)_record\s*>([\s\S]*?)<\/(?:ta|tw)_record\s*>/gi,
    (_m, recText: string) => {
      const lines = recText.trim().split(/\r?\n/).map((l) => `> ${l}`).join('\n');
      return `\n\n> 📚 **剧情存档**\n${lines}\n\n`;
    },
  );

  // Format <ta_choices> 4-way suggestions
  out = out.replace(
    /<(?:ta|tw)_choices\s*>\s*<(?:ta|tw)_plot>([\s\S]*?)<\/(?:ta|tw)_plot>\s*<(?:ta|tw)_bond>([\s\S]*?)<\/(?:ta|tw)_bond>\s*<(?:ta|tw)_fun>([\s\S]*?)<\/(?:ta|tw)_fun>\s*<(?:ta|tw)_explore>([\s\S]*?)<\/(?:ta|tw)_explore>\s*<\/(?:ta|tw)_choices\s*>/gi,
    (_m, plot: string, bond: string, fun: string, explore: string) =>
      `\n\n> 🎯 **四向行动建议**\n> - 🗡️ **剧情推进**：${plot.trim()}\n> - 💗 **关系羁绊**：${bond.trim()}\n> - 🎭 **趣味互动**：${fun.trim()}\n> - 🧭 **自由探索**：${explore.trim()}\n\n`,
  );

  if (codeFences.length > 0) {
    out = out.replace(/\x00TA_FENCE_(\d+)\x00/g, (_m, idx) => codeFences[Number(idx)] ?? '');
  }
  return out;
}

/**
 * Used by chat's MessageComponent, ToolErrorDisplay and MarkdownContent to
 * render model-authored markdown with this module's shared prose styling,
 * code highlighting and table rules.
 */
function MarkdownBodyRenderer({ children, breaks = false }: Omit<MarkdownProps, 'className'>) {
  const content = useMemo(
    // The LaTeX pass runs second because it reads the code spans the fence pass
    // normalizes, and must leave the LaTeX inside them literal.
    () => normalizeLatexDelimiters(normalizeInlineCodeFences(formatTransAmMarkdown(String(children ?? '')))),
    [children],
  );
  // Math support costs a remark tree pass plus a full KaTeX walk on every
  // render, and almost no assistant message contains math. Only wire the two
  // plugins up when the text has a delimiter they could act on.
  const hasMath = useMemo(() => MATH_DELIMITER.test(content), [content]);
  const remarkPlugins = useMemo(
    () => {
      const plugins: unknown[] = [remarkGfm];
      if (hasMath) {
        plugins.push([remarkMath, { singleDollarTextMath: false }]);
      }
      if (breaks) {
        plugins.push(remarkBreaks);
      }
      return plugins as any;
    },
    [breaks, hasMath],
  );
  const rehypePlugins = useMemo(() => (hasMath ? [rehypeKatex] : EMPTY_PLUGINS), [hasMath]);
  const { openFileInEditor, openDirectory } = usePaletteOps();

  const components = useMemo(
    () => ({
      ...markdownComponents,
      a: ({ href, children: linkChildren }: { href?: string; children?: React.ReactNode }) => {
        // Prefer the href when it is a real path; otherwise fall back to the
        // link text, since models often emit `[src/foo.ts]()` with an empty href.
        const linkText = childrenToText(linkChildren);
        const fileRef = looksLikeFilePath(href) ? href : looksLikeFilePath(linkText) ? linkText : undefined;

        if (href?.startsWith('/downloads/')) {
          const downloadLink = (
            <a href={href} download className="text-blue-600 hover:underline dark:text-blue-400">
              {linkChildren}
            </a>
          );
          if (isImagePath(href)) {
            return (
              <span className="my-1 block">
                <MarkdownImage src={href} alt={linkText} />
                <span className="inline-block text-xs">{downloadLink}</span>
              </span>
            );
          }
          if (isVideoPath(href)) {
            return (
              <span className="my-1 block">
                <MarkdownVideo src={href} alt={linkText} />
                <span className="inline-block text-xs">{downloadLink}</span>
              </span>
            );
          }
          return downloadLink;
        }
        if (href?.startsWith('/api/download?')) {
          const rawPath = new URL(href, 'http://localhost').searchParams.get('path')?.trim();
          if (rawPath) {
            const targetPath = rawPath.startsWith('file://') ? rawPath.replace(/^file:\/\/+/, '/') : rawPath;
            if (isImagePath(targetPath)) {
              return (
                <span className="my-1 block">
                  <MarkdownImage src={targetPath} alt={linkText} />
                  <span className="inline-block text-xs"><MarkdownDownload path={targetPath}>{linkChildren}</MarkdownDownload></span>
                </span>
              );
            }
            if (isVideoPath(targetPath)) {
              return (
                <span className="my-1 block">
                  <MarkdownVideo src={targetPath} alt={linkText} />
                  <span className="inline-block text-xs"><MarkdownDownload path={targetPath}>{linkChildren}</MarkdownDownload></span>
                </span>
              );
            }
            return <MarkdownDownload path={targetPath}>{linkChildren}</MarkdownDownload>;
          }
        }
        if (href && !isExternalHref(href) && (href.startsWith('/mnt/data/') || href.includes('/.cloudcli/assets/') ||
          /\.(?:zip|gz|7z|pdf|docx?|xlsx?|pptx?|csv|png|jpe?g|gif|webp|svg|avif|bmp|mp[34]|wav|webm|mov|m4v|ogv)$/i.test(href))) {
          let path = href;
          try { path = decodeURIComponent(href); } catch { /* Preserve a literal percent sign. */ }
          if (isImagePath(path)) {
            return (
              <span className="my-1 block">
                <MarkdownImage src={path} alt={linkText} />
                <span className="inline-block text-xs"><MarkdownDownload path={path}>{linkChildren}</MarkdownDownload></span>
              </span>
            );
          }
          if (isVideoPath(path)) {
            return (
              <span className="my-1 block">
                <MarkdownVideo src={path} alt={linkText} />
                <span className="inline-block text-xs"><MarkdownDownload path={path}>{linkChildren}</MarkdownDownload></span>
              </span>
            );
          }
          return <MarkdownDownload path={path}>{linkChildren}</MarkdownDownload>;
        }
        if (fileRef && !isExternalHref(href)) {
          return (
            <><a
              href={href || fileRef}
              className="cursor-pointer text-blue-600 hover:underline dark:text-blue-400"
              onClick={(event) => {
                event.preventDefault();
                // Normalized once for every branch below: the href arrives
                // trimmed from the parser, but the link-text fallback keeps a
                // trailing space (``[`src/foo.ts:12` ]()``), and that space
                // defeats the `$`-anchored suffix strip.
                const reference = fileRef.trim();
                if (reference.endsWith('/')) {
                  openDirectory(reference);
                  return;
                }
                openFileInEditor(stripLineSuffix(reference), lineFromRef(reference));
              }}
            >
              {linkChildren}
            </a>{!fileRef.endsWith('/') && lineFromRef(fileRef) === null && (
              <span className="ml-1 text-xs"><MarkdownDownload path={fileRef}>下载</MarkdownDownload></span>
            )}</>
          );
        }

        return (
          <a
            href={href}
            className="text-blue-600 hover:underline dark:text-blue-400"
            target="_blank"
            rel="noopener noreferrer"
          >
            {linkChildren}
          </a>
        );
      },
    }),
    [openFileInEditor, openDirectory],
  );

  return (
    <ReactMarkdown
      urlTransform={url => {
        if (url.startsWith('sandbox:/mnt/data/')) return url.slice('sandbox:'.length);
        if (url.startsWith('file://')) return url.replace(/^file:\/\/+/, '/');
        return defaultUrlTransform(url);
      }}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={components as any}
    >
      {content}
    </ReactMarkdown>
  );
}

/**
 * Markdown blocks without the prose wrapper. Used by StreamingMarkdown so a
 * streamed reply's settled and pending halves render as siblings inside ONE
 * prose container — Tailwind Typography's `> :first-child`/`> :last-child`
 * margin rules are per-container, so two containers would zero the gap at the
 * seam and make it pop back when the boundary moves.
 *
 * Memoized so a re-render does not re-run remark, rehype, KaTeX and Prism over
 * text that has not changed.
 */
export const MarkdownBody = memo(MarkdownBodyRenderer);

/** Markdown in its own prose container. The form every non-streaming caller uses. */
export const Markdown = memo(function Markdown({ children, className, breaks }: MarkdownProps) {
  return (
    <div className={className}>
      <MarkdownBody breaks={breaks}>{children}</MarkdownBody>
    </div>
  );
});
