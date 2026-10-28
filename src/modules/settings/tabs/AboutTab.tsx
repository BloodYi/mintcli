import { APP_VERSION } from '@/shared/constants';

/** Used by Settings to identify the customized mintcli distribution and its license. */
export default function AboutTab() {
  return <div className="space-y-4">
    <h2 className="text-xl font-semibold">mintcli <span className="text-sm text-muted-foreground">v{APP_VERSION}</span></h2>
    <p className="text-sm text-muted-foreground">Codex、Claude、Cursor、OpenCode、Antigravity 与第三方 API 的统一工作台。</p>
    <p className="text-sm text-muted-foreground">此版本由你自行维护，已关闭上游更新检查和自动更新。</p>
    <p className="text-xs text-muted-foreground">Based on CloudCLI UI by Siteboon AI B.V. and contributors. Licensed under AGPL-3.0-or-later.</p>
  </div>;
}
