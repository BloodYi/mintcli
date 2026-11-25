import assert from 'node:assert/strict';

import { test } from 'vitest';

import { formatToolDisplayName, getToolConfig, normalizeAgyFastToolKey, shouldHideToolResult } from '@/modules/chat/tools/configs/toolConfigs';
import { stripProposedPlanEnvelope } from '@/modules/chat/utils/chatFormatting';

test('stripProposedPlanEnvelope removes a complete outer plan envelope', () => {
  assert.equal(
    stripProposedPlanEnvelope('<proposed_plan>\n# Session Timeline\n\nPlan body\n</proposed_plan>'),
    '# Session Timeline\n\nPlan body',
  );
});

test('stripProposedPlanEnvelope removes the opening tag while a plan is streaming', () => {
  assert.equal(
    stripProposedPlanEnvelope('<proposed_plan>\n# Partial plan'),
    '# Partial plan',
  );
});

test('stripProposedPlanEnvelope preserves tags that are not the outer envelope', () => {
  const content = 'Use `<proposed_plan>` only for plans.';
  assert.equal(stripProposedPlanEnvelope(content), content);
});

test('stripProposedPlanEnvelope preserves an unmatched terminal closing tag', () => {
  const content = 'Ordinary text that mentions a terminal tag.\n</proposed_plan>';
  assert.equal(stripProposedPlanEnvelope(content), content);
});

test('formatToolDisplayName normalizes double-underscore, ide-tools wrapped, and native ACP agy-fast MCP tool names', () => {
  assert.equal(formatToolDisplayName('mcp__agy-fast_fast__batch_search'), 'batch_search (agy-fast_fast)');
  assert.equal(formatToolDisplayName('mcp_ide-tools_mcp__agy-fast_fast__apply_edits'), 'apply_edits (agy-fast_fast)');
  assert.equal(formatToolDisplayName('mcp_agy-fast_fast_quick_outline'), 'quick_outline (agy-fast_fast)');
  assert.equal(formatToolDisplayName('agy-fast_fast/run_checks'), 'run_checks (agy-fast_fast)');
});

test('getToolConfig maps agy-fast MCP tools to rich diff/search configs and uses toolSummary fallback', () => {
  assert.equal(normalizeAgyFastToolKey('mcp_ide-tools_mcp__agy-fast_fast__apply_edits'), 'agy_fast:apply_edits');
  const editCfg = getToolConfig('mcp__agy-fast_fast__apply_edits');
  assert.equal(editCfg.input.contentType, 'diff');
  const titleFn = editCfg.input.title as (input: unknown) => string;
  assert.equal(
    titleFn({ cwd: '/opt/app', edits: [{ path: 'src/index.ts' }, { path: 'src/util.ts' }], toolSummary: 'Update entry' }),
    'index.ts +1 files — Update entry',
  );
  const props = editCfg.input.getContentProps?.({
    cwd: '/opt/app',
    edits: [{ path: 'src/index.ts', hunks: [{ target: 'const a = 1;', replacement: 'const a = 2;' }] }],
  });
  assert.equal(props.filePath, '/opt/app/src/index.ts');
  assert.equal(props.openFilePath, '/opt/app/src/index.ts');
  assert.equal(props.oldContent, 'const a = 1;');
  assert.equal(props.newContent, 'const a = 2;');

  // Hide routine success output, but surface verify output
  assert.equal(shouldHideToolResult('mcp__agy-fast_fast__apply_edits', { content: 'Applied edits to 1 file(s)', isError: false }), true);
  assert.equal(shouldHideToolResult('mcp__agy-fast_fast__apply_edits', { content: 'Applied edits\n--- verify (exit 0) ---\nok', isError: false }), false);

  // Unknown MCP tool with toolSummary uses toolSummary instead of raw key names
  const defCfg = getToolConfig('mcp__other_srv__custom_action');
  const defTitle = (defCfg.input.title as (input: unknown) => string)({ cwd: '/home/ubuntu', items: [1, 2], toolSummary: 'Custom batch action' });
  assert.equal(defTitle, 'Custom batch action');
});
