import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import path from 'path';

import express, { type Request, type Response } from 'express';

import type { ProviderRunFunction } from '@/shared/types.js';
import { AppError, getGitErrorDetails } from '@/shared/utils.js';

// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import { parseGitLogWithStats, parseGitStatusOutput } from './git-parsing.service.js';
import { deleteLocalBranch } from './git-branch.service.js';
import { getBranchDiffForFile, listBranchDiffFiles } from './git-branch-diff.service.js';

type GitProcessResult = {
  stdout: string;
  stderr: string;
};

type GitSpawnedProcess = EventEmitter & {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill?: ChildProcess['kill'];
};

type GitRouterDependencies = {
  fileSystem: typeof import('node:fs/promises');
  spawnProcess: (
    command: string,
    args: string[],
    options?: SpawnOptions,
  ) => GitSpawnedProcess;
  resolveProjectPathById(projectId: string): string | null | Promise<string | null>;
  queryClaude: ProviderRunFunction;
  queryCursor: ProviderRunFunction;
  pushGithub?(userId: number, projectId: string): Promise<unknown | null>;
};

type AuthenticatedGitRequest = Request & {
  user?: {
    id?: number | string;
    [key: string]: unknown;
  };
};

type GitCommandError = Error & {
  code?: number | string | null;
  stdout?: string;
  stderr?: string;
};

type GitSpawnOptions = SpawnOptions & {
  timeoutMs?: number;
  maxBuffer?: number;
};

const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const DEFAULT_GIT_MAX_BUFFER = 16 * 1024 * 1024;

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readErrorStderr(error: unknown): string {
  return typeof error === 'object' && error !== null && 'stderr' in error && typeof error.stderr === 'string'
    ? error.stderr
    : '';
}

function readQueryString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

/** Creates Git routes around explicit repository, filesystem, subprocess, and AI adapters. */
export function createGitRouter(dependencies: GitRouterDependencies): express.Router {
const fs = dependencies.fileSystem;
const spawn = dependencies.spawnProcess;
const projectsDb = { getProjectPathById: dependencies.resolveProjectPathById };
const queryClaudeSDK = dependencies.queryClaude;
const spawnCursor = dependencies.queryCursor;
const router = express.Router();
const COMMIT_DIFF_CHARACTER_LIMIT = 500_000;

function spawnAsync(command: string, args: string[], options: GitSpawnOptions = {}): Promise<GitProcessResult> {
  const {
    timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
    maxBuffer = DEFAULT_GIT_MAX_BUFFER,
    ...spawnOptions
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...spawnOptions,
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let totalBytes = 0;
    let settled = false;

    const killChild = () => {
      try {
        if (typeof child.kill === 'function') {
          child.kill('SIGKILL');
        }
      } catch {
        // Process may already have exited.
      }
    };

    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      reject(error);
    };

    const finishResolve = (result: GitProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    };

    const timeoutHandle = setTimeout(() => {
      killChild();
      const timeoutError: GitCommandError = new Error(
        `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command} ${args.join(' ')}`,
      );
      timeoutError.code = 'ETIMEDOUT';
      timeoutError.stdout = stdout;
      timeoutError.stderr = stderr;
      finishReject(timeoutError);
    }, timeoutMs);
    timeoutHandle.unref?.();

    child.stdout?.on('data', (data: Buffer | string) => {
      if (settled) return;
      const chunk = typeof data === 'string' ? data : data.toString();
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > maxBuffer) {
        killChild();
        const overflowError: GitCommandError = new Error(
          `Command output exceeded ${maxBuffer} bytes: ${command}`,
        );
        overflowError.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        finishReject(overflowError);
        return;
      }
      stdout += chunk;
    });

    child.stderr?.on('data', (data: Buffer | string) => {
      if (settled) return;
      const chunk = typeof data === 'string' ? data : data.toString();
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > maxBuffer) {
        killChild();
        const overflowError: GitCommandError = new Error(
          `Command output exceeded ${maxBuffer} bytes: ${command}`,
        );
        overflowError.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        finishReject(overflowError);
        return;
      }
      stderr += chunk;
    });

    child.on('error', (error: Error) => {
      finishReject(error);
    });

    child.on('close', (code: number | null) => {
      if (code === 0) {
        finishResolve({ stdout, stderr });
        return;
      }

      const error: GitCommandError = new Error(`Command failed: ${command} ${args.join(' ')}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      finishReject(error);
    });
  });
}

// Input validation helpers (defense-in-depth)
function validateCommitRef(commit: string): string {
  // Reject leading hyphens (git option injection) and '..' ranges (bulk history dump)
  if (
    typeof commit !== 'string'
    || !commit
    || commit.startsWith('-')
    || commit.includes('..')
    || !/^[a-zA-Z0-9._~^{}@/-]+$/.test(commit)
  ) {
    throw new Error('Invalid commit reference');
  }
  return commit;
}

function validateBranchName(branch: string): string {
  if (
    typeof branch !== 'string'
    || !branch
    || branch.startsWith('-')
    || branch.startsWith('/')
    || branch.endsWith('/')
    || branch.endsWith('.lock')
    || branch.includes('..')
    || branch.includes('//')
    || !/^[a-zA-Z0-9._/-]+$/.test(branch)
  ) {
    throw new Error('Invalid branch name');
  }
  return branch;
}

function validateFilePath(file: string, projectPath?: string): string {
  if (typeof file !== 'string' || !file || file.includes('\0')) {
    throw new Error('Invalid file path');
  }
  // Prevent path traversal: resolve the file relative to the project root
  // and ensure the result stays within the project directory
  if (projectPath) {
    const resolved = path.resolve(projectPath, file);
    const normalizedRoot = path.resolve(projectPath) + path.sep;
    if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(projectPath)) {
      throw new Error('Invalid file path: path traversal detected');
    }
  }
  return file;
}

function validateRemoteName(remote: string): string {
  if (
    typeof remote !== 'string'
    || !remote
    || remote.startsWith('-')
    || remote.includes('..')
    || !/^[a-zA-Z0-9._-]+$/.test(remote)
  ) {
    throw new Error('Invalid remote name');
  }
  return remote;
}

function validateProjectPath(projectPath: string): string {
  if (!projectPath || projectPath.includes('\0')) {
    throw new Error('Invalid project path');
  }
  const resolved = path.resolve(projectPath);
  // Must be an absolute path after resolution
  if (!path.isAbsolute(resolved)) {
    throw new Error('Invalid project path: must be absolute');
  }
  // Block obviously dangerous paths
  if (resolved === '/' || resolved === path.sep) {
    throw new Error('Invalid project path: root directory not allowed');
  }
  return resolved;
}

/**
 * Resolve the absolute project directory for a given DB `projectId`.
 *
 * After the projectName → projectId migration, every git endpoint receives
 * the DB primary key (`project` query/body param). The legacy filesystem
 * resolver that walked Claude's JSONL history is no longer used here; the
 * path comes straight from the `projects` table and is then sanity-checked
 * by `validateProjectPath` before any `git` command runs against it.
 */
async function getActualProjectPath(projectId: string): Promise<string> {
  const projectPath = await projectsDb.getProjectPathById(projectId);
  if (!projectPath) {
    throw new Error(`Unable to resolve project path for "${projectId}"`);
  }
  return validateProjectPath(projectPath);
}

// Helper function to strip git diff headers
function stripDiffHeaders(diff: string): string {
  if (!diff) return '';

  const lines = diff.split('\n');
  const filteredLines: string[] = [];
  let startIncluding = false;

  for (const line of lines) {
    // Skip all header lines including diff --git, index, file mode, and --- / +++ file paths
    if (line.startsWith('diff --git') ||
        line.startsWith('index ') ||
        line.startsWith('new file mode') ||
        line.startsWith('deleted file mode') ||
        line.startsWith('---') ||
        line.startsWith('+++')) {
      continue;
    }

    // Start including lines from @@ hunk headers onwards
    if (line.startsWith('@@') || startIncluding) {
      startIncluding = true;
      filteredLines.push(line);
    }
  }

  return filteredLines.join('\n');
}

// Helper function to validate git repository
async function validateGitRepository(projectPath: string): Promise<void> {
  try {
    // Check if directory exists
    await fs.access(projectPath);
  } catch {
    throw new Error(`Project path not found: ${projectPath}`);
  }

  try {
    // Allow any directory that is inside a work tree (repo root or nested folder).
    const { stdout: insideWorkTreeOutput } = await spawnAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectPath });
    const isInsideWorkTree = insideWorkTreeOutput.trim() === 'true';
    if (!isInsideWorkTree) {
      throw new AppError('Not a git repository', {
        code: 'NOT_A_GIT_REPOSITORY',
        statusCode: 400,
      });
    }

    // Ensure git can resolve the repository root for this directory.
    await spawnAsync('git', ['rev-parse', '--show-toplevel'], { cwd: projectPath });
  } catch (error) {
    if (
      error instanceof AppError
      && error.code === 'NOT_A_GIT_REPOSITORY'
    ) {
      throw error;
    }

    if (/not a git repository/i.test(getGitErrorDetails(error))) {
      throw new AppError('Not a git repository. Initialize a git repository with "git init" to use source control features.', {
        code: 'NOT_A_GIT_REPOSITORY',
        statusCode: 400,
      });
    }

    throw error;
  }
}

function isMissingHeadRevisionError(error: unknown): boolean {
  const errorDetails = getGitErrorDetails(error).toLowerCase();
  return errorDetails.includes('unknown revision')
    || errorDetails.includes('ambiguous argument')
    || errorDetails.includes('needed a single revision')
    || errorDetails.includes('bad revision');
}

async function getCurrentBranchName(projectPath: string): Promise<string> {
  try {
    // symbolic-ref works even when the repository has no commits.
    const { stdout } = await spawnAsync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: projectPath });
    const branchName = stdout.trim();
    if (branchName) {
      return branchName;
    }
  } catch {
    // Fall back to rev-parse for detached HEAD and older git edge cases.
  }

  const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectPath });
  return stdout.trim();
}

async function repositoryHasCommits(projectPath: string): Promise<boolean> {
  try {
    await spawnAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: projectPath });
    return true;
  } catch (error) {
    if (isMissingHeadRevisionError(error)) {
      return false;
    }
    throw error;
  }
}

async function getRepositoryRootPath(projectPath: string): Promise<string> {
  const { stdout } = await spawnAsync('git', ['rev-parse', '--show-toplevel'], { cwd: projectPath });
  return stdout.trim();
}

function normalizeRepositoryRelativeFilePath(filePath: string): string {
  return String(filePath)
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .trim();
}

function parseStatusFilePaths(statusOutput: string): string[] {
  return statusOutput
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .map((line) => {
      const statusPath = line.substring(3);
      const renamedFilePath = statusPath.split(' -> ')[1];
      return normalizeRepositoryRelativeFilePath(renamedFilePath || statusPath);
    })
    .filter(Boolean);
}

function buildFilePathCandidates(projectPath: string, repositoryRootPath: string, filePath: string): string[] {
  const normalizedFilePath = normalizeRepositoryRelativeFilePath(filePath);
  const projectRelativePath = normalizeRepositoryRelativeFilePath(path.relative(repositoryRootPath, projectPath));
  const candidates = [normalizedFilePath];

  if (
    projectRelativePath
    && projectRelativePath !== '.'
    && !normalizedFilePath.startsWith(`${projectRelativePath}/`)
  ) {
    candidates.push(`${projectRelativePath}/${normalizedFilePath}`);
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

async function resolveRepositoryFilePath(projectPath: string, filePath: string): Promise<{
  repositoryRootPath: string;
  repositoryRelativeFilePath: string;
}> {
  validateFilePath(filePath, projectPath);

  const repositoryRootPath = await getRepositoryRootPath(projectPath);
  const candidateFilePaths = buildFilePathCandidates(projectPath, repositoryRootPath, filePath);

  for (const candidateFilePath of candidateFilePaths) {
    validateFilePath(candidateFilePath, repositoryRootPath);
    const { stdout } = await spawnAsync('git', ['status', '--porcelain', '--', candidateFilePath], { cwd: repositoryRootPath });
    if (stdout.trim()) {
      return {
        repositoryRootPath,
        repositoryRelativeFilePath: candidateFilePath,
      };
    }
  }

  // If the caller sent a bare filename (e.g. "hello.ts"), recover it from changed files.
  const normalizedFilePath = normalizeRepositoryRelativeFilePath(filePath);
  if (!normalizedFilePath.includes('/')) {
    const { stdout: repositoryStatusOutput } = await spawnAsync('git', ['status', '--porcelain'], { cwd: repositoryRootPath });
    const changedFilePaths = parseStatusFilePaths(repositoryStatusOutput);
    const suffixMatches = changedFilePaths.filter(
      (changedFilePath) => changedFilePath === normalizedFilePath || changedFilePath.endsWith(`/${normalizedFilePath}`),
    );

    if (suffixMatches.length === 1) {
      validateFilePath(suffixMatches[0], repositoryRootPath);
      return {
        repositoryRootPath,
        repositoryRelativeFilePath: suffixMatches[0],
      };
    }
  }

  validateFilePath(candidateFilePaths[0], repositoryRootPath);
  return {
    repositoryRootPath,
    repositoryRelativeFilePath: candidateFilePaths[0],
  };
}

// Get Git status for a project; parsing is isolated in git-parsing.service.ts.
router.get('/status', async (req, res) => {
  const project = readQueryString(req.query.project);

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);

    // Validate git repository
    await validateGitRepository(projectPath);

    const branch = await getCurrentBranchName(projectPath);
    const hasCommits = await repositoryHasCommits(projectPath);

    const { stdout: statusOutput } = await spawnAsync('git', ['status', '--porcelain=v1', '-z'], { cwd: projectPath });
    const { modified, added, deleted, untracked, staged } = parseGitStatusOutput(statusOutput);

    res.json({
      branch,
      hasCommits,
      modified,
      added,
      deleted,
      untracked,
      staged
    });
  } catch (error) {
    // Case-insensitive so "Not a git repository..." from validateGitRepository
    // matches; `notGitRepository` lets the UI offer a one-click `git init`.
    const isNotGitRepository = error instanceof AppError && error.code === 'NOT_A_GIT_REPOSITORY';
    // A project without a repository is an expected state, not a failure.
    if (!isNotGitRepository) {
      console.error('Git status error:', error);
    }
    res.json({
      error: isNotGitRepository ? 'Not a git repository' : 'Git operation failed',
      details: isNotGitRepository ? error.message : `Failed to get git status: ${readErrorMessage(error)}`,
      notGitRepository: isNotGitRepository
    });
  }
});

// Initialize a new git repository in the project directory
router.post('/init', async (req, res) => {
  const { project } = req.body;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);

    let isAlreadyRepository = false;
    try {
      await validateGitRepository(projectPath);
      isAlreadyRepository = true;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'NOT_A_GIT_REPOSITORY') {
        throw error;
      }
      // Not a repository yet — proceed with git init.
    }

    if (isAlreadyRepository) {
      return res.json({ success: true, output: 'Repository already initialized' });
    }

    const { stdout, stderr } = await spawnAsync('git', ['init'], { cwd: projectPath });
    res.json({ success: true, output: stdout.trim() || stderr.trim() });
  } catch (error) {
    console.error('Git init error:', error);
    res.json({ success: false, error: readErrorStderr(error).trim() || readErrorMessage(error) });
  }
});

// Get diff for a specific file
router.get('/diff', async (req, res) => {
  const project = readQueryString(req.query.project);
  const file = readQueryString(req.query.file);

  if (!project || !file) {
    return res.status(400).json({ error: 'Project id and file path are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    
    // Validate git repository
    await validateGitRepository(projectPath);

    const {
      repositoryRootPath,
      repositoryRelativeFilePath,
    } = await resolveRepositoryFilePath(projectPath, file);

    // Check if file is untracked or deleted
    const { stdout: statusOutput } = await spawnAsync(
      'git',
      ['status', '--porcelain', '--', repositoryRelativeFilePath],
      { cwd: repositoryRootPath },
    );
    const isUntracked = statusOutput.startsWith('??');
    const isDeleted = statusOutput.trim().startsWith('D ') || statusOutput.trim().startsWith(' D');

    let diff;
    if (isUntracked) {
      // For untracked files, show the entire file content as additions
      const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
      const stats = await fs.stat(filePath);

      if (stats.isDirectory()) {
        // For directories, show a simple message
        diff = `Directory: ${repositoryRelativeFilePath}\n(Cannot show diff for directories)`;
      } else {
        const fileContent = await fs.readFile(filePath, 'utf-8');
        const lines = fileContent.split('\n');
        diff = `--- /dev/null\n+++ b/${repositoryRelativeFilePath}\n@@ -0,0 +1,${lines.length} @@\n` +
               lines.map(line => `+${line}`).join('\n');
      }
    } else if (isDeleted) {
      // For deleted files, show the entire file content from HEAD as deletions
      const { stdout: fileContent } = await spawnAsync(
        'git',
        ['show', `HEAD:${repositoryRelativeFilePath}`],
        { cwd: repositoryRootPath },
      );
      const lines = fileContent.split('\n');
      diff = `--- a/${repositoryRelativeFilePath}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n` +
             lines.map(line => `-${line}`).join('\n');
    } else {
      // Get diff for tracked files
      // First check for unstaged changes (working tree vs index)
      const { stdout: unstagedDiff } = await spawnAsync(
        'git',
        ['diff', '--', repositoryRelativeFilePath],
        { cwd: repositoryRootPath },
      );

      if (unstagedDiff) {
        // Show unstaged changes if they exist
        diff = stripDiffHeaders(unstagedDiff);
      } else {
        // If no unstaged changes, check for staged changes (index vs HEAD)
        const { stdout: stagedDiff } = await spawnAsync(
          'git',
          ['diff', '--cached', '--', repositoryRelativeFilePath],
          { cwd: repositoryRootPath },
        );
        diff = stripDiffHeaders(stagedDiff) || '';
      }
    }

    res.json({ diff });
  } catch (error) {
    console.error('Git diff error:', error);
    res.json({ error: readErrorMessage(error) });
  }
});

// Get file content with diff information for CodeEditor
router.get('/file-with-diff', async (req, res) => {
  const project = readQueryString(req.query.project);
  const file = readQueryString(req.query.file);

  if (!project || !file) {
    return res.status(400).json({ error: 'Project id and file path are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);

    // Validate git repository
    await validateGitRepository(projectPath);

    const {
      repositoryRootPath,
      repositoryRelativeFilePath,
    } = await resolveRepositoryFilePath(projectPath, file);

    // Check file status
    const { stdout: statusOutput } = await spawnAsync(
      'git',
      ['status', '--porcelain', '--', repositoryRelativeFilePath],
      { cwd: repositoryRootPath },
    );
    const isUntracked = statusOutput.startsWith('??');
    const isDeleted = statusOutput.trim().startsWith('D ') || statusOutput.trim().startsWith(' D');

    let currentContent = '';
    let oldContent = '';

    if (isDeleted) {
      // For deleted files, get content from HEAD
      const { stdout: headContent } = await spawnAsync(
        'git',
        ['show', `HEAD:${repositoryRelativeFilePath}`],
        { cwd: repositoryRootPath },
      );
      oldContent = headContent;
      currentContent = headContent; // Show the deleted content in editor
    } else {
      // Get current file content
      const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
      const stats = await fs.stat(filePath);

      if (stats.isDirectory()) {
        // Cannot show content for directories
        return res.status(400).json({ error: 'Cannot show diff for directories' });
      }

      currentContent = await fs.readFile(filePath, 'utf-8');

      if (!isUntracked) {
        // Get the old content from HEAD for tracked files
        try {
          const { stdout: headContent } = await spawnAsync(
            'git',
            ['show', `HEAD:${repositoryRelativeFilePath}`],
            { cwd: repositoryRootPath },
          );
          oldContent = headContent;
        } catch (error) {
          // File might be newly added to git (staged but not committed)
          oldContent = '';
        }
      }
    }

    res.json({
      currentContent,
      oldContent,
      isDeleted,
      isUntracked
    });
  } catch (error) {
    console.error('Git file-with-diff error:', error);
    res.json({ error: readErrorMessage(error) });
  }
});

// Create initial commit
router.post('/initial-commit', async (req, res) => {
  const { project } = req.body;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);

    // Validate git repository
    await validateGitRepository(projectPath);

    // Check if there are already commits
    try {
      await spawnAsync('git', ['rev-parse', 'HEAD'], { cwd: projectPath });
      return res.status(400).json({ error: 'Repository already has commits. Use regular commit instead.' });
    } catch {
      // No HEAD - this is good, we can create initial commit
    }

    // Add all files
    await spawnAsync('git', ['add', '.'], { cwd: projectPath });

    // Create initial commit
    const { stdout } = await spawnAsync('git', ['commit', '-m', 'Initial commit'], { cwd: projectPath });

    res.json({ success: true, output: stdout, message: 'Initial commit created successfully' });
  } catch (error) {
    console.error('Git initial commit error:', error);
    const message = readErrorMessage(error);

    // Handle the case where there's nothing to commit
    if (message.includes('nothing to commit')) {
      return res.status(400).json({
        error: 'Nothing to commit',
        details: 'No files found in the repository. Add some files first.'
      });
    }

    res.status(500).json({ error: message });
  }
});

// Commit changes
router.post('/commit', async (req, res) => {
  const { project, message, files } = req.body;
  
  if (!project || !message || !files || files.length === 0) {
    return res.status(400).json({ error: 'Project name, commit message, and files are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    
    // Validate git repository
    await validateGitRepository(projectPath);
    const repositoryRootPath = await getRepositoryRootPath(projectPath);
    
    // Stage selected files
    for (const file of files) {
      const { repositoryRelativeFilePath } = await resolveRepositoryFilePath(projectPath, file);
      await spawnAsync('git', ['add', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
    }

    // Commit with message
    const { stdout } = await spawnAsync('git', ['commit', '-m', message], { cwd: repositoryRootPath });
    
    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error('Git commit error:', error);
    res.status(500).json({ error: readErrorMessage(error) });
  }
});

// Stage files (git add). Mirrors what the UI shows as the "Staged" section,
// so the app's staging state and the real git index never drift apart.
router.post('/stage', async (req, res) => {
  const { project, files } = req.body;

  if (!project || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'Project id and files are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);
    const repositoryRootPath = await getRepositoryRootPath(projectPath);

    for (const file of files) {
      const { repositoryRelativeFilePath } = await resolveRepositoryFilePath(projectPath, file);
      await spawnAsync('git', ['add', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Git stage error:', error);
    res.status(500).json({ error: readErrorMessage(error) });
  }
});

// Unstage files (remove from the index, keep the worktree changes)
router.post('/unstage', async (req, res) => {
  const { project, files } = req.body;

  if (!project || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'Project id and files are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);
    const repositoryRootPath = await getRepositoryRootPath(projectPath);
    const hasCommits = await repositoryHasCommits(projectPath);

    for (const file of files) {
      const { repositoryRelativeFilePath } = await resolveRepositoryFilePath(projectPath, file);
      if (hasCommits) {
        await spawnAsync('git', ['reset', 'HEAD', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
      } else {
        // No HEAD to reset against before the first commit; dropping the
        // index entry is the only way to unstage while keeping the file.
        await spawnAsync('git', ['rm', '--cached', '-r', '--force', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Git unstage error:', error);
    res.status(500).json({ error: readErrorMessage(error) });
  }
});

// Revert latest local commit (keeps changes staged)
router.post('/revert-local-commit', async (req, res) => {
  const { project } = req.body;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    try {
      await spawnAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: projectPath });
    } catch {
      return res.status(400).json({
        error: 'No local commit to revert',
        details: 'This repository has no commit yet.',
      });
    }

    try {
      // Soft reset rewinds one commit while preserving all file changes in the index.
      await spawnAsync('git', ['reset', '--soft', 'HEAD~1'], { cwd: projectPath });
    } catch (error) {
      const errorDetails = `${readErrorStderr(error)} ${readErrorMessage(error)}`;
      const isInitialCommit = errorDetails.includes('HEAD~1') &&
        (errorDetails.includes('unknown revision') || errorDetails.includes('ambiguous argument'));

      if (!isInitialCommit) {
        throw error;
      }

      // Initial commit has no parent; deleting HEAD uncommits it and keeps files staged.
      await spawnAsync('git', ['update-ref', '-d', 'HEAD'], { cwd: projectPath });
    }

    res.json({
      success: true,
      output: 'Latest local commit reverted successfully. Changes were kept staged.',
    });
  } catch (error) {
    console.error('Git revert local commit error:', error);
    res.status(500).json({ error: readErrorMessage(error) });
  }
});

// Get list of branches
router.get('/branches', async (req, res) => {
  const project = readQueryString(req.query.project);

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    
    // Validate git repository
    await validateGitRepository(projectPath);
    
    // Get all branches
    const { stdout } = await spawnAsync('git', ['branch', '-a'], { cwd: projectPath });

    const rawLines = stdout
      .split('\n')
      .map(b => b.trim())
      .filter(b => b && !b.includes('->'));

    // Local branches (may start with '* ' for current)
    const localBranches = rawLines
      .filter(b => !b.startsWith('remotes/'))
      .map(b => (b.startsWith('* ') ? b.substring(2) : b));

    // Remote branches — strip 'remotes/<remote>/' prefix
    const remoteBranches = rawLines
      .filter(b => b.startsWith('remotes/'))
      .map(b => b.replace(/^remotes\/[^/]+\//, ''))
      .filter(name => !localBranches.includes(name)); // skip if already a local branch

    // Backward-compat flat list (local + unique remotes, deduplicated)
    const branches = [...localBranches, ...remoteBranches]
      .filter((b, i, arr) => arr.indexOf(b) === i);

    // Full remote-tracking names (`origin/main`) for callers that need an
    // unambiguous ref, e.g. the Compare tab's base selector.
    const remoteRefs = rawLines
      .filter(b => b.startsWith('remotes/'))
      .map(b => b.replace(/^remotes\//, ''));

    res.json({ branches, localBranches, remoteBranches, remoteRefs });
  } catch (error) {
    console.error('Git branches error:', error);
    res.json({ error: readErrorMessage(error) });
  }
});

// Shared error shaping for the two compare routes: service AppErrors (unknown
// ref, no merge base) keep their status/code; anything else follows the
// module's GET convention of a 200 with `error`/`details`.
function sendBranchDiffError(res: Response, error: unknown, context: string) {
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({ error: error.message, code: error.code, details: error.details });
  }
  console.error(`Git ${context} error:`, error);
  res.json({ error: 'Git operation failed', details: readErrorMessage(error) });
}

// List files the working copy changed relative to the merge base with `base`
router.get('/branch-diff', async (req, res) => {
  const project = readQueryString(req.query.project);
  const base = readQueryString(req.query.base);

  if (!project || !base) {
    return res.status(400).json({ error: 'Project id and base branch are required' });
  }

  try {
    validateBranchName(base);
  } catch (error) {
    return res.status(400).json({ error: readErrorMessage(error) });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);
    // Run from the repository root so untracked paths are root-relative like
    // everything else the panel shows, even for projects nested in a repo.
    const repositoryRootPath = await getRepositoryRootPath(projectPath);
    const result = await listBranchDiffFiles({
      projectPath: repositoryRootPath,
      base,
      runCommand: spawnAsync,
    });
    res.json(result);
  } catch (error) {
    sendBranchDiffError(res, error, 'branch diff');
  }
});

// Diff of one file between the merge base with `base` and the working copy.
// `oldPath` is the pre-rename path of an `R` entry from `/branch-diff`.
router.get('/branch-diff/file', async (req, res) => {
  const project = readQueryString(req.query.project);
  const base = readQueryString(req.query.base);
  const file = readQueryString(req.query.file);
  const oldPathRaw = req.query.oldPath;
  const oldPath = oldPathRaw === undefined ? undefined : readQueryString(oldPathRaw);

  if (!project || !base || !file) {
    return res.status(400).json({ error: 'Project id, base branch and file path are required' });
  }

  try {
    validateBranchName(base);
    validateFilePath(file);
    if (oldPath !== undefined) {
      validateFilePath(oldPath);
    }
  } catch (error) {
    return res.status(400).json({ error: readErrorMessage(error) });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    // `/branch-diff` already reports repository-root-relative paths, and
    // compare files need not appear in `git status` (committed-only changes),
    // so the status-based resolver is skipped: its bare-filename fallback
    // could remap e.g. `README.md` onto a changed `docs/README.md`.
    const repositoryRootPath = await getRepositoryRootPath(projectPath);
    const repositoryRelativeFilePath = normalizeRepositoryRelativeFilePath(file);
    validateFilePath(repositoryRelativeFilePath, repositoryRootPath);
    const repositoryRelativeOldPath = oldPath === undefined ? undefined : normalizeRepositoryRelativeFilePath(oldPath);
    if (repositoryRelativeOldPath !== undefined) {
      validateFilePath(repositoryRelativeOldPath, repositoryRootPath);
    }

    const diff = await getBranchDiffForFile({
      projectPath: repositoryRootPath,
      base,
      file: repositoryRelativeFilePath,
      oldPath: repositoryRelativeOldPath,
      runCommand: spawnAsync,
      readFile: (absolutePath) => fs.readFile(absolutePath, 'utf-8'),
    });
    res.json({ diff: stripDiffHeaders(diff) });
  } catch (error) {
    sendBranchDiffError(res, error, 'branch diff file');
  }
});

// Checkout branch
router.post('/checkout', async (req, res) => {
  const { project, branch } = req.body;

  if (!project || !branch) {
    return res.status(400).json({ error: 'Project id and branch are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);

    // Checkout the branch
    validateBranchName(branch);
    const { stdout } = await spawnAsync('git', ['checkout', branch, '--'], { cwd: projectPath });

    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error('Git checkout error:', error);
    res.status(500).json({ error: readErrorMessage(error) });
  }
});

// Create new branch
router.post('/create-branch', async (req, res) => {
  const { project, branch } = req.body;

  if (!project || !branch) {
    return res.status(400).json({ error: 'Project id and branch name are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);

    // Create and checkout new branch
    validateBranchName(branch);
    const { stdout } = await spawnAsync('git', ['checkout', '-b', branch], { cwd: projectPath });

    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error('Git create branch error:', error);
    res.status(500).json({ error: readErrorMessage(error) });
  }
});

// Delete a local branch
router.post('/delete-branch', async (req, res) => {
  const { project, branch, force = false } = req.body;

  if (!project || !branch) {
    return res.status(400).json({ error: 'Project id and branch name are required' });
  }

  if (typeof force !== 'boolean') {
    return res.status(400).json({ error: 'force must be a boolean' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);
    validateBranchName(branch);
    const stdout = await deleteLocalBranch({
      projectPath,
      branch,
      force,
      runCommand: spawnAsync,
    });
    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error('Git delete branch error:', error);
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    res.status(500).json({ error: readErrorMessage(error) });
  }
});

// Fields are joined with the ASCII unit separator so pipes (or anything else
// typed into a commit subject) cannot break parsing.
const GIT_LOG_PRETTY_FORMAT = '%H%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%ad%x1f%s';

// Get recent commits (across all branches, in graph order)
router.get('/commits', async (req, res) => {
  const project = readQueryString(req.query.project);
  const limit = req.query.limit ?? 10;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);
    const parsedLimit = Number.parseInt(String(limit), 10);
    const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 100)
      : 10;

    // Branches/remotes/tags (not --all, which would drag in refs/stash) with
    // `--topo-order` guarantee children appear before their parents across
    // every branch, which the frontend lane-assignment relies on.
    // `--shortstat` replaces the previous per-commit `git show --stat` calls.
    const { stdout } = await spawnAsync(
      'git',
      [
        'log',
        '--branches',
        '--remotes',
        '--tags',
        '--topo-order',
        '--shortstat',
        `--pretty=format:${GIT_LOG_PRETTY_FORMAT}`,
        '--date=iso-strict',
        '-n', String(safeLimit)
      ],
      { cwd: projectPath },
    );

    res.json({ commits: parseGitLogWithStats(stdout) });
  } catch (error) {
    console.error('Git commits error:', error);
    res.json({ error: readErrorMessage(error) });
  }
});

// Get diff for a specific commit
router.get('/commit-diff', async (req, res) => {
  const project = readQueryString(req.query.project);
  const commit = readQueryString(req.query.commit);

  if (!project || !commit) {
    return res.status(400).json({ error: 'Project id and commit hash are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);

    // Validate commit reference (defense-in-depth)
    validateCommitRef(commit);

    // Get diff for the commit (--end-of-options blocks git flag injection)
    const { stdout } = await spawnAsync(
      'git', ['show', '--end-of-options', commit],
      { cwd: projectPath }
    );

    const isTruncated = stdout.length > COMMIT_DIFF_CHARACTER_LIMIT;
    const diff = isTruncated
      ? `${stdout.slice(0, COMMIT_DIFF_CHARACTER_LIMIT)}\n\n... Diff truncated to keep the UI responsive ...`
      : stdout;

    res.json({ diff, isTruncated });
  } catch (error) {
    console.error('Git commit diff error:', error);
    res.json({ error: readErrorMessage(error) });
  }
});

// Generate commit message based on staged changes using AI
router.post('/generate-commit-message', async (req, res) => {
  const { project, files, provider = 'claude' } = req.body;

  if (!project || !files || files.length === 0) {
    return res.status(400).json({ error: 'Project id and files are required' });
  }

  // Validate provider
  if (!['claude', 'cursor'].includes(provider)) {
    return res.status(400).json({ error: 'provider must be "claude" or "cursor"' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);
    const repositoryRootPath = await getRepositoryRootPath(projectPath);

    // Get diff for selected files
    let diffContext = '';
    for (const file of files) {
      try {
        const { repositoryRelativeFilePath } = await resolveRepositoryFilePath(projectPath, file);
        const { stdout } = await spawnAsync(
          'git', ['diff', 'HEAD', '--', repositoryRelativeFilePath],
          { cwd: repositoryRootPath }
        );
        if (stdout) {
          diffContext += `\n--- ${repositoryRelativeFilePath} ---\n${stdout}`;
        }
      } catch (error) {
        console.error(`Error getting diff for ${file}:`, error);
      }
    }

    // If no diff found, might be untracked files
    if (!diffContext.trim()) {
      // Try to get content of untracked files
      for (const file of files) {
        try {
          const { repositoryRelativeFilePath } = await resolveRepositoryFilePath(projectPath, file);
          const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
          const stats = await fs.stat(filePath);

          if (!stats.isDirectory()) {
            const content = await fs.readFile(filePath, 'utf-8');
            diffContext += `\n--- ${repositoryRelativeFilePath} (new file) ---\n${content.substring(0, 1000)}\n`;
          } else {
            diffContext += `\n--- ${repositoryRelativeFilePath} (new directory) ---\n`;
          }
        } catch (error) {
          console.error(`Error reading file ${file}:`, error);
        }
      }
    }

    // Generate commit message using AI
    const message = await generateCommitMessageWithAI(files, diffContext, provider, projectPath);

    res.json({ message });
  } catch (error) {
    console.error('Generate commit message error:', error);
    res.status(500).json({ error: readErrorMessage(error) });
  }
});

/**
 * Generates a commit message using AI (Claude SDK or Cursor CLI)
 */
async function generateCommitMessageWithAI(
  files: string[],
  diffContext: string,
  provider: string,
  projectPath: string,
): Promise<string> {
  // Create the prompt
  const prompt = `Generate a conventional commit message for these changes.

REQUIREMENTS:
- Format: type(scope): subject
- Include body explaining what changed and why
- Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore
- Subject under 50 chars, body wrapped at 72 chars
- Focus on user-facing changes, not implementation details
- Consider what's being added AND removed
- Return ONLY the commit message (no markdown, explanations, or code blocks)

FILES CHANGED:
${files.map(f => `- ${f}`).join('\n')}

DIFFS:
${diffContext.substring(0, 4000)}

Generate the commit message:`;

  try {
    // Create a simple writer that collects the response
    let responseText = '';
    const writer = {
      send: (data: unknown) => {
        try {
          const parsed = (typeof data === 'string' ? JSON.parse(data) : data) as Record<string, any>;
          console.log('🔍 Writer received message type:', parsed.type);

          // Handle different message formats from Claude SDK and Cursor CLI
          // Claude SDK sends: {type: 'claude-response', data: {message: {content: [...]}}}
          if (parsed.type === 'claude-response' && parsed.data) {
            const message = parsed.data.message || parsed.data;
            console.log('📦 Claude response message:', JSON.stringify(message, null, 2).substring(0, 500));
            if (message.content && Array.isArray(message.content)) {
              // Extract text from content array
              for (const item of message.content) {
                if (item.type === 'text' && item.text) {
                  console.log('✅ Extracted text chunk:', item.text.substring(0, 100));
                  responseText += item.text;
                }
              }
            }
          }
          // Cursor CLI sends: {type: 'cursor-output', output: '...'}
          else if (parsed.type === 'cursor-output' && parsed.output) {
            console.log('✅ Cursor output:', parsed.output.substring(0, 100));
            responseText += parsed.output;
          }
          // Also handle direct text messages / unified NormalizedMessage
          else if ((parsed.type === 'text' && parsed.text) || (parsed.kind === 'text' && parsed.content)) {
            const chunk = String(parsed.text ?? parsed.content);
            console.log('✅ Direct text:', chunk.substring(0, 100));
            responseText += chunk;
          }
        } catch (e) {
          // Ignore parse errors
          console.error('Error parsing writer data:', e);
        }
      },
      setSessionId: () => {}, // No-op for this use case
    };

    console.log('🚀 Calling AI agent with provider:', provider);
    console.log('📝 Prompt length:', prompt.length);

    // Call the appropriate agent
    if (provider === 'claude') {
      await queryClaudeSDK(prompt, {
        cwd: projectPath,
        permissionMode: 'bypassPermissions',
        model: 'sonnet'
      }, writer);
    } else if (provider === 'cursor') {
      await spawnCursor(prompt, {
        cwd: projectPath,
        skipPermissions: true
      }, writer);
    }

    console.log('📊 Total response text collected:', responseText.length, 'characters');
    console.log('📄 Response preview:', responseText.substring(0, 200));

    // Clean up the response
    const cleanedMessage = cleanCommitMessage(responseText);
    console.log('🧹 Cleaned message:', cleanedMessage.substring(0, 200));

    return cleanedMessage || 'chore: update files';
  } catch (error) {
    console.error('Error generating commit message with AI:', error);
    // Fallback to simple message
    return `chore: update ${files.length} file${files.length !== 1 ? 's' : ''}`;
  }
}

/**
 * Cleans the AI-generated commit message by removing markdown, code blocks, and extra formatting
 * @param {string} text - Raw AI response
 * @returns {string} Clean commit message
 */
function cleanCommitMessage(text: string): string {
  if (!text || !text.trim()) {
    return '';
  }

  let cleaned = text.trim();

  // Remove markdown code blocks
  cleaned = cleaned.replace(/```[a-z]*\n/g, '');
  cleaned = cleaned.replace(/```/g, '');

  // Remove markdown headers
  cleaned = cleaned.replace(/^#+\s*/gm, '');

  // Remove leading/trailing quotes
  cleaned = cleaned.replace(/^["']|["']$/g, '');

  // If there are multiple lines, take everything (subject + body)
  // Just clean up extra blank lines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  // Remove any explanatory text before the actual commit message
  // Look for conventional commit pattern and start from there
  const conventionalCommitMatch = cleaned.match(/(feat|fix|docs|style|refactor|perf|test|build|ci|chore)(\(.+?\))?:.+/s);
  if (conventionalCommitMatch) {
    cleaned = cleaned.substring(cleaned.indexOf(conventionalCommitMatch[0]));
  }

  return cleaned.trim();
}

// Get remote status (ahead/behind commits with smart remote detection)
router.get('/remote-status', async (req, res) => {
  const project = readQueryString(req.query.project);

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    const branch = await getCurrentBranchName(projectPath);
    const hasCommits = await repositoryHasCommits(projectPath);

    const { stdout: remoteOutput } = await spawnAsync('git', ['remote'], { cwd: projectPath });
    const remotes = remoteOutput.trim().split('\n').filter(r => r.trim());
    const hasRemote = remotes.length > 0;
    const fallbackRemoteName = hasRemote
      ? (remotes.includes('origin') ? 'origin' : remotes[0])
      : null;

    // Repositories initialized with `git init` can have a branch but no commits.
    // Return a non-error state so the UI can show the initial-commit workflow.
    if (!hasCommits) {
      return res.json({
        hasRemote,
        hasUpstream: false,
        branch,
        remoteName: fallbackRemoteName,
        ahead: 0,
        behind: 0,
        isUpToDate: false,
        message: 'Repository has no commits yet'
      });
    }

    // Check if there's a remote tracking branch (smart detection)
    let trackingBranch;
    let remoteName;
    try {
      const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      trackingBranch = stdout.trim();
      remoteName = trackingBranch.split('/')[0]; // Extract remote name (e.g., "origin/main" -> "origin")
    } catch (error) {
      return res.json({
        hasRemote,
        hasUpstream: false,
        branch,
        remoteName: fallbackRemoteName,
        message: 'No remote tracking branch configured'
      });
    }

    // Get ahead/behind counts
    const { stdout: countOutput } = await spawnAsync(
      'git', ['rev-list', '--count', '--left-right', `${trackingBranch}...HEAD`],
      { cwd: projectPath }
    );
    
    const [behind, ahead] = countOutput.trim().split('\t').map(Number);

    res.json({
      hasRemote: true,
      hasUpstream: true,
      branch,
      remoteBranch: trackingBranch,
      remoteName,
      ahead: ahead || 0,
      behind: behind || 0,
      isUpToDate: ahead === 0 && behind === 0
    });
  } catch (error) {
    console.error('Git remote status error:', error);
    res.json({ error: readErrorMessage(error) });
  }
});

// Fetch from remote (using smart remote detection)
router.post('/fetch', async (req, res) => {
  const { project } = req.body;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    // Get current branch and its upstream remote
    const branch = await getCurrentBranchName(projectPath);

    let remoteName = 'origin'; // fallback
    try {
      const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      remoteName = stdout.trim().split('/')[0]; // Extract remote name
    } catch {
      // No upstream, try to fetch from origin anyway
      console.log('No upstream configured, using origin as fallback');
    }

    validateRemoteName(remoteName);
    const { stdout } = await spawnAsync('git', ['fetch', '--', remoteName], { cwd: projectPath });

    res.json({ success: true, output: stdout || 'Fetch completed successfully', remoteName });
  } catch (error) {
    console.error('Git fetch error:', error);
    const message = readErrorMessage(error);
    res.status(500).json({
      error: 'Fetch failed',
      details: message.includes('Could not resolve hostname')
        ? 'Unable to connect to remote repository. Check your internet connection.'
        : message.includes('fatal: \'origin\' does not appear to be a git repository')
        ? 'No remote repository configured. Add a remote with: git remote add origin <url>'
        : message
    });
  }
});

// Pull from remote (fetch + merge using smart remote detection)
router.post('/pull', async (req, res) => {
  const { project } = req.body;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    // Get current branch and its upstream remote
    const branch = await getCurrentBranchName(projectPath);

    let remoteName = 'origin'; // fallback
    let remoteBranch = branch; // fallback
    try {
      const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      const tracking = stdout.trim();
      remoteName = tracking.split('/')[0]; // Extract remote name
      remoteBranch = tracking.split('/').slice(1).join('/'); // Extract branch name
    } catch {
      // No upstream, use fallback
      console.log('No upstream configured, using origin/branch as fallback');
    }

    validateRemoteName(remoteName);
    validateBranchName(remoteBranch);
    const { stdout } = await spawnAsync('git', ['pull', '--', remoteName, remoteBranch], { cwd: projectPath });

    res.json({
      success: true,
      output: stdout || 'Pull completed successfully',
      remoteName,
      remoteBranch
    });
  } catch (error) {
    console.error('Git pull error:', error);
    const message = readErrorMessage(error);

    // Enhanced error handling for common pull scenarios
    let errorMessage = 'Pull failed';
    let details = message;

    if (message.includes('CONFLICT')) {
      errorMessage = 'Merge conflicts detected';
      details = 'Pull created merge conflicts. Please resolve conflicts manually in the editor, then commit the changes.';
    } else if (message.includes('Please commit your changes or stash them')) {
      errorMessage = 'Uncommitted changes detected';
      details = 'Please commit or stash your local changes before pulling.';
    } else if (message.includes('Could not resolve hostname')) {
      errorMessage = 'Network error';
      details = 'Unable to connect to remote repository. Check your internet connection.';
    } else if (message.includes('fatal: \'origin\' does not appear to be a git repository')) {
      errorMessage = 'Remote not configured';
      details = 'No remote repository configured. Add a remote with: git remote add origin <url>';
    } else if (message.includes('diverged')) {
      errorMessage = 'Branches have diverged';
      details = 'Your local branch and remote branch have diverged. Consider fetching first to review changes.';
    }

    res.status(500).json({
      error: errorMessage,
      details: details
    });
  }
});

// Push commits to remote repository
router.post('/push', async (req: AuthenticatedGitRequest, res) => {
  const { project } = req.body;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    if (dependencies.pushGithub) {
      const result = await dependencies.pushGithub(Number(req.user?.id), project);
      if (result) return res.json(result);
    }
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    // Get current branch and its upstream remote
    const branch = await getCurrentBranchName(projectPath);

    let remoteName = 'origin'; // fallback
    let remoteBranch = branch; // fallback
    try {
      const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      const tracking = stdout.trim();
      remoteName = tracking.split('/')[0]; // Extract remote name
      remoteBranch = tracking.split('/').slice(1).join('/'); // Extract branch name
    } catch {
      // No upstream, use fallback
      console.log('No upstream configured, using origin/branch as fallback');
    }

    validateRemoteName(remoteName);
    validateBranchName(remoteBranch);
    const { stdout } = await spawnAsync('git', ['push', '--', remoteName, remoteBranch], { cwd: projectPath });

    res.json({
      success: true,
      output: stdout || 'Push completed successfully',
      remoteName,
      remoteBranch
    });
  } catch (error) {
    console.error('Git push error:', error);
    if (error instanceof AppError) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    const message = readErrorMessage(error);

    // Enhanced error handling for common push scenarios
    let errorMessage = 'Push failed';
    let details = message;

    if (message.includes('rejected')) {
      errorMessage = 'Push rejected';
      details = 'The remote has newer commits. Pull first to merge changes before pushing.';
    } else if (message.includes('non-fast-forward')) {
      errorMessage = 'Non-fast-forward push';
      details = 'Your branch is behind the remote. Pull the latest changes first.';
    } else if (message.includes('Could not resolve hostname')) {
      errorMessage = 'Network error';
      details = 'Unable to connect to remote repository. Check your internet connection.';
    } else if (message.includes('fatal: \'origin\' does not appear to be a git repository')) {
      errorMessage = 'Remote not configured';
      details = 'No remote repository configured. Add a remote with: git remote add origin <url>';
    } else if (message.includes('Permission denied')) {
      errorMessage = 'Authentication failed';
      details = 'Permission denied. Check your credentials or SSH keys.';
    } else if (message.includes('no upstream branch')) {
      errorMessage = 'No upstream branch';
      details = 'No upstream branch configured. Use: git push --set-upstream origin <branch>';
    }

    res.status(500).json({
      error: errorMessage,
      details: details
    });
  }
});

// Publish branch to remote (set upstream and push)
router.post('/publish', async (req, res) => {
  const { project, branch } = req.body;

  if (!project || !branch) {
    return res.status(400).json({ error: 'Project id and branch are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);

    // Validate branch name
    validateBranchName(branch);

    // Get current branch to verify it matches the requested branch
    const currentBranchName = await getCurrentBranchName(projectPath);

    if (currentBranchName !== branch) {
      return res.status(400).json({
        error: `Branch mismatch. Current branch is ${currentBranchName}, but trying to publish ${branch}`
      });
    }

    // Check if remote exists
    let remoteName = 'origin';
    try {
      const { stdout } = await spawnAsync('git', ['remote'], { cwd: projectPath });
      const remotes = stdout.trim().split('\n').filter(r => r.trim());
      if (remotes.length === 0) {
        return res.status(400).json({
          error: 'No remote repository configured. Add a remote with: git remote add origin <url>'
        });
      }
      remoteName = remotes.includes('origin') ? 'origin' : remotes[0];
    } catch {
      return res.status(400).json({
        error: 'No remote repository configured. Add a remote with: git remote add origin <url>'
      });
    }

    // Publish the branch (set upstream and push)
    validateRemoteName(remoteName);
    const { stdout } = await spawnAsync('git', ['push', '--set-upstream', '--', remoteName, branch], { cwd: projectPath });

    res.json({
      success: true,
      output: stdout || 'Branch published successfully',
      remoteName,
      branch
    });
  } catch (error) {
    console.error('Git publish error:', error);
    const message = readErrorMessage(error);

    // Enhanced error handling for common publish scenarios
    let errorMessage = 'Publish failed';
    let details = message;

    if (message.includes('rejected')) {
      errorMessage = 'Publish rejected';
      details = 'The remote branch already exists and has different commits. Use push instead.';
    } else if (message.includes('Could not resolve hostname')) {
      errorMessage = 'Network error';
      details = 'Unable to connect to remote repository. Check your internet connection.';
    } else if (message.includes('Permission denied')) {
      errorMessage = 'Authentication failed';
      details = 'Permission denied. Check your credentials or SSH keys.';
    } else if (message.includes('fatal:') && message.includes('does not appear to be a git repository')) {
      errorMessage = 'Remote not configured';
      details = 'Remote repository not properly configured. Check your remote URL.';
    }

    res.status(500).json({
      error: errorMessage,
      details: details
    });
  }
});

// Discard changes for a specific file
router.post('/discard', async (req, res) => {
  const { project, file } = req.body;

  if (!project || !file) {
    return res.status(400).json({ error: 'Project id and file path are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);
    const {
      repositoryRootPath,
      repositoryRelativeFilePath,
    } = await resolveRepositoryFilePath(projectPath, file);

    // Check file status to determine correct discard command
    const { stdout: statusOutput } = await spawnAsync(
      'git',
      ['status', '--porcelain', '--', repositoryRelativeFilePath],
      { cwd: repositoryRootPath },
    );

    if (!statusOutput.trim()) {
      return res.status(400).json({ error: 'No changes to discard for this file' });
    }

    const status = statusOutput.substring(0, 2);

    if (status === '??') {
      // Untracked file or directory - use lstat so symlinks to external folders are unlinked, not recursively deleted
      const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
      const stats = typeof fs.lstat === 'function' ? await fs.lstat(filePath) : await fs.stat(filePath);

      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        await fs.rm(filePath, { recursive: true, force: true });
      } else {
        await fs.unlink(filePath);
      }
    } else if (status.includes('M') || status.includes('D')) {
      // Modified or deleted file - restore from HEAD
      await spawnAsync('git', ['restore', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
    } else if (status.includes('A')) {
      // Added file - unstage it
      await spawnAsync('git', ['reset', 'HEAD', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
    }

    res.json({ success: true, message: `Changes discarded for ${repositoryRelativeFilePath}` });
  } catch (error) {
    console.error('Git discard error:', error);
    res.status(500).json({ error: readErrorMessage(error) });
  }
});

// Delete untracked file
router.post('/delete-untracked', async (req, res) => {
  const { project, file } = req.body;

  if (!project || !file) {
    return res.status(400).json({ error: 'Project id and file path are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project);
    await validateGitRepository(projectPath);
    const {
      repositoryRootPath,
      repositoryRelativeFilePath,
    } = await resolveRepositoryFilePath(projectPath, file);

    // Check if file is actually untracked
    const { stdout: statusOutput } = await spawnAsync(
      'git',
      ['status', '--porcelain', '--', repositoryRelativeFilePath],
      { cwd: repositoryRootPath },
    );

    if (!statusOutput.trim()) {
      return res.status(400).json({ error: 'File is not untracked or does not exist' });
    }

    const status = statusOutput.substring(0, 2);

    if (status !== '??') {
      return res.status(400).json({ error: 'File is not untracked. Use discard for tracked files.' });
    }

    // Delete the untracked file or directory (lstat prevents following symlinks to external directories)
    const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
    const stats = typeof fs.lstat === 'function' ? await fs.lstat(filePath) : await fs.stat(filePath);

    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      // Use rm with recursive option for directories
      await fs.rm(filePath, { recursive: true, force: true });
      res.json({ success: true, message: `Untracked directory ${repositoryRelativeFilePath} deleted successfully` });
    } else {
      await fs.unlink(filePath);
      res.json({ success: true, message: `Untracked file ${repositoryRelativeFilePath} deleted successfully` });
    }
  } catch (error) {
    console.error('Git delete untracked error:', error);
    res.status(500).json({ error: readErrorMessage(error) });
  }
});

return router;
}
