/**
 * Centralized tool configuration registry
 * Defines display behavior for all tool types 
 */

export type ToolDisplayConfig = {
  input: {
    type: 'one-line' | 'collapsible' | 'plan' | 'hidden';
    // One-line config
    icon?: string;
    label?: string;
    getValue?: (input: any) => string;
    getSecondary?: (input: any) => string | undefined;
    action?: 'copy' | 'open-file' | 'jump-to-results' | 'none';
    style?: string;
    wrapText?: boolean;
    colorScheme?: {
      primary?: string;
      secondary?: string;
      background?: string;
      border?: string;
      icon?: string;
    };
    // Collapsible config
    title?: string | ((input: any) => string);
    defaultOpen?: boolean;
    contentType?: 'diff' | 'markdown' | 'file-list' | 'todo-list' | 'text' | 'task' | 'question-answer';
    getContentProps?: (input: any, helpers?: any) => any;
    actionButton?: 'file-button' | 'none';
  };
  result?: {
    hidden?: boolean;
    hideOnSuccess?: boolean;
    type?: 'one-line' | 'collapsible' | 'plan' | 'special';
    title?: string | ((result: any) => string);
    defaultOpen?: boolean;
    // Special result handlers
    contentType?: 'markdown' | 'file-list' | 'todo-list' | 'text' | 'success-message' | 'task' | 'question-answer';
    getMessage?: (result: any) => string;
    getContentProps?: (result: any) => any;
  };
};

/**
 * Input keys that identify what a call operated on, most specific first. Used
 * to summarize a tool this registry has no entry for.
 */
const DESCRIPTIVE_INPUT_KEYS = [
  'command', 'cmd', 'file_path', 'path', 'filePath', 'pattern', 'query', 'url',
  'prompt', 'description', 'toolSummary', 'summary', 'name', 'selector', 'text', 'skill', 'id',
] as const;

function parseMaybeJsonArray(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // ignore malformed JSON string
    }
  }
  return [];
}

function resolveWithCwd(rawPath: unknown, rawCwd: unknown): string {
  const p = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!p) return '';
  if (p.startsWith('/')) return p;
  const cwd = typeof rawCwd === 'string' ? rawCwd.trim().replace(/\/+$/, '') : '';
  if (!cwd) return p;
  return `${cwd}/${p.replace(/^\.\//, '')}`;
}

function shortBasename(rawPath: unknown): string {
  const p = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!p) return '';
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

export function normalizeAgyFastToolKey(toolName: string): string | null {
  const stripped = String(toolName || '').replace(/^mcp_ide-tools_/, '');
  const match = /^(?:mcp__agy-fast_[^_]+__|mcp_agy-fast_[^_]+_|agy-fast_[^/:]+[:/]|agy-fast:)(apply_edits|batch_search|quick_outline|read_slices|run_checks)$/i.exec(stripped);
  return match ? `agy_fast:${match[1].toLowerCase()}` : null;
}

function extractMcpTextResult(result: any): string {
  let content = result?.content || '';
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        const textParts = parsed
          .filter((p: any) => p.type === 'text' && p.text)
          .map((p: any) => p.text);
        if (textParts.length > 0) content = textParts.join('\n');
      }
    } catch {
      // keep raw string
    }
  } else if (Array.isArray(content)) {
    const textParts = content
      .filter((p: any) => p.type === 'text' && p.text)
      .map((p: any) => p.text);
    content = textParts.length > 0 ? textParts.join('\n') : JSON.stringify(content, null, 2);
  } else if (typeof content === 'object' && content !== null) {
    content = JSON.stringify(content, null, 2);
  }
  return String(content);
}

/** Builds a one-line summary of an unmapped tool's input. */
function summarizeToolInput(input: unknown): string {
  if (typeof input === 'string') {
    return input.length > 80 ? `${input.slice(0, 80)}…` : input || 'Parameters';
  }
  if (!input || typeof input !== 'object') {
    return 'Parameters';
  }

  const record = input as Record<string, unknown>;
  for (const key of DESCRIPTIVE_INPUT_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      const single = value.replace(/\s+/g, ' ').trim();
      return single.length > 80 ? `${single.slice(0, 80)}…` : single;
    }
  }

  const keys = Object.keys(record);
  return keys.length > 0 ? keys.slice(0, 3).join(', ') : 'Parameters';
}

/**
 * Turns a namespaced MCP tool id into something readable.
 *
 * Providers name MCP tools `mcp__<server>__<tool>`, which is accurate and
 * unreadable. The tool part is the action; the server is context.
 *
 * Used by chat's ToolRenderer to label every tool row.
 */
/**
 * Headers for the surfaces every provider is normalized onto.
 *
 * The canonical tool names are Claude's, so a Codex plan update would otherwise
 * announce itself as `TodoWrite`. Naming the surface instead of the tool keeps
 * the two providers reading as one product.
 */
const UNIFIED_TOOL_LABELS: Record<string, string> = {
  TodoWrite: 'Checklist',
  TodoRead: 'Checklist',
  AskUserQuestion: 'Question',
};

export function formatToolDisplayName(toolName: string): string {
  const unifiedLabel = UNIFIED_TOOL_LABELS[toolName];
  if (unifiedLabel) {
    return unifiedLabel;
  }

  const normalized = toolName.replace(/^mcp_ide-tools_/, '');
  const mcpMatch = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(normalized);
  if (mcpMatch) {
    return `${mcpMatch[2]} (${mcpMatch[1]})`;
  }

  const acpFastMatch = /^(?:mcp_(agy-fast_[^_]+)_|(agy-fast_[^/:]+)[:/])([a-z0-9_]+)$/i.exec(normalized);
  if (acpFastMatch) {
    const server = acpFastMatch[1] || acpFastMatch[2];
    return `${acpFastMatch[3]} (${server})`;
  }

  return toolName;
}

export const TOOL_CONFIGS: Record<string, ToolDisplayConfig> = {
  // ============================================================================
  // COMMAND TOOLS
  // ============================================================================

  Bash: {
    input: {
      type: 'one-line',
      icon: 'terminal',
      getValue: (input) => input.command,
      getSecondary: (input) => input.description,
      action: 'copy',
      style: 'terminal',
      wrapText: true,
      colorScheme: {
        primary: 'text-green-400 font-mono',
        secondary: 'text-gray-400',
        background: '',
        border: 'border-green-500 dark:border-green-400',
        icon: 'text-green-500 dark:text-green-400'
      }
    },
    result: {
      hideOnSuccess: true,
      type: 'special'
    }
  },

  // Claude exposes a separate PowerShell tool on Windows. It is the same
  // interaction as Bash, so it gets the same command row rather than falling
  // through to the generic parameter dump.
  PowerShell: {
    input: {
      type: 'one-line',
      icon: 'terminal',
      getValue: (input) => input.command,
      getSecondary: (input) => input.description,
      action: 'copy',
      style: 'terminal',
      wrapText: true,
      colorScheme: {
        primary: 'text-green-400 font-mono',
        secondary: 'text-gray-400',
        background: '',
        border: 'border-green-500 dark:border-green-400',
        icon: 'text-green-500 dark:text-green-400'
      }
    },
    result: {
      hideOnSuccess: true,
      type: 'special'
    }
  },

  // ============================================================================
  // WEB TOOLS
  // ============================================================================

  WebSearch: {
    input: {
      type: 'one-line',
      label: 'Search',
      getValue: (input) => input.query || '',
      action: 'none',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        border: 'border-sky-400 dark:border-sky-500',
        icon: 'text-sky-500 dark:text-sky-400'
      }
    },
    result: {
      type: 'collapsible',
      title: 'Search results',
      defaultOpen: false,
      contentType: 'text',
      getContentProps: (result) => ({ content: String(result?.content || ''), format: 'plain' })
    }
  },

  WebFetch: {
    input: {
      type: 'one-line',
      label: 'Fetch',
      getValue: (input) => input.url || '',
      action: 'none',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        border: 'border-sky-400 dark:border-sky-500',
        icon: 'text-sky-500 dark:text-sky-400'
      }
    },
    result: {
      type: 'collapsible',
      title: 'Fetched page',
      defaultOpen: false,
      contentType: 'text',
      getContentProps: (result) => ({ content: String(result?.content || ''), format: 'plain' })
    }
  },

  // ============================================================================
  // FILE OPERATION TOOLS
  // ============================================================================

  Read: {
    input: {
      type: 'one-line',
      label: 'Read',
      getValue: (input) => input.file_path || '',
      action: 'open-file',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        background: '',
        border: 'border-gray-300 dark:border-gray-600',
        icon: 'text-gray-500 dark:text-gray-400'
      }
    },
    result: {
      hidden: true
    }
  },

  Edit: {
    input: {
      type: 'collapsible',
      title: (input) => {
        const filename = input.file_path?.split('/').pop() || input.file_path || 'file';
        return `${filename}`;
      },
      defaultOpen: false,
      contentType: 'diff',
      actionButton: 'none',
      getContentProps: (input) => ({
        oldContent: input.old_string,
        newContent: input.new_string,
        filePath: input.file_path,
        badge: 'Edit',
        badgeColor: 'gray'
      })
    },
    result: {
      hideOnSuccess: true
    }
  },

  Write: {
    input: {
      type: 'collapsible',
      title: (input) => {
        const filename = input.file_path?.split('/').pop() || input.file_path || 'file';
        return `${filename}`;
      },
      defaultOpen: false,
      contentType: 'diff',
      actionButton: 'none',
      getContentProps: (input) => ({
        oldContent: '',
        newContent: input.content,
        filePath: input.file_path,
        badge: 'New',
        badgeColor: 'green'
      })
    },
    result: {
      hideOnSuccess: true
    }
  },

  ApplyPatch: {
    input: {
      type: 'collapsible',
      title: (input) => {
        const filename = input.file_path?.split('/').pop() || input.file_path || 'file';
        return `${filename}`;
      },
      defaultOpen: false,
      contentType: 'diff',
      actionButton: 'none',
      getContentProps: (input) => ({
        oldContent: input.old_string,
        newContent: input.new_string,
        filePath: input.file_path,
        badge: 'Patch',
        badgeColor: 'gray'
      })
    },
    result: {
      hideOnSuccess: true
    }
  },

  // ============================================================================
  // SEARCH TOOLS
  // ============================================================================

  Grep: {
    input: {
      type: 'one-line',
      label: 'Grep',
      getValue: (input) => input.pattern,
      getSecondary: (input) => input.path ? `in ${input.path}` : undefined,
      action: 'jump-to-results',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        secondary: 'text-gray-500 dark:text-gray-400',
        background: '',
        border: 'border-gray-400 dark:border-gray-500',
        icon: 'text-gray-500 dark:text-gray-400'
      }
    },
    result: {
      type: 'collapsible',
      defaultOpen: false,
      title: (result) => {
        const toolData = result.toolUseResult || {};
        const count = toolData.numFiles || toolData.filenames?.length || 0;
        return `Found ${count} ${count === 1 ? 'file' : 'files'}`;
      },
      contentType: 'file-list',
      getContentProps: (result) => {
        const toolData = result.toolUseResult || {};
        return {
          files: toolData.filenames || []
        };
      }
    }
  },

  Glob: {
    input: {
      type: 'one-line',
      label: 'Glob',
      getValue: (input) => input.pattern,
      getSecondary: (input) => input.path ? `in ${input.path}` : undefined,
      action: 'jump-to-results',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        secondary: 'text-gray-500 dark:text-gray-400',
        background: '',
        border: 'border-gray-400 dark:border-gray-500',
        icon: 'text-gray-500 dark:text-gray-400'
      }
    },
    result: {
      type: 'collapsible',
      defaultOpen: false,
      title: (result) => {
        const toolData = result.toolUseResult || {};
        const count = toolData.numFiles || toolData.filenames?.length || 0;
        return `Found ${count} ${count === 1 ? 'file' : 'files'}`;
      },
      contentType: 'file-list',
      getContentProps: (result) => {
        const toolData = result.toolUseResult || {};
        return {
          files: toolData.filenames || []
        };
      }
    }
  },

  // ============================================================================
  // TODO TOOLS
  // ============================================================================

  // Every provider's running checklist normalizes onto this tool — Claude's
  // TodoWrite and its incremental Task tracker, Codex's update_plan and
  // todo_list — so one renderer covers all of them.
  TodoWrite: {
    input: {
      type: 'collapsible',
      // Naming the step in flight makes a collapsed checklist say what the
      // agent is doing right now, not just how far along it is.
      title: (input) => {
        const todos = Array.isArray(input?.todos) ? input.todos : [];
        if (todos.length === 0) {
          return 'Updating checklist';
        }

        const done = todos.filter((todo: any) => todo?.status === 'completed').length;
        const active = todos.find((todo: any) => todo?.status === 'in_progress');
        if (active) {
          return `${String(active.activeForm || active.content)} — ${done}/${todos.length}`;
        }
        return done === todos.length
          ? `Done — ${done}/${todos.length}`
          : `${done}/${todos.length} done`;
      },
      defaultOpen: true,
      contentType: 'todo-list',
      getContentProps: (input) => ({
        todos: input.todos
      })
    },
    // The checklist itself already shows the new state, so a separate
    // acknowledgement row would only repeat it. Failures still surface.
    result: {
      hideOnSuccess: true
    }
  },

  TodoRead: {
    input: {
      type: 'one-line',
      label: 'TodoRead',
      getValue: () => 'reading list',
      action: 'none',
      colorScheme: {
        primary: 'text-gray-500 dark:text-gray-400',
        border: 'border-violet-400 dark:border-violet-500'
      }
    },
    result: {
      type: 'collapsible',
      contentType: 'todo-list',
      getContentProps: (result) => {
        try {
          const content = String(result.content || '');
          let todos = null;
          if (content.startsWith('[')) {
            todos = JSON.parse(content);
          }
          return { todos, isResult: true };
        } catch (e) {
          console.warn('Failed to parse todo list content:', e);
          return { todos: [], isResult: true };
        }
      }
    }
  },

  // ============================================================================
  // TASK TOOLS (TaskCreate, TaskUpdate, TaskList, TaskGet)
  // ============================================================================

  TaskCreate: {
    input: {
      type: 'one-line',
      label: 'Task',
      getValue: (input) => input.subject || 'Creating task',
      getSecondary: (input) => input.status || undefined,
      action: 'none',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        border: 'border-violet-400 dark:border-violet-500',
        icon: 'text-violet-500 dark:text-violet-400'
      }
    },
    result: {
      hideOnSuccess: true
    }
  },

  TaskUpdate: {
    input: {
      type: 'one-line',
      label: 'Task',
      getValue: (input) => {
        const parts = [];
        if (input.taskId) parts.push(`#${input.taskId}`);
        if (input.status) parts.push(input.status);
        if (input.subject) parts.push(`"${input.subject}"`);
        return parts.join(' → ') || 'updating';
      },
      action: 'none',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        border: 'border-violet-400 dark:border-violet-500',
        icon: 'text-violet-500 dark:text-violet-400'
      }
    },
    result: {
      hideOnSuccess: true
    }
  },

  TaskList: {
    input: {
      type: 'one-line',
      label: 'Tasks',
      getValue: () => 'listing tasks',
      action: 'none',
      colorScheme: {
        primary: 'text-gray-500 dark:text-gray-400',
        border: 'border-violet-400 dark:border-violet-500',
        icon: 'text-violet-500 dark:text-violet-400'
      }
    },
    result: {
      type: 'collapsible',
      defaultOpen: true,
      title: 'Task list',
      contentType: 'task',
      getContentProps: (result) => ({
        content: String(result?.content || '')
      })
    }
  },

  TaskGet: {
    input: {
      type: 'one-line',
      label: 'Task',
      getValue: (input) => input.taskId ? `#${input.taskId}` : 'fetching',
      action: 'none',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        border: 'border-violet-400 dark:border-violet-500',
        icon: 'text-violet-500 dark:text-violet-400'
      }
    },
    result: {
      type: 'collapsible',
      defaultOpen: true,
      title: 'Task details',
      contentType: 'task',
      getContentProps: (result) => ({
        content: String(result?.content || '')
      })
    }
  },

  // ============================================================================
  // SUBAGENT TASK TOOL
  // ============================================================================

  // Claude's async subagent tool. A row that actually spawned an agent is
  // rendered by SubagentPanel; this config only supplies the name and preview
  // used by tool grouping.
  Agent: {
    input: {
      type: 'collapsible',
      title: (input) => input.description || input.subagent_type || 'Subagent',
      defaultOpen: false,
      contentType: 'markdown',
      getContentProps: (input) => ({ content: input.prompt || '' })
    },
    result: {
      hideOnSuccess: true
    }
  },

  Task: {
    input: {
      type: 'collapsible',
      title: (input) => {
        const subagentType = input.subagent_type || 'Agent';
        const description = input.description || 'Running task';
        return `Subagent / ${subagentType}: ${description}`;
      },
      defaultOpen: false,
      contentType: 'markdown',
      getContentProps: (input) => {
        // If only prompt exists (and required fields), show just the prompt
        // Otherwise show all available fields
        const hasOnlyPrompt = input.prompt &&
          !input.model &&
          !input.resume;

        if (hasOnlyPrompt) {
          return {
            content: input.prompt || ''
          };
        }

        // Format multiple fields
        const parts = [];

        if (input.model) {
          parts.push(`**Model:** ${input.model}`);
        }

        if (input.prompt) {
          parts.push(`**Prompt:**\n${input.prompt}`);
        }

        if (input.resume) {
          parts.push(`**Resuming from:** ${input.resume}`);
        }

        return {
          content: parts.join('\n\n')
        };
      },
      colorScheme: {
        border: 'border-purple-500 dark:border-purple-400',
        icon: 'text-purple-500 dark:text-purple-400'
      }
    },
    result: {
      type: 'collapsible',
      title: 'Subagent result',
      defaultOpen: false,
      contentType: 'markdown',
      getContentProps: (result) => {
        // Handle agent results which may have complex structure
        if (result && result.content) {
          let content = result.content;
          // If content is a JSON string, try to parse it (agent results may arrive serialized)
          if (typeof content === 'string') {
            try {
              const parsed = JSON.parse(content);
              if (Array.isArray(parsed)) {
                content = parsed;
              }
            } catch {
              // Not JSON — use as-is
              return { content };
            }
          }
          // If content is an array (typical for agent responses with multiple text blocks)
          if (Array.isArray(content)) {
            const textContent = content
              .filter((item: any) => item.type === 'text')
              .map((item: any) => item.text)
              .join('\n\n');
            return { content: textContent || 'No response text' };
          }
          return { content: String(content) };
        }
        // Fallback to string representation
        return { content: String(result || 'No response') };
      }
    }
  },

  // ============================================================================
  // INTERACTIVE TOOLS
  // ============================================================================

  // Both providers normalize the ask-the-user round trip onto this tool —
  // Claude's AskUserQuestion and Codex's request_user_input — and the backend
  // folds the chosen answers into the input, so the question and the answer
  // render as one card instead of a question card and an opaque result blob.
  AskUserQuestion: {
    input: {
      type: 'collapsible',
      // A single answered question puts the choice straight in the header;
      // that is the part the user came back to read.
      title: (input: any) => {
        const questions = Array.isArray(input?.questions) ? input.questions : [];
        const answers = input?.answers || {};
        if (questions.length === 1) {
          const header = questions[0]?.header || 'Question';
          const answer = answers[questions[0]?.question];
          return answer ? `${header} — ${answer}` : header;
        }

        const answered = questions.filter((question: any) => answers[question?.question]).length;
        return answered > 0
          ? `${questions.length} questions — ${answered} answered`
          : `${questions.length} questions`;
      },
      defaultOpen: true,
      contentType: 'question-answer',
      getContentProps: (input: any) => ({
        questions: input.questions || [],
        answers: input.answers || {}
      }),
    },
    // The result only restates the selection the input now carries.
    result: {
      hideOnSuccess: true
    }
  },

  // ============================================================================
  // PLAN TOOLS
  // ============================================================================

  exit_plan_mode: {
    input: {
      type: 'plan',
      title: 'Implementation plan',
      defaultOpen: true,
      contentType: 'markdown',
      getContentProps: (input) => ({
        content: input.plan?.replace(/\\n/g, '\n') || input.plan
      })
    },
    result: {
      hidden: true
    }
  },

  // Also register as ExitPlanMode (the actual tool name used by Claude)
  ExitPlanMode: {
    input: {
      type: 'plan',
      title: 'Implementation plan',
      defaultOpen: true,
      contentType: 'markdown',
      getContentProps: (input) => ({
        content: input.plan?.replace(/\\n/g, '\n') || input.plan
      })
    },
    result: {
      hidden: true
    }
  },

  // An `exec` row only survives translation when nothing in the script was
  // recognized, so show the script as code instead of pretending it is a
  // command that ran.
  exec: {
    input: {
      type: 'collapsible',
      title: 'Sandbox script',
      defaultOpen: false,
      contentType: 'text',
      getContentProps: (input) => ({
        content: typeof input === 'string' ? input : JSON.stringify(input, null, 2),
        format: 'code'
      })
    },
    result: {
      type: 'collapsible',
      title: 'Output',
      contentType: 'text',
      getContentProps: (result) => ({ content: String(result?.content || ''), format: 'plain' })
    }
  },

  // ============================================================================
  // DEFAULT FALLBACK
  // ============================================================================

  Default: {
    input: {
      type: 'collapsible',
      // A tool with no config still deserves a line that says what it did.
      // Every row reading "Parameters" is what made unmapped provider tools
      // unreadable in the transcript.
      title: (input) => summarizeToolInput(input),
      defaultOpen: false,
      contentType: 'text',
      getContentProps: (input) => ({
        content: typeof input === 'string' ? input : JSON.stringify(input, null, 2),
        format: 'code'
      })
    },
    result: {
      type: 'collapsible',
      title: 'Output',
      contentType: 'text',
      getContentProps: (result) => {
        let content = result?.content || '';

        // Handle MCP format: array of objects with type and text fields
        if (typeof content === 'string') {
          try {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) {
              const textParts = parsed
                .filter((p: any) => p.type === 'text' && p.text)
                .map((p: any) => p.text);
              if (textParts.length > 0) {
                content = textParts.join('\n');
              }
            }
          } catch {
            // Not JSON or not MCP format, use as-is
          }
        } else if (Array.isArray(content)) {
          const textParts = content
            .filter((p: any) => p.type === 'text' && p.text)
            .map((p: any) => p.text);
          if (textParts.length > 0) {
            content = textParts.join('\n');
          } else {
            content = JSON.stringify(content, null, 2);
          }
        } else if (typeof content === 'object' && content !== null) {
          content = JSON.stringify(content, null, 2);
        }

        return {
          content: String(content),
          format: 'plain'
        };
      }
    }
  },
  'agy_fast:apply_edits': {
    input: {
      type: 'collapsible',
      label: 'Apply Edits',
      icon: '✎',
      title: (input) => {
        const edits = parseMaybeJsonArray(input?.edits);
        const names = edits.map((e) => shortBasename(e?.path)).filter(Boolean);
        const summary = typeof input?.toolSummary === 'string' ? input.toolSummary.trim() : '';
        if (names.length === 1) {
          return summary ? `${names[0]} — ${summary}` : names[0];
        }
        if (names.length > 1) {
          const head = `${names[0]} +${names.length - 1} files`;
          return summary ? `${head} — ${summary}` : head;
        }
        return summary || 'Atomic edits';
      },
      defaultOpen: false,
      contentType: 'diff',
      actionButton: 'none',
      getContentProps: (input) => {
        const edits = parseMaybeJsonArray(input?.edits);
        const cwd = input?.cwd;
        if (edits.length === 1) {
          const item = edits[0] || {};
          const resolvedPath = resolveWithCwd(item.path, cwd) || 'file';
          if (typeof item.create === 'string') {
            return {
              oldContent: '',
              newContent: item.create,
              filePath: resolvedPath,
              openFilePath: resolvedPath,
              badge: 'New',
              badgeColor: 'green',
            };
          }
          const hunks = parseMaybeJsonArray(item.hunks);
          return {
            oldContent: hunks.map((h) => String(h?.target ?? '')).join('\n\n⋯\n\n'),
            newContent: hunks.map((h) => String(h?.replacement ?? '')).join('\n\n⋯\n\n'),
            filePath: resolvedPath,
            openFilePath: resolvedPath,
            badge: hunks.length > 1 ? `Edit (${hunks.length} hunks)` : 'Edit',
            badgeColor: 'gray',
          };
        }
        const oldParts: string[] = [];
        const newParts: string[] = [];
        let firstResolved = '';
        for (const item of edits) {
          const resolvedPath = resolveWithCwd(item?.path, cwd) || String(item?.path || 'file');
          if (!firstResolved && resolvedPath) firstResolved = resolvedPath;
          const header = `// ── ${item?.path || resolvedPath} ──`;
          if (typeof item?.create === 'string') {
            oldParts.push(header);
            newParts.push(`${header}\n${item.create}`);
          } else {
            const hunks = parseMaybeJsonArray(item?.hunks);
            oldParts.push(`${header}\n${hunks.map((h) => String(h?.target ?? '')).join('\n⋯\n')}`);
            newParts.push(`${header}\n${hunks.map((h) => String(h?.replacement ?? '')).join('\n⋯\n')}`);
          }
        }
        return {
          oldContent: oldParts.join('\n\n'),
          newContent: newParts.join('\n\n'),
          filePath: firstResolved ? `${firstResolved} (+${Math.max(0, edits.length - 1)} files)` : `${edits.length} files`,
          openFilePath: firstResolved || undefined,
          badge: `${edits.length} files`,
          badgeColor: 'gray',
        };
      },
    },
    result: {
      hideOnSuccess: true,
      type: 'collapsible',
      title: 'Verify & Apply Output',
      contentType: 'text',
      getContentProps: (result) => ({
        content: extractMcpTextResult(result),
        format: 'plain',
      }),
    },
  },

  'agy_fast:batch_search': {
    input: {
      type: 'collapsible',
      label: 'Batch Search',
      icon: '⌕',
      title: (input) => {
        const queries = parseMaybeJsonArray(input?.queries);
        const patterns = queries
          .map((q) => (typeof q?.pattern === 'string' ? q.pattern.trim() : ''))
          .filter(Boolean);
        if (patterns.length > 0) {
          const joined = patterns.slice(0, 3).join(', ') + (patterns.length > 3 ? ` (+${patterns.length - 3})` : '');
          return `${queries.length} ${queries.length === 1 ? 'query' : 'queries'}: ${joined.length > 72 ? `${joined.slice(0, 72)}…` : joined}`;
        }
        return summarizeToolInput(input);
      },
      defaultOpen: false,
      contentType: 'text',
      getContentProps: (input) => ({
        content: typeof input === 'string' ? input : JSON.stringify(input, null, 2),
        format: 'code',
      }),
    },
    result: {
      type: 'collapsible',
      defaultOpen: false,
      title: 'Search Results',
      contentType: 'text',
      getContentProps: (result) => ({
        content: extractMcpTextResult(result),
        format: 'plain',
      }),
    },
  },

  'agy_fast:quick_outline': {
    input: {
      type: 'collapsible',
      label: 'Quick Outline',
      icon: '≡',
      title: (input) => {
        const paths = parseMaybeJsonArray(input?.paths).map(shortBasename).filter(Boolean);
        if (paths.length === 1) return paths[0];
        if (paths.length > 1) {
          const shown = paths.slice(0, 3).join(', ');
          return `${paths.length} files: ${shown}${paths.length > 3 ? ` (+${paths.length - 3})` : ''}`;
        }
        return summarizeToolInput(input);
      },
      defaultOpen: false,
      contentType: 'text',
      getContentProps: (input) => {
        const rawPaths = parseMaybeJsonArray(input?.paths);
        const singlePath = rawPaths.length === 1 ? resolveWithCwd(rawPaths[0], input?.cwd) : undefined;
        return {
          content: typeof input === 'string' ? input : JSON.stringify(input, null, 2),
          format: 'code',
          openFilePath: singlePath,
        };
      },
    },
    result: {
      type: 'collapsible',
      defaultOpen: false,
      title: 'Symbol Outlines',
      contentType: 'text',
      getContentProps: (result) => ({
        content: extractMcpTextResult(result),
        format: 'plain',
      }),
    },
  },

  'agy_fast:read_slices': {
    input: {
      type: 'collapsible',
      label: 'Read Slices',
      icon: '§',
      title: (input) => {
        const slices = parseMaybeJsonArray(input?.slices).map((s) => shortBasename(s?.path)).filter(Boolean);
        const outlines = parseMaybeJsonArray(input?.outlines).map(shortBasename).filter(Boolean);
        const ranges = parseMaybeJsonArray(input?.lineRanges).map((r) => shortBasename(String(r).split(':')[0])).filter(Boolean);
        const names = [...new Set([...slices, ...ranges, ...outlines])];
        if (names.length === 1) return names[0];
        if (names.length > 1) return `${names.length} files: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` (+${names.length - 3})` : ''}`;
        return summarizeToolInput(input);
      },
      defaultOpen: false,
      contentType: 'text',
      getContentProps: (input) => ({
        content: typeof input === 'string' ? input : JSON.stringify(input, null, 2),
        format: 'code',
      }),
    },
    result: {
      type: 'collapsible',
      defaultOpen: false,
      title: 'File Slices',
      contentType: 'text',
      getContentProps: (result) => ({
        content: extractMcpTextResult(result),
        format: 'plain',
      }),
    },
  },

  'agy_fast:run_checks': {
    input: {
      type: 'collapsible',
      label: 'Run Checks',
      icon: 'terminal',
      title: (input) => {
        const cmds = parseMaybeJsonArray(input?.commands)
          .map((c) => (typeof c?.name === 'string' && c.name.trim() ? c.name.trim() : typeof c?.command === 'string' ? c.command.trim() : ''))
          .filter(Boolean);
        if (cmds.length > 0) {
          const joined = cmds.slice(0, 2).join(' · ') + (cmds.length > 2 ? ` (+${cmds.length - 2})` : '');
          return `${cmds.length} ${cmds.length === 1 ? 'check' : 'checks'}: ${joined.length > 72 ? `${joined.slice(0, 72)}…` : joined}`;
        }
        return summarizeToolInput(input);
      },
      defaultOpen: false,
      contentType: 'text',
      getContentProps: (input) => ({
        content: typeof input === 'string' ? input : JSON.stringify(input, null, 2),
        format: 'code',
      }),
    },
    result: {
      type: 'collapsible',
      defaultOpen: false,
      title: 'Check Output',
      contentType: 'text',
      getContentProps: (result) => ({
        content: extractMcpTextResult(result),
        format: 'plain',
      }),
    },
  },
};

/**
 * Get configuration for a tool, with fallback to default
 */
export function getToolConfig(toolName: string): ToolDisplayConfig {
  if (TOOL_CONFIGS[toolName]) return TOOL_CONFIGS[toolName];
  const fastKey = normalizeAgyFastToolKey(toolName);
  if (fastKey && TOOL_CONFIGS[fastKey]) return TOOL_CONFIGS[fastKey];
  return TOOL_CONFIGS.Default;
}

/**
 * Check if a tool result should be hidden
 */
export function shouldHideToolResult(toolName: string, toolResult: any): boolean {
  const config = getToolConfig(toolName);

  if (!config.result) return false;

  // Hidden/success-only configs suppress noisy successful output, but errors
  // still need to be visible so failed tool calls are diagnosable.
  if (toolResult?.isError) return false;

  // Surface apply_edits results when an inline verify command produced output or bestEffort noted skipped files.
  if (normalizeAgyFastToolKey(toolName) === 'agy_fast:apply_edits' && toolResult) {
    const text = extractMcpTextResult(toolResult);
    if (/verify|failed|skipped|mismatch/i.test(text)) {
      return false;
    }
  }

  // Always hidden
  if (config.result.hidden) return true;

  // Hide on success only
  if (config.result.hideOnSuccess && toolResult) {
    return true;
  }

  return false;
}
