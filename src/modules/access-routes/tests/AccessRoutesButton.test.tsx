import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { AccessRoutesButton } from '@/modules/access-routes/AccessRoutesButton';
import { api } from '@/shared/api';

vi.mock('@/shared/api', () => ({ api: { accessRoutes: { status: vi.fn() }, egress: { select: vi.fn() } }, readApiJson: async (response: Response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error); return data; } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('loads website entrances on demand and keeps API selection untouched', async () => {
  vi.mocked(api.accessRoutes.status).mockResolvedValue(Response.json({ defaultId: 'de9929', routes: [{ id: 'de9929', name: '德国9929', origin: 'https://codex.example.com' }, { id: 'direct', name: '法兰克福直连', origin: 'https://direct.example.com' }] }));
  render(<AccessRoutesButton />); expect(api.accessRoutes.status).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '网站访问线路' }));
  const first = await screen.findByRole('link', { name: /德国9929/ });
  expect(first.getAttribute('href')).toMatch(/^https:\/\/codex\.example\.com\//);
  expect(screen.getByRole('link', { name: /法兰克福直连/ }).getAttribute('href')).toMatch(/^https:\/\/direct\.example\.com\//);
  expect(api.egress.select).not.toHaveBeenCalled();
});
it('shows a readable error without a fabricated entrance', async () => {
  vi.mocked(api.accessRoutes.status).mockResolvedValue(Response.json({ error: '线路暂不可用' }, { status: 503 }));
  render(<AccessRoutesButton />); fireEvent.click(screen.getByRole('button', { name: '网站访问线路' }));
  expect((await screen.findByRole('alert')).textContent).toContain('线路暂不可用'); expect(screen.queryByRole('link')).toBeNull();
});
