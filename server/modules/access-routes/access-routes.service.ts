import fs from 'node:fs';

import { AppError } from '@/shared/index.js';

type AccessRoute = { id: string; name: string; origin: string };
function invalid(): never {
  throw new AppError('网站访问线路配置无效', { statusCode: 503, code: 'INVALID_ACCESS_ROUTES' });
}

/** Used by the authenticated access-routes router to list operator-owned website entrances, independently of model API egress. */
export function accessRouteStatus(): { routes: AccessRoute[]; defaultId: string | null } {
  const file = process.env.MINTCLI_ACCESS_ROUTES_FILE || '/etc/mintcli/access-routes.json';
  let config: unknown;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { routes: [], defaultId: null }; invalid(); }
  if (!config || typeof config !== 'object' || !Array.isArray((config as { routes?: unknown }).routes)) invalid();
  const input = config as { routes: unknown[]; defaultId?: unknown };
  if (input.routes.length > 10) invalid();
  const ids = new Set<string>();
  const origins = new Set<string>();
  const routes = input.routes.map(value => {
    if (!value || typeof value !== 'object') invalid();
    const route = value as Record<string, unknown>;
    if (typeof route.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(route.id) || ids.has(route.id)) invalid();
    if (typeof route.name !== 'string' || !route.name.trim() || route.name.length > 80 || typeof route.origin !== 'string') invalid();
    let url: URL;
    try { url = new URL(route.origin); } catch { invalid(); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.hostname.includes('.') || origins.has(url.origin)) invalid();
    ids.add(route.id); origins.add(url.origin);
    return { id: route.id, name: route.name.trim(), origin: url.origin };
  });
  const defaultId = typeof input.defaultId === 'string' && ids.has(input.defaultId) ? input.defaultId : routes[0]?.id || null;
  return { routes, defaultId };
}
