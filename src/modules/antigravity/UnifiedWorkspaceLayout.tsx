import { NavLink, Outlet } from 'react-router-dom';

/** Used by App to keep both native agent workspaces under the existing website login. */
export function UnifiedWorkspaceLayout() {
  return <>
    <nav aria-label="选择编程工作台" className="fixed inset-x-0 top-0 z-40 flex h-12 items-center gap-2 overflow-x-auto border-b border-border bg-background px-3 text-sm">
      <span className="mr-1 hidden shrink-0 font-semibold sm:inline">Mint 工作台</span>
      <NavLink to="/" className={({ isActive }) => 'shrink-0 rounded-md px-3 py-2 ' + (isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>Codex / Claude / API</NavLink>
      <NavLink to="/antigravity" className={({ isActive }) => 'shrink-0 rounded-md px-3 py-2 ' + (isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>Antigravity · agy</NavLink>
    </nav>
    <Outlet />
  </>;
}
