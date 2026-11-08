# mintcli

A customized, self-hosted coding workspace for managing coding agents, accounts, and conversations in one browser interface.

Based on [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui), with upstream **v1.37.6** merged while preserving the integrations in this repository. The original project documentation is available in [README.upstream.md](README.upstream.md).

mintcli is maintained independently. Upstream release polling and application update execution are disabled, including the system API and CLI update command. The interface has no upstream GitHub Star badge, issue-report link, or community link.

## Android app

An Android client and native phone tools are available in [mobile/android](mobile/android/README.md). The app connects to an existing mintcli workspace and also edits authorized phone files, inspects process memory, and manages system settings using the permissions available on the device. Networking uses the phone's existing connection, including an independently configured Clash VPN; no proxy nodes or subscription are bundled.

## What this version adds

- **Unified account management:** Add, authorize, and switch Codex and Claude accounts, native Cursor and OpenCode identities, Antigravity identities, and third-party API connections from the chat workspace.
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
git clone https://github.com/BloodYi/mintcli.git
cd mintcli
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

## Check and update provider CLIs

Open **Settings → Agents → select a provider → Account** (设置 → 智能体 → 选择引擎 → 账户). Each of the five providers has **Check for updates / 检查更新** and **Update now / 立即更新** controls. Checks query npm for Codex, Claude and OpenCode, the official Cursor installer, and the Antigravity release manifest. A manual check bypasses the version cache; failed lookups are shown as unavailable.

Enable private managed installations on Linux or macOS before using the updater:

```bash
export MINTCLI_MANAGED_CLIS=1
export MINTCLI_CLI_ROOT="$HOME/.mintcli/cli"
export PATH="$MINTCLI_CLI_ROOT/bin:$PATH"
npm run cli:install
npm run server
```

Keep these variables in the server service environment. Updates install into a new provider-specific directory, validate the executable, then atomically switch its symlink. Previous releases stay available for recovery. Global npm packages and other projects are untouched. The CLI used by Codex chat, status, forks and the model catalog follows the same managed installation. Busy providers refuse updates; repeat requests share the running job and the interface recovers its result after navigation. For a systemd deployment with a small gateway memory limit, set `MINTCLI_CLI_SYSTEMD=1` to run installers in temporary units with their own memory and time limits.

For Antigravity, start the private bridge with its own executable, HOME, account copies, conversation data and loopback port as described in its README, and configure `ANTIGRAVITY_WEB_URL` / `ANTIGRAVITY_ENV_FILE`. Do not attach managed updates to a different project's shared native service.

Verified releases on 2026-11-04: Codex **0.166.0**, Claude Code **2.1.318**, OpenCode **1.19.5**, Cursor **2026.10.22-27dcf5f**, Antigravity **1.5.0**. The updater fetches the latest release each time; this list is a dated record.

## Add an account through official authorization

In **Manage Accounts → Add account / API** (管理账号 → 添加账号 / API), choose the CLI and click **Open official authorization / Add account** (打开官方授权 / 添加账号). The official page opens directly; the same link stays visible in the dialog if the browser blocks a popup. A preliminary manual save is no longer required.

- **Codex:** Complete ChatGPT browser authorization, then paste the returned code or the full localhost callback address into the dialog if the browser cannot reach the server's callback. The server validates the state and forwards it only to the CLI's fixed loopback callback. Device-code login is also available.
- **Claude:** Paste the code returned by the official Claude page into the dialog.
- **agy:** Complete Google OAuth and paste the returned authorization code. The CLI runs in a fresh private home; only after success is the new account imported without switching the selected account.
- **Cursor:** Confirm the official browser login; the CLI completes automatically.
- **OpenCode:** The quick flow uses its native ChatGPT device authorization. Other providers remain available through the embedded native login terminal.

Cursor and OpenCode retain their CLI-owned current identity rather than introducing a separate multi-profile account store. Existing account selection stays unchanged when a new isolated Codex, Claude or agy account is added. Cancelled or failed attempts never count an old credential as a new successful login. Access and refresh tokens remain on the server; only authorization links, one-time codes and status are returned to the browser.

## Cursor and OpenCode login

Open **Manage Accounts** in the chat workspace and choose Cursor or OpenCode. Official login runs in an embedded terminal inside that same dialog; the previous Settings and onboarding login controls are replaced by the common account manager. These integrations use the native CLI-owned identity rather than copying credentials into a Codex profile.

Install the relevant native CLI on your host and ensure `cursor-agent` and `opencode` are on the server PATH. Cursor uses `cursor-agent login`; OpenCode uses `opencode auth login`. Status can be refreshed after authorization. No login command starts simply because you browse the account manager.

When the native login does not expose a readable remaining-quota response, mintcli displays an explicit unavailable state and links to the provider's official usage console. It does not infer a balance from session token counts.

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

Antigravity support uses a separately running compatible backend. A source snapshot for a private bridge is included in [native/antigravity-bridge](native/antigravity-bridge/README.md); credentials and account data remain local. Antigravity MCP and skill configuration remain managed by its native backend.

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

## CI workflow archive

The original GitHub Actions definitions are preserved in [docs/upstream-workflows](docs/upstream-workflows). They are archived rather than activated for this repository. To enable them, review their publishing and secret requirements, then move the desired files into `.github/workflows/` using a GitHub credential with workflow permissions.

## Upstream and license

This is a customized distribution of CloudCLI UI, originally developed by Siteboon AI B.V. and contributors. It is not an official upstream release.

The upstream Git history, attribution, [NOTICE](NOTICE), and [AGPL-3.0-or-later license](LICENSE) are preserved. See [CONTRIBUTING.md](CONTRIBUTING.md) and the upstream documentation for the original project's contribution and deployment guidance.
