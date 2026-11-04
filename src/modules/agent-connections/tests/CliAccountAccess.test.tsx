import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CliAccountAccess } from '@/modules/agent-connections/CliAccountAccess';
import { api } from '@/shared/api';

vi.mock('@/shared/api', () => ({ api: { providers: { authStatus: vi.fn() } }, readApiJson: (response: Response) => response.json() }));
vi.mock('@/modules/standalone-shell', () => ({ StandaloneShell: ({ command, onComplete }: { command: string; onComplete: () => void }) => <button onClick={onComplete}>terminal: {command}</button> }));
afterEach(cleanup);

it.each([['cursor', 'cursor-agent login'], ['opencode', 'opencode auth login']] as const)('%s logs in within the common account dialog and refreshes it', async (provider, command) => {
  const onChanged = vi.fn(async () => {});
  vi.mocked(api.providers.authStatus).mockImplementation(async () => Response.json({ data: { installed: true, authenticated: false, email: null } }));
  render(<CliAccountAccess provider={provider} disabled={false} onChanged={onChanged} />);
  await screen.findByText('未登录');
  expect(screen.queryByText(`terminal: ${command}`)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '使用原生登录终端（其他方式）' }));
  vi.mocked(api.providers.authStatus).mockImplementation(async () => Response.json({ data: { installed: true, authenticated: true, email: 'fixture@example.test' } }));
  fireEvent.click(await screen.findByRole('button', { name: `terminal: ${command}` }));
  await screen.findByText('已登录 · fixture@example.test');
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(api.providers.authStatus).toHaveBeenCalledWith(provider);
});
