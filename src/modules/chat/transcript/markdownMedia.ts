import { api } from '@/shared/api';

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
const VIDEO_EXT_RE = /\.(?:mp4|webm|mov|m4v|ogv)$/i;

/** Sources the browser can load directly without an authenticated blob fetch. */
export const isBrowserLoadableMediaSrc = (src: string): boolean =>
  src.startsWith('/downloads/') || /^(https?:|data:|blob:)/i.test(src);

const stripQueryAndHash = (value: string): string => value.split('#')[0].split('?')[0];

/**
 * Normalize a markdown media reference (workspace path, `file://`, `sandbox:`,
 * or `/api/download?path=...`) into the path expected by the file endpoints.
 */
export const extractMediaPath = (raw: string): string => {
  let workspacePath = raw.trim();
  if (workspacePath.startsWith('/api/download?')) {
    const param = new URL(workspacePath, 'http://localhost').searchParams.get('path')?.trim();
    workspacePath = param || '';
  }
  if (workspacePath.startsWith('sandbox:/mnt/data/')) {
    workspacePath = workspacePath.slice('sandbox:'.length);
  }
  if (workspacePath.startsWith('file://')) {
    workspacePath = workspacePath.replace(/^file:\/\/+/, '/');
  }
  if (workspacePath.startsWith('./')) {
    workspacePath = workspacePath.slice(2);
  }
  try {
    workspacePath = decodeURI(workspacePath);
  } catch {
    // Keep the raw value when it is not valid percent-encoding.
  }
  return workspacePath;
};

export const isImagePath = (value?: string): boolean => {
  if (!value) {
    return false;
  }
  const target = value.trim().startsWith('/api/download?') ? extractMediaPath(value) : value.trim();
  return IMAGE_EXT_RE.test(stripQueryAndHash(target));
};

export const isVideoPath = (value?: string): boolean => {
  if (!value) {
    return false;
  }
  const target = value.trim().startsWith('/api/download?') ? extractMediaPath(value) : value.trim();
  return VIDEO_EXT_RE.test(stripQueryAndHash(target));
};

export const inferVideoMimeType = (path: string, fallbackType?: string): string => {
  if (fallbackType && fallbackType.startsWith('video/')) {
    return fallbackType;
  }
  const clean = stripQueryAndHash(path).toLowerCase();
  if (clean.endsWith('.webm')) return 'video/webm';
  if (clean.endsWith('.mov')) return 'video/quicktime';
  if (clean.endsWith('.ogv')) return 'video/ogg';
  if (clean.endsWith('.mp4') || clean.endsWith('.m4v')) return 'video/mp4';
  return fallbackType || 'video/mp4';
};

export async function fetchMediaBlob(
  rawSrc: string,
  projectId: string | null,
  kind: 'image' | 'video',
  signal?: AbortSignal,
): Promise<Blob | null> {
  const path = extractMediaPath(rawSrc);
  if (!path) {
    return null;
  }

  let response: Response | null = null;
  if (path.includes('/.cloudcli/assets/')) {
    const filename = path.split('/').pop()!;
    response =
      kind === 'image'
        ? await api.assets.image(filename, { signal })
        : await api.assets.file(filename, { signal });
  } else if (projectId) {
    response = await api.readFileBlob(projectId, path, { signal });
  }

  if ((!response || !response.ok) && api.antigravity?.download) {
    response = await api.antigravity.download(path, { signal });
  }

  if (!response || !response.ok) {
    return null;
  }

  const blob = await response.blob();
  if (kind === 'video' && (!blob.type || !blob.type.startsWith('video/'))) {
    return new Blob([blob], { type: inferVideoMimeType(path, blob.type) });
  }
  return blob;
}
