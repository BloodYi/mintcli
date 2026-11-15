import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, expect, test, vi } from 'vitest';

import type { Project, SidebarProjectListProps } from '@/shared/types';
import SidebarContent from '@/modules/sidebar/SidebarContent';
import { useSidebarController } from '@/modules/sidebar/hooks/useSidebarController';

vi.mock('@/shared/api', () => ({ api: {
  searchConversationsUrl: (query: string) => `/search?q=${encodeURIComponent(query)}`,
  recentConversations: async () => ({ ok: true, json: async () => ({ data: { conversations: [] } }) }),
  archivedProjects: async () => ({ ok: true, json: async () => ({ data: { projects: [] } }) }),
  getArchivedSessions: async () => ({ ok: true, json: async () => ({ data: { sessions: [] } }) }),
} }));
vi.mock('@/modules/sidebar/SidebarFooter', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarProjectList', () => ({
  default: ({ filteredProjects }: SidebarProjectListProps) => <div>{filteredProjects.map(project => (
    <span key={project.projectId}>Project: {project.displayName}</span>
  ))}</div>,
}));

class SearchStream extends EventTarget {
  static streams: SearchStream[] = [];
  closed = false;
  constructor(readonly url: string) { super(); SearchStream.streams.push(this); }
  close() { this.closed = true; }
  send(event: string, data: unknown = {}) {
    this.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) }));
  }
}

const project: Project = { projectId: 'project-1', displayName: 'repo', path: '/repo', fullPath: '/repo',
  isStarred: false, sessions: [], sessionMeta: { hasMore: false, total: 0 } };
const projects = [project];
const inactiveSessions = new Set<string>();
const labels: Record<string, string> = { 'search.allPlaceholder': 'Search projects and conversations',
  'search.modeProjects': 'Projects', 'search.modeConversations': 'Conversations',
  'search.searching': 'Searching', 'search.noResults': 'No results', 'tooltips.clearSearch': 'Clear search' };
const t = ((key: string, fallback?: unknown) => labels[key] ?? (typeof fallback === 'string' ? fallback : key)) as TFunction;
const openResult = vi.fn();
const noop = () => {};

function SidebarSearch() {
  const controller = useSidebarController({ projects, selectedProject: null, selectedSession: null,
    activeSessions: inactiveSessions, backgroundSessionIds: inactiveSessions, isLoading: false, isMobile: false, t,
    onRefresh: noop, onProjectSelect: noop, onSessionSelect: noop, setCurrentProject: noop,
    setSidebarVisible: noop, sidebarVisible: true });
  return <SidebarContent {...controller} isPWA={false} isMobile={false} isLoading={false} projects={projects}
    onSearchFilterChange={controller.setSearchFilter} onClearSearchFilter={() => controller.setSearchFilter('')}
    onSearchModeChange={controller.setSearchMode} onConversationResultClick={openResult}
    onLoadMoreRecentConversations={noop} onRetryRecentConversations={noop}
    onArchivedSessionClick={noop} onRestoreArchivedProject={noop} onRestoreArchivedSession={noop}
    onDeleteArchivedSession={noop} onRefresh={noop} onCreateProject={noop} onCollapseSidebar={noop}
    updateAvailable={false} restartRequired={false} releaseInfo={null} latestVersion={null} currentVersion="test"
    onShowVersionModal={noop} onShowSettings={noop} t={t}
    projectListProps={{ filteredProjects: controller.filteredProjects, currentTime: new Date(), activeRename: null } as SidebarProjectListProps}
  />;
}

function sendMatch(stream: SearchStream, snippet: string) {
  stream.send('result', { projectResult: { projectId: 'project-1', projectName: '/repo', projectDisplayName: 'repo',
    sessions: [{ sessionId: 'old-chat', provider: 'codex', sessionSummary: 'Unrelated title',
      matches: [{ role: 'assistant', snippet, highlights: [], timestamp: '2026-11-14T06:00:00Z' }] }] },
  totalMatches: 1, scannedProjects: 1, totalProjects: 1 });
  stream.send('done');
}

beforeEach(() => {
  localStorage.clear();
  openResult.mockReset();
  SearchStream.streams = [];
  vi.stubGlobal('EventSource', SearchStream);
});

test('the default Projects search finds message content with a single Chinese character and opens the hit', async () => {
  render(<SidebarSearch />);
  fireEvent.change(screen.getAllByPlaceholderText('Search projects and conversations')[0], { target: { value: '偷' } });
  expect(screen.getByText('Searching')).toBeTruthy();
  await waitFor(() => expect(SearchStream.streams).toHaveLength(1));
  const stream = SearchStream.streams[0];
  expect(decodeURIComponent(stream.url)).toContain('q=偷');
  act(() => sendMatch(stream, '以前在这里讨论过偷跑的问题'));
  fireEvent.click(screen.getByText('Unrelated title'));
  expect(openResult).toHaveBeenCalledWith('project-1', 'old-chat', 'codex', '2026-11-14T06:00:00Z', '以前在这里讨论过偷跑的问题');
  expect(screen.queryByText('No results')).toBeNull();
});

test('matching project names remain available alongside matching conversation content', async () => {
  render(<SidebarSearch />);
  fireEvent.change(screen.getAllByPlaceholderText('Search projects and conversations')[0], { target: { value: 'repo' } });
  await waitFor(() => expect(SearchStream.streams).toHaveLength(1));
  act(() => sendMatch(SearchStream.streams[0], 'the repo was discussed in an old conversation'));
  expect(screen.getByText('Project: repo')).toBeTruthy();
  expect(screen.getByText('the repo was discussed in an old conversation')).toBeTruthy();
});

test('changing and clearing the query closes old streams and removes stale matches', async () => {
  render(<SidebarSearch />);
  const input = screen.getAllByPlaceholderText('Search projects and conversations')[0];
  fireEvent.change(input, { target: { value: 'old' } });
  await waitFor(() => expect(SearchStream.streams).toHaveLength(1));
  const oldStream = SearchStream.streams[0];
  fireEvent.change(input, { target: { value: 'new' } });
  expect(oldStream.closed).toBe(true);
  act(() => sendMatch(oldStream, 'stale result'));
  expect(screen.queryByText('stale result')).toBeNull();
  await waitFor(() => expect(SearchStream.streams).toHaveLength(2));
  act(() => sendMatch(SearchStream.streams[1], 'new result'));
  expect(screen.getByText('new result')).toBeTruthy();
  fireEvent.change(input, { target: { value: '' } });
  expect(screen.queryByText('new result')).toBeNull();
  await waitFor(() => expect(screen.getByText('Project: repo')).toBeTruthy());
});
