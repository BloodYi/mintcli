import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageOff } from 'lucide-react';

import { api } from '@/shared/api';
import { useMarkdownWorkspaceProjectId } from '@/modules/chat/context/MarkdownWorkspaceContext';
import { ImageLightbox } from '@/modules/chat/transcript/ChatMessageImages';
import { MarkdownVideo } from '@/modules/chat/transcript/MarkdownVideo';
import {
  fetchMediaBlob,
  isBrowserLoadableMediaSrc,
  isVideoPath,
} from '@/modules/chat/transcript/markdownMedia';

type MarkdownImageProps = {
  node?: unknown;
  src?: string;
  alt?: string;
  title?: string;
};

type LoadedImage = { key: string; url: string | null; failed: boolean };

/**
 * Resolves a markdown image src to something an <img> can display. Web, data
 * and blob URLs pass through untouched; workspace paths are fetched as blobs
 * (a bare <img src> cannot carry the auth header) and exposed as object URLs.
 */
function useMarkdownImageSrc(src: string, projectId: string | null): { src: string | null; failed: boolean } {
  const passthrough = isBrowserLoadableMediaSrc(src);
  const canFetch = Boolean(projectId || api.antigravity?.download || src.includes('/.cloudcli/assets/'));
  // Keyed by what was requested so a src change reads as "loading" until the
  // new fetch settles, without resetting state synchronously in the effect.
  const key = `${projectId ?? ''}:${src}`;
  const [loaded, setLoaded] = useState<LoadedImage | null>(null);

  useEffect(() => {
    if (passthrough || !canFetch) {
      return;
    }

    let objectUrl: string | null = null;
    const controller = new AbortController();

    const load = async () => {
      try {
        const blob = await fetchMediaBlob(src, projectId, 'image', controller.signal);
        if (controller.signal.aborted) return;
        if (!blob) {
          setLoaded({ key, url: null, failed: true });
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ key, url: objectUrl, failed: false });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return;
        }
        setLoaded({ key, url: null, failed: true });
      }
    };

    void load();

    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [canFetch, key, passthrough, projectId, src]);

  if (passthrough) {
    return { src, failed: false };
  }
  if (!canFetch) {
    return { src: null, failed: true };
  }
  const current = loaded && loaded.key === key ? loaded : null;
  return { src: current?.url ?? null, failed: current?.failed ?? false };
}

function MarkdownImageInner({ src, alt, title }: { src: string; alt?: string; title?: string }) {
  const { t } = useTranslation();
  const projectId = useMarkdownWorkspaceProjectId();
  const { src: resolved, failed } = useMarkdownImageSrc(src, projectId);
  const [expanded, setExpanded] = useState(false);

  const label = alt || title || src;

  if (failed) {
    return (
      <span
        className="my-1 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-muted px-2 py-1 text-xs text-muted-foreground"
        title={src}
      >
        <ImageOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </span>
    );
  }

  if (!resolved) {
    return <span className="my-2 block h-40 max-w-md animate-pulse rounded-xl border border-border/50 bg-muted" />;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-label={t('chat:misc.expandImage', { name: label })}
        className="my-2 block max-w-full overflow-hidden rounded-xl border border-border/50 bg-muted/30 shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/60"
      >
        <img
          src={resolved}
          alt={alt ?? ''}
          title={title}
          loading="lazy"
          className="block max-h-96 max-w-full cursor-zoom-in object-contain"
        />
      </button>
      {expanded && <ImageLightbox src={resolved} alt={label} onClose={() => setExpanded(false)} />}
    </>
  );
}

/**
 * `img` renderer for chat markdown. Shows images the model references by
 * workspace path (screenshots it took, files it generated) inline, with the
 * same click-to-expand lightbox as user attachments. Video paths embedded via
 * `![alt](video.mp4)` are delegated to an inline video player.
 */
export function MarkdownImage({ node: _node, src, alt, title }: MarkdownImageProps) {
  const source = src ?? '';
  if (!source) {
    return null;
  }

  if (isVideoPath(source)) {
    return <MarkdownVideo src={source} alt={alt} title={title} />;
  }

  return <MarkdownImageInner src={source} alt={alt} title={title} />;
}
