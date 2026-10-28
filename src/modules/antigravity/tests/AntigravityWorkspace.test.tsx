import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AntigravityWorkspace } from '@/modules/antigravity/AntigravityWorkspace';
import { useAntigravity } from '@/modules/antigravity/hooks/useAntigravity';

vi.mock('@/modules/antigravity/hooks/useAntigravity', () => ({ useAntigravity: vi.fn() }));
afterEach(cleanup);
const fixture = () => ({
  accounts: [{ id: 'a', email: 'a@example.com', name: '账号 A', active: true }, { id: 'b', email: 'b@example.com', name: '账号 B', active: false }],
  models: [{ id: 'native-model', name: '原生模型' }], conversations: [], messages: [],
  quota: { email: 'a@example.com', timestamp: 1, quotas: [{ model: 'Gemini', type: 'weekly', label: '周额度', percentage: 73, resets_at: 'tomorrow' }] },
  conversationId: null, busy: false, loading: false, notice: '', quotaLoading: false,
  setNotice: vi.fn(), send: vi.fn(), openConversation: vi.fn(), reloadAccounts: vi.fn(),
  refreshQuota: vi.fn(), switchAccount: vi.fn().mockResolvedValue(undefined), newConversation: vi.fn(), sync: vi.fn(), stop: vi.fn(),
});
beforeEach(() => vi.mocked(useAntigravity).mockReturnValue(fixture()));

describe('native Antigravity workspace', () => {
  it('shows the current account and its native quota, then switches the account selected by the user', async () => {
    const value = fixture(); vi.mocked(useAntigravity).mockReturnValue(value);
    render(<AntigravityWorkspace />);
    expect(screen.getByText('Gemini · 每周 · 73%')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('agy 账号'), { target: { value: 'b' } });
    expect(value.switchAccount).toHaveBeenCalledWith('b');
  });
  it('does not show another account quota and prevents switching while a native turn is running', () => {
    const value = fixture(); value.busy = true; value.quota.email = 'b@example.com';
    vi.mocked(useAntigravity).mockReturnValue(value);
    render(<AntigravityWorkspace />);
    expect(screen.queryByText('Gemini · 每周 · 73%')).toBeNull();
    expect((screen.getByLabelText('agy 账号') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText('停止生成')).toBeTruthy();
  });
});
