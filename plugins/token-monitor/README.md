# Token Monitor · mintcli adapter

This is a mintcli integration using the MIT-licensed session detail parser from [Javis603/token-monitor](https://github.com/Javis603/token-monitor), not the upstream Electron application. The pinned upstream version and commit are recorded in `vendor/provenance.json`; `vendor/LICENSE` retains its license.

Open **真实返回** beside the model picker, **监控窗口** at the far right of the account quota row, or the Token Monitor plugin tab. The quota row's **收起 / 展开** preference survives reloads. The inspector shows the latest response-reported model, reply text, selected numeric response fields, session/recent token totals, and individual usage snapshots. A configured `turn_context.model` never counts as a response-reported model. Native Codex runs now relay Responses over a per-turn loopback listener and capture the HTTP response `model`, response ID, output item IDs and timestamps in app-session metadata. The relay passes response content through and preserves request authentication; it stores no prompts, headers, tool payloads or reasoning. ChatGPT and third-party Responses connections use this path; Chat Completions retains its existing native response records. Historical sessions without captured response metadata and APIs omitting `model` display **未报告**. Send a new message after updating to capture its reported model. No backend identity attestation is implied by a provider's model label.

The adapter currently reads indexed Codex and Claude JSONL sessions. Other providers report that the source is unavailable rather than inventing model or usage values. Chat Completions requests ask for streamed usage and retain the response model/usage in native records. Cache input is disjoint from uncached input; reasoning is a subset of output and never added twice. Claude response blocks and replayed lines count once using the upstream parser.

The inspector reads at most the most recent 4 MiB, displays 30 replies and 60 usage entries, and marks partial coverage. The latest native cumulative Codex snapshot is preferred for session totals; Claude totals cover the available tail. Reply previews cap each reply at 100,000 characters. The inspector projects text, model and numeric usage; it does not expose HTTP headers, credentials, tools or reasoning bodies. It refreshes serially every 3 seconds while open and every 15 seconds in the background, cancelling stale requests when changing sessions. It uses the same authenticated session access as the workbench.

Interface/read failures and missing usage produce in-app reminders. Latest upstream releases are checked on the server at most every 6 hours; failed checks retry after 5 minutes and are distinguished from “up to date.” The browser checks that cached status every 5 minutes. An update notice links to upstream releases; code updates require rebuilding and validating this adapter, since upstream's desktop app cannot be pulled directly into mintcli.

To regenerate the pinned parser, clone the upstream repository at the desired revision, then run from the mintcli root:

```sh
node --input-type=module -e 'import { build } from "esbuild"; await build({ entryPoints: [process.argv[1]], outfile: "plugins/token-monitor/vendor/session-detail.cjs", bundle: true, platform: "node", format: "cjs", packages: "external", minify: true });' /path/to/token-monitor/src/shared/sessionDetail.js
```

Update `vendor/provenance.json`, retain the upstream license, and run the monitor/compatible-chat tests plus the client/type/build checks before deploying. Install the manifest and entry in the runtime user's `~/.claude-code-ui/plugins/token-monitor/` directory; the packaged server also needs `plugins/token-monitor/vendor/` at the app root.
