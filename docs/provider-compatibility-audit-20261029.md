# Provider compatibility audit — 2026-10-29

The installed CLIs, upstream release sources, model endpoints, transcript storage and UI adapters were checked on the deployment host. Successful model listing alone is not an inference entitlement check, and compatibility with an installed version does not guarantee compatibility with future releases.

## Findings

| Provider | Installed | Official release checked | Models and native files | Update behavior |
| --- | --- | --- | --- | --- |
| Codex | CLI and SDK 0.160.1 | CLI and SDK 0.165.0 on npm | Account-scoped live catalog returned HTTP 200. All three saved connection homes share the native sessions directory. Native transcript adapters and filesystem watcher are covered by regression tests. | CLI and SDK are application dependencies. Their versions must be upgraded together and checked before activation. The version endpoint now checks the official registry even for bundled installations. |
| Claude | Agent SDK 0.3.165, bundled native CLI 2.1.165 | SDK 0.3.312, CLI 2.1.312 on npm | The current model picker uses predefined CLI aliases; it does not dynamically discover new model IDs. Native JSONL histories use the shared projects directory. This installation has no authorized Claude subscription profile, so authenticated inference was not verified. | Fixed a missing-PATH-command problem: runtime and version probes can now resolve the actual SDK binary. SDK-managed binaries are reported as bundled and cannot run a standalone updater that would desynchronize them from their SDK. An explicitly configured standalone CLI retains its native updater. |
| Antigravity | CLI 1.4.10 | Linux amd64 official manifest 1.4.10 | All 13 advertised models returned nonempty text without CLI errors. The bridge reads the native backend's models and conversation/message APIs; its transport regression tests pass. | CLI is managed by the separate native service and the official `agy update` command. The web wrapper's GitHub updater updates the wrapper source, not the Google CLI. |

The Claude account wrapper deliberately disables automatic user/project/local `settings.json` loading (`settingSources: []`) to keep saved subscription credentials from being overridden by environment or project authorization settings. Thus this deployment cannot claim to synchronize every official Claude settings file. Native Antigravity MCP and skills remain managed by its native backend.

## Antigravity inference evidence

Each advertised model was tested with a fresh temporary workspace and the prompt “Reply only with OK. Do not use tools or access files.” Existing user conversations were not continued. All 13 returned `OK`.

| Requested model(s) | Observed upstream response model |
| --- | --- |
| gemini-4-argon-medium, gemini-4-argon-low | gemini-4-argon-trial |
| gemini-4-argon-high | gemini-4-argon-s |
| gemini-3.8-flash-low, medium, high | gemini-3.8-flash-n |
| claude-opus-5-5-low, medium, high | Exact corresponding requested ID |
| claude-sonnet-5-5-low, medium, high | Exact corresponding requested ID |
| gpt-oss-120b-medium | gpt-oss-120b-medium |

The Gemini response IDs above are the names observed in upstream response metadata. They are not replaced with picker labels, and this check does not establish a one-to-one relationship between a display label and an internal backend model.

## Conversation pins

The sidebar's project rows, recent-conversation rows and mobile menu now offer pin/unpin. Pins are stored in the authenticated user's preferences. Recent and per-project SQL queries rank pins before pagination, preserving old pinned conversations on the first page. Archived sessions and archived projects retain their visibility rules. Pinning does not change a conversation's activity timestamp. Save failures retain the prior state, and changes from different rows are serialized.

## Verification

- TypeScript checks passed for the frontend and backend.
- Full frontend regression: 133 files, 909 tests passed.
- Focused backend version, transcript, bridge and watcher regression: 67 tests passed.
- Additional database/preferences/project regression: 64 tests passed; this overlaps some tests in the preceding run.
- Final sidebar/settings/preference regression: 95 tests passed.
- An isolated preview database verified old pins before global and project pagination, separate users' pin state, and the corrected live CLI version endpoints.
- Chromium at 1280px and 390px verified pin, unpin, ordering, persistence after reload, and no page errors.
- Lint could not complete: the installed oxlint binary aborted in `oxc_allocator` with exit 134. Earlier deployment logs record the same allocator crash before these changes.

## Official references

- [OpenAI App Server](https://learn.chatgpt.com/docs/app-server)
- [OpenAI model catalog and inference verification](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Claude Code installation and updates](https://code.claude.com/docs/en/setup)
- [Claude Code settings files](https://code.claude.com/docs/en/settings)
- [Antigravity CLI changelog and updater](https://antigravity.google/docs/cli/commands/changelog)
- [Official Antigravity installer](https://antigravity.google/cli/install.sh)
- [Official Antigravity Linux amd64 release manifest](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json)
- [Published Codex release metadata](https://registry.npmjs.org/@openai%2Fcodex/latest)
- [Published Claude Agent SDK release metadata](https://registry.npmjs.org/@anthropic-ai%2Fclaude-agent-sdk/latest)

Private diagnostic artifacts are stored on the host under `/home/ubuntu/cloudcli-pin-audit-20261029/`, outside the repository. They include the dated release manifests, per-model route evidence, test logs and deployment status. Credentials are excluded from the report and source changes.
