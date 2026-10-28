import { readFile } from 'node:fs/promises';
import path from 'node:path';
import TOML from '@iarna/toml';
import { getCodexModelCatalog, resolveCodexConnection } from '@/modules/codex-connections/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type { ProviderCurrentActiveModel, ProviderModelsDefinition } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

/** Provider registry adapter uses the selected account's live catalog; fixed and stale cached catalogs are not availability evidence. */
export class CodexProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return getCodexModelCatalog();
  }
  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    const item = resolveCodexConnection();
    const catalog = await this.getSupportedModels();
    try {
      const config = readObjectRecord(TOML.parse(await readFile(path.join(item.home, 'config.toml'), 'utf8')));
      const model = readOptionalString(config?.model);
      if (model && catalog.OPTIONS.some(option => option.value === model)) return { model };
    } catch { /* Missing config uses the first model returned for this account. */ }
    return { model: catalog.DEFAULT };
  }
}
