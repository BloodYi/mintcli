import { sessionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

function readCodexSession(sessionId: string) {
  const session = sessionsDb.getSessionById(sessionId);
  if (!session || session.provider !== 'codex') {
    throw new AppError('Codex session not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
  }
  return session;
}

/** Used by provider routes to read and persist Codex speed independently of reasoning effort. */
export const codexFastModeService = {
  get(sessionId: string) {
    return { sessionId, fastMode: readCodexSession(sessionId).fast_mode === 1 };
  },
  set(sessionId: string, enabled: boolean) {
    readCodexSession(sessionId);
    sessionsDb.setSessionFastMode(sessionId, enabled);
    return { sessionId, fastMode: enabled };
  },
};
