# mintcli isolated Antigravity bridge

Snapshot of https://github.com/BloodYi/antigravity-chat at `c60bfd486a57cc136ce4090b75dd6598ea13c10a`, including the installed local fixes. The source is copied unchanged. License and attribution are retained in LICENSE and NOTICE.md.

Run this bridge on a separate loopback port with its own HOME, AGY_BIN, AGY_RUNTIME_HOME, AGY_CONVERSATIONS_FILE, AGY_MESSAGES_DIR, AGY_UPLOADS, AGY_SCRATCH and credentials file. Set AGY_WEB_UPDATE_ENABLED=0. Configure mintcli with ANTIGRAVITY_WEB_URL and ANTIGRAVITY_ENV_FILE for this private bridge.

On migration, copy accounts and conversation data once into the private directories before starting. Never share writable state with another project or point the CLI updater at its executable. CLI updates switch only the executable behind the private AGY_BIN symlink; the bridge keeps running.
