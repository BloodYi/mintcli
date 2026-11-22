import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import '@/modules/i18n';
import AgentsSettingsTab from '@/modules/settings/tabs/agents-settings/AgentsSettingsTab';
import { api } from '@/shared/api';

const views = vi.hoisted(() => ({ mcp: vi.fn(), skills: vi.fn() }));
vi.mock('@/modules/mcp', () => ({ McpServers: (props: unknown) => { views.mcp(props); return <div>CLI MCP editor</div>; } }));
vi.mock('@/modules/skills', () => ({ ProviderSkills: (props: unknown) => { views.skills(props); return <div>CLI skills editor</div>; } }));
vi.mock('@/shared/api', async original => ({ ...await original<Record<string, unknown>>(), api: { providers: { cliStatus: vi.fn(() => new Promise<Response>(() => {})) } } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const loggedOut = { authenticated: false, email: null, method: null, error: null, loading: false };
const renderSettings = () => render(<AgentsSettingsTab
  providerAuthStatus={{ claude: loggedOut, cursor: loggedOut, codex: loggedOut, opencode: loggedOut, antigravity: { ...loggedOut, authenticated: true, email: 'agy@example.test' } }}
  onProviderLogin={vi.fn()}
  claudePermissions={{ skipPermissions: false, allowedTools: [], disallowedTools: [] }}
  onClaudePermissionsChange={vi.fn()}
  cursorPermissions={{ skipPermissions: false, allowedCommands: [], disallowedCommands: [] }}
  onCursorPermissionsChange={vi.fn()}
  codexPermissionMode="default" onCodexPermissionModeChange={vi.fn()} projects={[]}
/>);

it('Antigravity appears alongside all CLI providers and uses its native connection status with a CLI version row', async () => {
  renderSettings();
  for (const name of ['Claude', 'Cursor', 'Codex', 'OpenCode', 'Antigravity']) expect(screen.getByRole('button', { name })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Antigravity' }));
  expect(screen.getByRole('button', { name: 'Antigravity' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByText('已连接 · agy@example.test')).toBeTruthy();
  expect(screen.getByText(/在上方“管理账号”中添加、登录和切换 Antigravity 账号/)).toBeTruthy();
  expect(screen.getByTestId('provider-cli-version')).toBeTruthy();
  expect(api.providers.cliStatus).toHaveBeenCalledWith('antigravity', false);
  expect(screen.getAllByRole('tab')).toHaveLength(1);
});

it('switching from a CLI settings editor to Antigravity never mounts unsupported native editors', async () => {
  renderSettings();
  fireEvent.click(screen.getByRole('tab', { name: /MCP/ }));
  expect(screen.getByText('CLI MCP editor')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Antigravity' }));
  await waitFor(() => expect(screen.getByText('统一账号管理')).toBeTruthy());
  expect(screen.queryByText('CLI MCP editor')).toBeNull();
  expect(views.mcp.mock.calls.some(([props]) => props.selectedProvider === 'antigravity')).toBe(false);
  expect(views.skills.mock.calls.some(([props]) => props.selectedProvider === 'antigravity')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Cursor' }));
  expect(screen.getByRole('tab', { name: /MCP/ })).toBeTruthy();
});
