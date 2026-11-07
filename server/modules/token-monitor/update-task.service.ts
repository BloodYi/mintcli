import { appConfigDb } from '@/modules/database/index.js';
import { providerRuntimeService, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import { AppError, findApplicationRoot, getModuleDirectory } from '@/shared/index.js';
import { tokenMonitorService } from './token-monitor.service.js';

type UpdateTask = {
  sessionId: string; targetVersion: string; startedAt: number;
  state: 'running' | 'review' | 'failed' | 'interrupted' | 'installed';
};
const KEY = 'token-monitor-update-task';
function installedAtLeast(installed: string, target: string) {
  if (![installed, target].every(value => /^\d+\.\d+\.\d+$/.test(value))) return false;
  const current = installed.split('.').map(Number), wanted = target.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (current[index] !== wanted[index]) return current[index] > wanted[index];
  return true;
}
const dependencies = {
  read(): UpdateTask | null {
    try { return JSON.parse(appConfigDb.get(KEY) || 'null'); } catch { return null; }
  },
  write(task: UpdateTask) { appConfigDb.set(KEY, JSON.stringify(task)); },
  check: () => tokenMonitorService.updates(),
  running: (id: string) => chatRunRegistry.getRun(id)?.status === 'running',
  root: () => findApplicationRoot(getModuleDirectory(import.meta.url)),
  create: (root: string) => sessionsService.createAppSession('codex', root, 'Token Monitor 规则更新').sessionId,
  launch: (sessionId: string, userId: string | number | null, content: string) => runDetachedChatTurn(
    { sessionId, userId, content }, { runtime: providerRuntimeService },
  ),
};

/** Used by monitoring routes and focused tests to start one durable, rule-guided update conversation. */
export function createMonitorUpdateTaskService(overrides: Partial<typeof dependencies> = {}) {
  const deps = { ...dependencies, ...overrides };
  // Coalesce concurrent clicks before the release lookup and session allocation finish.
  let starting: Promise<UpdateTask> | null = null;
  async function status() {
    const task = deps.read();
    if (!task) return null;
    const release = await deps.check();
    if (installedAtLeast(release.installedVersion, task.targetVersion)) return { ...task, state: 'installed' as const };
    if (task.state === 'running' && !deps.running(task.sessionId)) return { ...task, state: 'interrupted' as const };
    return task;
  }
  function start(userId: string | number | null): Promise<UpdateTask> {
    if (starting) return starting;
    starting = (async () => {
      const previous = deps.read();
      if (previous && deps.running(previous.sessionId)) return previous;
      const release = await deps.check();
      // A finished agent may have queued deployment behind other conversations.
      // Keep that task reserved until its target is running or it explicitly fails.
      if (previous?.state === 'review' && !installedAtLeast(release.installedVersion, previous.targetVersion)) return previous;
      if (release.status !== 'ok' || !release.updateAvailable || !/^\d+\.\d+\.\d+$/.test(String(release.latestVersion))) {
        throw new AppError('当前没有可验证的新版本，请稍后重新检查。', { code: 'NO_MONITOR_UPDATE', statusCode: 409 });
      }
      const root = deps.root();
      const task: UpdateTask = { sessionId: deps.create(root), targetVersion: String(release.latestVersion), startedAt: Date.now(), state: 'running' };
      deps.write(task);
      const prompt = `用户已点击 Token Monitor 更新按钮，授权执行适配更新至 ${task.targetVersion}。\n请先完整读取 ${root}/plugins/token-monitor/UPDATE_RULES.md 和仓库 AGENTS.md，严格沿用其中规则。\n从当前线上仓库 ${root} 的最新状态开始，检查完整上游差异，保留已有修复和其他工作，执行测试、构建和实际界面验证，再安排所有对话空闲后的可回滚部署。不要调用更新按钮或本更新接口递归创建任务。\n在此独立会话报告进度、验证证据、部署排队或生效状态；无法适配时明确失败原因，不得仅改版本号就声称功能已适配。`;
      // The existing chat gateway records the prompt, events and actual model, and
      // registers the run for idle-only deployments. No browser connection is required.
      void Promise.resolve().then(() => deps.launch(task.sessionId, userId, prompt)).then(result => {
        if (deps.read()?.sessionId === task.sessionId) deps.write({ ...task, state: result.started && !result.error ? 'review' : 'failed' });
      }).catch(() => {
        if (deps.read()?.sessionId === task.sessionId) deps.write({ ...task, state: 'failed' });
      });
      return task;
    })().finally(() => { starting = null; });
    return starting;
  }
  return { start, status };
}

/** Used by the authenticated monitor routes; state survives tabs and server restarts. */
export const monitorUpdateTaskService = createMonitorUpdateTaskService();
