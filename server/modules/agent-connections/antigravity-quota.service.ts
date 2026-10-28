type NativeQuota = {
  timestamp: number;
  quotas?: { model: string; type: string; type_name?: string; label?: string; percentage?: number; resets_at?: string }[];
};

/** Used by connections.routes to preserve native agy model groups and account-specific windows. */
export function antigravityQuotaSnapshot(quota: NativeQuota) {
  const windows = (quota.quotas || []).map(item => ({
    model: item.model,
    type: item.type,
    bucket: item.type_name || item.label || item.type,
    remainingPercent: typeof item.percentage === 'number' && Number.isFinite(item.percentage) ? item.percentage : null,
    resetsAt: item.resets_at ? Date.parse(item.resets_at) / 1000 || null : null,
  }));
  return {
    status: windows.length ? 'available' : 'unavailable',
    reason: windows.length ? undefined : 'agy 未返回额度',
    checkedAt: quota.timestamp * 1000,
    windows,
  };
}
