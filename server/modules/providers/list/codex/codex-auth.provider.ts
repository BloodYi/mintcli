import { readFile } from 'node:fs/promises';
import { getCodexModelCatalog, resolveCodexConnection } from '@/modules/codex-connections/index.js';
import { resolveCodexLauncher } from '@/shared/index.js';
import path from 'node:path';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { CliVersionProbe, ProviderAuthStatus } from '@/shared/types.js';
import { probeCliVersion, readObjectRecord, readOptionalString } from '@/shared/utils.js';

type CodexCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

export class CodexProviderAuth implements IProviderAuth {
  /**
   * Checks whether the Codex CLI that chats run is available, and which version
   * it is. Managed installations use mintcli's selected private release;
   * other hosts fall back to the application's bundled npm package.
   */
  checkInstalled(): CliVersionProbe {
    let launcherPath: string;
    try {
      launcherPath = resolveCodexLauncher();
    } catch {
      return { installed: false, exitCode: null, version: null };
    }
    return probeCliVersion(process.execPath, [launcherPath, '--version']);
  }

  /**
   * Returns Codex SDK availability and credential status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const { installed, version: installedVersion } = this.checkInstalled();
    let credentials = await this.checkCredentials();
    if (credentials.authenticated && resolveCodexConnection().kind === 'chatgpt') {
      try { await getCodexModelCatalog(); }
      catch (error) { credentials = { ...credentials, authenticated: false, error: error instanceof Error ? error.message : '官方授权检查失败' }; }
    }

    return {
      installed,
      provider: 'codex',
      installedVersion,
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Reads Codex auth.json and checks OAuth tokens or an API key fallback.
   */
  private async checkCredentials(): Promise<CodexCredentialsStatus> {
    try {
      const item = resolveCodexConnection();
      if (item.kind === 'api') return { authenticated: Boolean(item.apiKey), email: item.name, method: 'api_key' };
      const authPath = path.join(item.home, 'auth.json');
      const content = await readFile(authPath, 'utf8');
      const auth = readObjectRecord(JSON.parse(content)) ?? {};
      const tokens = readObjectRecord(auth.tokens) ?? {};
      const idToken = readOptionalString(tokens.id_token);
      const accessToken = readOptionalString(tokens.access_token);

      if (idToken || accessToken) {
        return {
          authenticated: true,
          email: idToken ? this.readEmailFromIdToken(idToken) : 'Authenticated',
          method: 'credentials_file',
        };
      }

      if (readOptionalString(auth.OPENAI_API_KEY)) {
        return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
      }

      return { authenticated: false, email: null, method: null, error: 'No valid tokens found' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        authenticated: false,
        email: null,
        method: null,
        error: code === 'ENOENT' ? 'Codex not configured' : error instanceof Error ? error.message : 'Failed to read Codex auth',
      };
    }
  }

  /**
   * Extracts the user email from a Codex id_token when a readable JWT payload exists.
   */
  private readEmailFromIdToken(idToken: string): string {
    try {
      const parts = idToken.split('.');
      if (parts.length >= 2) {
        const payload = readObjectRecord(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
        return readOptionalString(payload?.email) ?? readOptionalString(payload?.user) ?? 'Authenticated';
      }
    } catch {
      // Fall back to a generic authenticated marker if the token payload is not readable.
    }

    return 'Authenticated';
  }
}
