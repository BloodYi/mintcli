import { useEffect, useState } from 'react';
import { Film, VideoOff } from 'lucide-react';

import { api } from '@/shared/api';
import { useMarkdownWorkspaceProjectId } from '@/modules/chat/context/MarkdownWorkspaceContext';
import { fetchMediaBlob, isBrowserLoadableMediaSrc } from '@/modules/chat/transcript/markdownMedia';

type MarkdownVideoProps = {
  src?: string;
  alt?: string;
  title?: string;
};

type LoadedVideo = { key: string; url: string | null; failed: boolean };

function useMarkdownVideoSrc(src: string, projectId: string | null): { src: string | null; failed: boolean } {
  const passthrough = isBrowserLoadableMediaSrc(src);
  const canFetch = Boolean(projectId || api.antigravity?.download || src.includes('/.cloudcli/assets/'));
  const key = `${projectId ?? ''}:${src}`;
  const [loaded, setLoaded] = useState<LoadedVideo | null>(null);

  useEffect(() => {
    if (passthrough || !canFetch) {
      return;
    }

    let objectUrl: string | null = null;
    const controller = new AbortController();

    const load = async () => {
      try {
        const blob = await fetchMediaBlob(src, projectId, 'video', controller.signal);
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

/**
 * Inline video player for chat markdown. Loads workspace/server videos through
 * the authenticated file routes and plays them directly inside the transcript.
 */
export function MarkdownVideo({ src, alt, title }: MarkdownVideoProps) {
  const projectId = useMarkdownWorkspaceProjectId();
  const source = src ?? '';
  const { src: resolved, failed } = useMarkdownVideoSrc(source, projectId);

  if (!source) {
    return null;
  }

  const label = alt || title || source.split('/').pop() || source;

  if (failed) {
    return (
      <span
        className="my-1 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-muted px-2 py-1 text-xs text-muted-foreground"
        title={source}
      >
        <VideoOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </span>
    );
  }

  if (!resolved) {
    return (
      <span className="my-2 flex h-44 max-w-md animate-pulse items-center justify-center gap-2 rounded-xl border border-border/50 bg-muted text-xs text-muted-foreground">
        <Film className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate px-2">正在加载视频…</span>
      </span>
    );
  }

  return (
    <div className="my-2 max-w-full overflow-hidden rounded-xl border border-border/50 bg-black/90 shadow-sm">
      <video
        src={resolved}
        controls
        playsInline
        preload="metadata"
        title={label}
        aria-label={label}
        className="block max-h-[420px] w-full max-w-2xl bg-black object-contain"
      />
    </div>
  );
}
