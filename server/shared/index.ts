export { appendFilesInputTag, buildCodexInputItems, normalizeImageDescriptors } from './image-attachments.js';
export { createCompleteMessage, createNormalizedMessage } from './utils.js';
export type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from './types.js';
// Used by the connections module for validated application errors and thin routes.
export { AppError, asyncHandler } from './utils.js';

// Used by Token Monitor to resolve packaged parser assets.
export { findApplicationRoot, getModuleDirectory } from './utils.js';

// Used by Token Monitor to read and normalize titles from indexed Codex homes.
export { buildLookupMap, normalizeSessionName } from './utils.js';

// Used by provider and account modules to share the isolated CLI selection.
export { resolveManagedCli, resolveCodexLauncher, readCodexVersion } from './utils.js';

// Used by account authorization services to parse safe fields from native CLI output.
export { stripAnsiSequences } from './utils.js';

export type {
  MonitorGlobalModelUsage,
  MonitorGlobalSummary,
  MonitorModelAttributionSource,
  MonitorSessionModelUsage,
  MonitorThinkTranslateCooldown,
  MonitorThinkTranslateEvent,
  MonitorThinkTranslateModelRow,
  MonitorThinkTranslateSummary,
  MonitorTimedUsageEvent,
  MonitorTokens,
  ReplyModelEvidence,
} from './types.js';
