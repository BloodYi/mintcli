import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiModelPicker } from '@/modules/agent-connections/ApiModelPicker';
import { api } from '@/shared/api';

vi.mock('@/shared/api', async importOriginal => {
  const original = await importOriginal<typeof import('@/shared/api')>();
  return { ...original, api: { codexConnections: { discoverModels: vi.fn() } } };
});
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

function Picker({ accountId = '', baseUrl = 'https://example.com/v1', apiKey = 'new-private-key' }: { accountId?: string; baseUrl?: string; apiKey?: string }) {
  // Mirror the parent form so selecting and manually editing exercise the same value.
  const [value, setValue] = useState('existing-manual');
  return <ApiModelPicker accountId={accountId} baseUrl={baseUrl} apiKey={apiKey} value={value} disabled={false} onChange={setValue} />;
}

it('previews a new API without saving and lets a fetched model or manual ID become the default', async () => {
  vi.mocked(api.codexConnections.discoverModels).mockResolvedValue(Response.json({ models: ['model-a', 'model-b'] }));
  render(<Picker />);
  fireEvent.click(screen.getByRole('button', { name: '拉取模型' }));
  await screen.findByRole('option', { name: 'model-b' });
  expect(api.codexConnections.discoverModels).toHaveBeenCalledWith({ id: undefined, baseUrl: 'https://example.com/v1', apiKey: 'new-private-key' }, expect.any(AbortSignal));
  expect((screen.getByLabelText('默认模型') as HTMLInputElement).value).toBe('existing-manual');
  fireEvent.change(screen.getByLabelText('选择已拉取模型'), { target: { value: 'model-b' } });
  expect((screen.getByLabelText('默认模型') as HTMLInputElement).value).toBe('model-b');
  fireEvent.change(screen.getByLabelText('默认模型'), { target: { value: 'my-custom-id' } });
  expect((screen.getByLabelText('默认模型') as HTMLInputElement).value).toBe('my-custom-id');
});

it('uses the saved account identity when its key is blank, prevents duplicate requests and ignores stale results after edits', async () => {
  let finish!: (response: Response) => void;
  vi.mocked(api.codexConnections.discoverModels).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { rerender, unmount } = render(<Picker accountId="saved" apiKey="" />);
  fireEvent.click(screen.getByRole('button', { name: '拉取模型' }));
  expect((screen.getByRole('button', { name: '拉取中…' }) as HTMLButtonElement).disabled).toBe(true);
  const signal = vi.mocked(api.codexConnections.discoverModels).mock.calls[0][1]!;
  expect(api.codexConnections.discoverModels).toHaveBeenCalledWith({ id: 'saved', baseUrl: 'https://example.com/v1', apiKey: undefined }, signal);
  rerender(<Picker accountId="saved" baseUrl="https://other.example/v1" apiKey="" />);
  expect(signal.aborted).toBe(true);
  await act(async () => finish(Response.json({ models: ['stale-model'] })));
  expect(screen.queryByRole('option', { name: 'stale-model' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '拉取模型' }));
  const nextSignal = vi.mocked(api.codexConnections.discoverModels).mock.calls[1][1]!;
  unmount();
  expect(nextSignal.aborted).toBe(true);
});

it('shows HTTP errors and empty catalogs while preserving a manually entered model for saving', async () => {
  vi.mocked(api.codexConnections.discoverModels).mockResolvedValueOnce(Response.json({ success: false, error: { message: '模型接口返回 HTTP 401，请检查密钥' } }, { status: 502 }))
    .mockResolvedValueOnce(Response.json({ models: [] }));
  render(<Picker />);
  fireEvent.click(screen.getByRole('button', { name: '拉取模型' }));
  expect((await screen.findByRole('alert')).textContent).toContain('HTTP 401');
  expect((screen.getByLabelText('默认模型') as HTMLInputElement).value).toBe('existing-manual');
  fireEvent.click(screen.getByRole('button', { name: '拉取模型' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('列表为空'));
  expect((screen.getByLabelText('默认模型') as HTMLInputElement).value).toBe('existing-manual');
});

it('requires an address and a key for a new API before enabling discovery', () => {
  const { rerender } = render(<Picker apiKey="" />);
  expect((screen.getByRole('button', { name: '拉取模型' }) as HTMLButtonElement).disabled).toBe(true);
  rerender(<Picker accountId="saved" apiKey="" baseUrl="" />);
  expect((screen.getByRole('button', { name: '拉取模型' }) as HTMLButtonElement).disabled).toBe(true);
});
