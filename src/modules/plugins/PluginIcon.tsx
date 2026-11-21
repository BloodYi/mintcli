import { useState, useEffect } from 'react';
import DOMPurify from 'dompurify';
import { Activity, BarChart3, Blocks, Gauge, Puzzle, Sparkles, Terminal, Wrench, type LucideIcon } from 'lucide-react';

import { api } from '@/shared/api';

type Props = {
  pluginName: string;
  iconFile: string;
  className?: string;
};

const NAMED_ICONS: Record<string, LucideIcon> = {
  activity: Activity,
  barchart3: BarChart3,
  blocks: Blocks,
  gauge: Gauge,
  puzzle: Puzzle,
  sparkles: Sparkles,
  terminal: Terminal,
  wrench: Wrench,
};

// Module-level cache so repeated renders don't re-fetch
const svgCache = new Map<string, string>();

const FORBIDDEN_SVG_TAGS = [
  'script',
  'foreignObject',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'style',
  'animate',
  'set',
  'animateTransform',
  'animateMotion',
];

const FORBIDDEN_SVG_ATTRS = [
  'href',
  'xlink:href',
  'src',
  'style',
];

function sanitizeSvg(svgText: string): string | null {
  const sanitized = DOMPurify.sanitize(svgText, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: FORBIDDEN_SVG_TAGS,
    FORBID_ATTR: FORBIDDEN_SVG_ATTRS,
  });

  if (!sanitized) return null;

  try {
    const doc = new DOMParser().parseFromString(sanitized, 'image/svg+xml');
    const root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== 'svg') return null;
    if (doc.querySelector('parsererror')) return null;
    return sanitized;
  } catch {
    return null;
  }
}

/** Used by the project-workspace module's tab bar and by this module's PluginSettingsTab to show a plugin's icon. */
export default function PluginIcon({ pluginName, iconFile, className }: Props) {
  const trimmedIcon = iconFile?.trim() ?? '';
  const isAssetFile = Boolean(trimmedIcon) && (trimmedIcon.includes('.') || trimmedIcon.includes('/'));
  const NamedIcon = !isAssetFile && trimmedIcon ? (NAMED_ICONS[trimmedIcon.toLowerCase()] ?? Puzzle) : null;
  const url = isAssetFile ? api.plugins.assetUrl(pluginName, trimmedIcon) : '';
  const [svg, setSvg] = useState<string | null>(url ? (svgCache.get(url) ?? null) : null);

  useEffect(() => {
    if (!isAssetFile || !url || svgCache.has(url)) return;
    api.plugins.asset(pluginName, trimmedIcon)
      .then((r) => {
        if (!r.ok) return;
        return r.text();
      })
      .then((text) => {
        if (!text) return;
        const sanitized = sanitizeSvg(text);
        if (sanitized) {
          svgCache.set(url, sanitized);
          setSvg(sanitized);
        }
      })
      .catch(() => {});
  }, [url, pluginName, trimmedIcon, isAssetFile]);

  if (NamedIcon) {
    return (
      <span className={className}>
        <NamedIcon className="h-full w-full" aria-hidden="true" />
      </span>
    );
  }

  if (!svg) {
    return (
      <span className={className}>
        <Puzzle className="h-full w-full opacity-75" aria-hidden="true" />
      </span>
    );
  }

  return (
    <span className={className} dangerouslySetInnerHTML={{ __html: svg }} />
  );
}
