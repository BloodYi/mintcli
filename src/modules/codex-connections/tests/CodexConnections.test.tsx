import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexConnections } from '@/modules/codex-connections';
import { api } from '@/shared/api';

vi.mock('@/shared/api', () => ({ api: { codexConnections: { list: vi.fn(), select: vi.fn(), save: vi.fn(), models: vi.fn(), quota: vi.fn() } } }));
const catalog = { activeId: 'business', connections: [
  { id: 'business', name: 'Business', kind: 'chatgpt', authorized: true, baseUrl: '', protocol: 'responses', model: '' },
  { id: 'api', name: 'Third Party', kind: 'api', authorized: true, baseUrl: 'https://example.com/v1', protocol: 'chat_completions', model: 'api-model', hasApiKey: true },
] };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.codexConnections.quota).mockImplementation(async id => response({ connectionId: id, status: 'unavailable', windows: [] }));
  vi.mocked(api.codexConnections.list).mockImplementation(async () => response(catalog));
});
afterEach(cleanup);

describe('native Codex account and API management', () => {
  it('selects the server connection and notifies the native composer without retaining keys', async () => {
    const changed = vi.fn();
    vi.mocked(api.codexConnections.select).mockImplementation(async () => response({ ...catalog, activeId: 'api' }));
    render(<CodexConnections disabled={false} onConnectionChange={changed} />);
    const select = await screen.findByLabelText('Codex 账号 / API');
    await screen.findByRole('option', { name: 'ChatGPT · Business' });
    fireEvent.change(select, { target: { value: 'api' } });
    await screen.findByText('API 聊天 · api-model');
    expect(api.codexConnections.select).toHaveBeenCalledWith('api');
    expect(changed).toHaveBeenLastCalledWith({ id: 'api', kind: 'api', model: 'api-model' });
  });

  it('preserves a saved key with a blank field and renders provider errors in the same dialog', async () => {
    vi.mocked(api.codexConnections.save).mockImplementation(async () => response(catalog.connections[1]));
    vi.mocked(api.codexConnections.models).mockImplementation(async () => response({ error: { message: '模型接口返回 HTTP 401' } }, 400));
    render(<CodexConnections disabled={false} onConnectionChange={() => {}} />);
    await screen.findByRole('option', { name: 'API · Third Party' });
    fireEvent.click(screen.getByRole('button', { name: '管理' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Third Party' }));
    expect((within(dialog).getByLabelText('API Key') as HTMLInputElement).value).toBe('');
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await within(dialog).findByText('已保存到服务器，手机与 PC 共用此配置');
    expect(api.codexConnections.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'api', apiKey: '', model: 'api-model' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '拉取模型' }));
    await within(dialog).findByText('模型接口返回 HTTP 401');
  });
});
