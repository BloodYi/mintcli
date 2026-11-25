import { useCallback, useEffect, useState } from 'react';
import { api, readApiJson } from '@/shared/api';

export type AgyFastStatus = {
  installed: boolean;
  plugin_dir: string;
  repo: string;
  repo_url: string;
  installed_version: string | null;
  installed_commit: string | null;
  latest_version: string | null;
  latest_commit: string | null;
  release_url: string | null;
  update_available: boolean;
  auto_update_enabled: boolean;
  last_checked_at: string | null;
  last_updated_at: string | null;
  last_error: string | null;
  smoke_ok: boolean | null;
  server_name: string;
  adapted_tools: string[];
};

export function useAgyFastStatus(enabled = true) {
  const [status, setStatus] = useState<AgyFastStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.antigravity.agyFastStatus();
      if (!res.ok) return;
      const data = await readApiJson<AgyFastStatus>(res);
      setStatus(data);
      setError(null);
    } catch {
      // Non-fatal: bridge may still be starting up.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  const checkUpdate = useCallback(async () => {
    setChecking(true);
    setMessage(null);
    setError(null);
    try {
      const res = await api.antigravity.agyFastCheckUpdate();
      const data = await readApiJson<AgyFastStatus & { ok?: boolean }>(res);
      setStatus(data);
      if (data.ok === false || data.last_error) {
        setError(data.last_error || '检查更新失败');
      } else if (data.update_available) {
        setMessage(`发现新版本 ${data.latest_version ? `v${data.latest_version}` : data.latest_commit || ''}`);
      } else {
        setMessage(`已是最新 (${data.installed_version ? `v${data.installed_version}` : data.installed_commit || ''})`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '检查更新失败');
    } finally {
      setChecking(false);
    }
  }, []);

  const runUpdate = useCallback(async (force = false) => {
    setUpdating(true);
    setMessage(null);
    setError(null);
    try {
      const res = await api.antigravity.agyFastUpdate({ force });
      const data = await readApiJson<{
        ok?: boolean;
        updated?: boolean;
        rolled_back?: boolean;
        current_version?: string;
        error?: string;
        status?: AgyFastStatus;
      }>(res);
      if (data.status) setStatus(data.status);
      if (!data.ok) {
        setError(data.error || (data.rolled_back ? '验证失败已自动回滚' : '更新失败'));
      } else if (data.updated) {
        setMessage(`已更新并适配至 v${data.current_version || data.status?.installed_version || ''}`);
      } else {
        setMessage(`已是最新版本 (v${data.current_version || data.status?.installed_version || ''})`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新失败');
    } finally {
      setUpdating(false);
    }
  }, []);

  const toggleAutoUpdate = useCallback(async () => {
    const next = !(status?.auto_update_enabled ?? true);
    setError(null);
    try {
      const res = await api.antigravity.agyFastConfig({ auto_update_enabled: next });
      const data = await readApiJson<AgyFastStatus>(res);
      setStatus(data);
      setMessage(next ? '已开启自动检查并更新适配' : '已关闭自动更新');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存设置失败');
    }
  }, [status?.auto_update_enabled]);

  return {
    status,
    checking,
    updating,
    message,
    error,
    refresh,
    checkUpdate,
    runUpdate,
    toggleAutoUpdate,
  };
}
