import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import AccountContent from '@/modules/settings/tabs/agents-settings/sections/content/AccountContent';
import { api } from '@/shared/api';
vi.mock('@/shared/api', () => ({ api: { providers: { cliStatus: () => new Promise<Response>(() => {}) }, codexConnections: { list: vi.fn(), select: vi.fn() } } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
it('Codex settings keeps account switching in the unified chat account manager', () => {
  render(<AccountContent agent="codex" authStatus={{ email: null, method: null, authenticated: false, loading: false, error: 'Codex not configured' }} onLogin={vi.fn()} />);
  expect(screen.getByText('统一账号管理')).toBeTruthy();
  expect(screen.getByText(/管理账号/)).toBeTruthy();
  expect(screen.queryByText('Codex not configured')).toBeNull();
  expect(api.codexConnections.list).not.toHaveBeenCalled();
  expect(api.codexConnections.select).not.toHaveBeenCalled();
});
