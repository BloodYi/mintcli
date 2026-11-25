import assert from 'node:assert/strict';

import { test } from 'vitest';

import { formatToolDisplayName } from '@/modules/chat/tools/configs/toolConfigs';
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
