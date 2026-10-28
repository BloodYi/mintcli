# CloudCLI Unified

A customized, self-hosted CloudCLI workspace for managing coding agents, accounts, and conversations in one browser interface.

Based on [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui), with upstream **v1.37.6** merged while preserving the integrations in this repository. The original project documentation is available in [README.upstream.md](README.upstream.md).

## What this version adds

- **Unified account management:** Add, authorize, and switch Codex and Claude accounts, Antigravity identities, and third-party API connections from the chat workspace.
- **Account-aware model catalogs:** Load models for the selected account or API connection, with support for custom models and reasoning effort settings.
- **Provider quota views:** Inspect the usage windows and account limits exposed by each supported provider.
- **Native Antigravity integration:** Connect an existing local Antigravity web backend to the workspace, including conversations, account selection, attachments, streaming, and reconnect handling.
- **Isolated Claude profiles:** Keep authorization separate for each account while sharing conversation history.
- **Third-party API support:** Use compatible Responses and Chat Completions endpoints through saved connections.
- **Codex fast mode:** Control fast mode from the composer when supported by the selected account and model.
- **Video attachments:** Upload and preview video files alongside other chat attachments, with a general upload limit of 200 MB. Individual backends may enforce smaller limits.

The upstream workspace also provides a file explorer, code editing, Git tools, a terminal, session history, scheduled messages, and a plugin system. Existing Cursor CLI and OpenCode integrations are retained.

## Upstream v1.37.6 improvements

This version includes visible permission-mode names in the composer, CLI version information in Settings, optional project expansion persistence, Chinese Git translations, and fixes for queued follow-ups, session loading, background task indicators, and scheduled-message updates.

The customized Settings page keeps the unified account-manager entry while exposing the upstream CLI version controls.

## Run from source

Use Node.js 22 or newer and npm. Provider CLIs and accounts need their own authorization.

```bash
git clone https://github.com/BloodYi/cloudcli-unified.git
cd cloudcli-unified
npm install
npm run build
npm run server
```

Open `http://localhost:3001` and complete the initial setup. Use **Manage Accounts** in the chat workspace to configure your provider accounts and API connections.

On machines with limited RAM, the frontend build can need a larger Node heap and sufficient available memory or swap:

```bash
NODE_OPTIONS=--max-old-space-size=3072 npm run build
```

For development:

```bash
npm run dev
```

Installing the upstream npm package does not install the customizations in this repository; build this source tree to use them.

## Configuration

See [.env.example](.env.example) for the upstream server settings. The custom integrations also recognize these environment variables:

| Variable | Purpose |
| --- | --- |
| `CODEX_CONNECTIONS_ROOT` | Directory for saved Codex accounts and API connection profiles. Defaults to `connections` under the server user's home directory. |
| `CLAUDE_ACCOUNTS_ROOT` | Directory for isolated Claude account profiles. Defaults to `unified/claude` under the server user's home directory. |
| `CLAUDE_CLI_PATH` | Optional path to the native Claude executable. |
| `ANTIGRAVITY_WEB_URL` | Origin of the separately running local Antigravity web backend. Defaults to `http://127.0.0.1:3121`. Only loopback HTTP origins are accepted. |
| `ANTIGRAVITY_ENV_FILE` | Path to the existing Antigravity environment file containing `BASIC_AUTH_USER` and `BASIC_AUTH_PASS`. Set this explicitly for your installation. |
| `AGY_DEFAULT_PROJECT` | Default workspace for imported Antigravity conversations. Set this to your own project directory. |

Antigravity support is an adapter for a separately running compatible backend. That backend, its credentials, and its account data are not bundled here. Antigravity MCP and skill configuration remain managed by its native backend.

Saved credentials, account profiles, databases, conversation files, local proxy configuration, and deployment backups are runtime data and are not part of this repository.

## Validation

The v1.37.6 integration was checked with TypeScript, a production build, all **899 frontend tests**, backend regression tests, and a preview instance using a database copy. Backend tests were adapted to include the additional provider and to avoid requiring live account authorization in route tests.

```bash
npm run typecheck
NODE_ENV=test npm run test:client -- --maxWorkers=1 --minWorkers=1
npm test
npm run build
npm run lint
```

The installed oxlint binary crashed in its allocator on the deployment host, including before this upgrade. Lint did not complete on that host.

## Upstream and license

This is a customized distribution of CloudCLI UI, originally developed by Siteboon AI B.V. and contributors. It is not an official upstream release.

The upstream Git history, attribution, [NOTICE](NOTICE), and [AGPL-3.0-or-later license](LICENSE) are preserved. See [CONTRIBUTING.md](CONTRIBUTING.md) and the upstream documentation for the original project's contribution and deployment guidance.
