import { AppError } from '@/shared/utils.js';

/** Used by the System routes to prevent an upstream installer from replacing mintcli. */
export function createSystemUpdateService() {
  return {
    async updateSystem(): Promise<never> {
      throw new AppError('mintcli does not accept upstream updates.', { code: 'SYSTEM_UPDATES_DISABLED', statusCode: 403 });
    },
  };
}
