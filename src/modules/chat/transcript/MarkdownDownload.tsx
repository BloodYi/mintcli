import { useState } from 'react';
import type { ReactNode } from 'react';
import { useMarkdownWorkspaceProjectId } from '@/modules/chat/context/MarkdownWorkspaceContext';
import { api } from '@/shared/api';

/** Used by chat markdown to save a generated file through the reader's browser. */
export function MarkdownDownload({ path, children }: { path: string; children: ReactNode }) {
  const projectId = useMarkdownWorkspaceProjectId();
  // Expose pending downloads and allow a failed transfer to be retried.
  const [status, setStatus] = useState<'idle' | 'pending' | 'error'>('idle');
  const download = async () => {
    setStatus('pending');
    try {
      const filename = path.split('/').pop() || 'download';
      const response = path.includes('/.cloudcli/assets/')
        ? await api.assets.file(filename)
        : projectId && await api.readFileBlob(projectId, path);
      if (!response || !response.ok) throw new Error('File unavailable');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  };
  return <><button type="button" disabled={status === 'pending'} className="text-blue-600 hover:underline dark:text-blue-400" onClick={() => void download()}>{children}</button>
    {status === 'error' && <span role="alert"> 文件读取失败，请检查文件是否仍存在。</span>}</>;
}
