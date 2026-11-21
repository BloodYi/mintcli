import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import ModelGroupList from '@/modules/chat/composer/ModelGroupList';
import { groupModelsByThinkingEffort } from '@/modules/chat/utils/modelEffortGroups';
import { Command, CommandList } from '@/shared/ui';
import type { ProviderModelOption } from '@/shared/types';

const AGY_MODELS: ProviderModelOption[] = [
  { value: 'gemini-4-carbon-medium', label: 'Gemini 4 Carbon (Medium)' },
  { value: 'gemini-4-carbon-high', label: 'Gemini 4 Carbon (High)' },
  { value: 'gemini-4-carbon-low', label: 'Gemini 4 Carbon (Low)' },
  { value: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
  { value: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
  { value: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
  { value: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' },
  { value: 'gemini-4-hydrogen-xhigh', label: 'Gemini 4 Hydrogen (XHigh)' },
  { value: 'gemini-4-hydrogen-medium', label: 'Gemini 4 Hydrogen (Medium)' },
  { value: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)' },
  { value: 'gemini-pro-orchestrator', label: 'Orchestrator (Carbon)' },
  { value: 'gemini-pro-orchestrator-argon', label: 'Orchestrator (Argon)' },
  { value: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { value: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
  { value: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
  { value: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
  { value: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
];

const CLAUDE_MODELS: ProviderModelOption[] = [
  {
    value: 'sonnet',
    label: 'Sonnet',
    effort: {
      default: 'high',
      values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
    },
  },
  {
    value: 'opus',
    label: 'Opus',
    effort: {
      default: 'high',
      values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
    },
  },
  {
    value: 'haiku',
    label: 'Haiku',
  },
];

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 });
});

test('groupModelsByThinkingEffort merges same-model variants and sorts thinking efforts', () => {
  const groups = groupModelsByThinkingEffort(AGY_MODELS);
  assert.deepEqual(
    groups.map((group) => group.label),
    [
      'Gemini 4 Carbon',
      'Gemini 4 Argon',
      'Gemini 4 Hydrogen',
      'Orchestrator (Carbon)',
      'Orchestrator (Argon)',
      'Gemini 3.8 Flash',
      'Claude Sonnet 4.6',
      'Claude Opus 4.6',
      'GPT-OSS 120B',
    ],
  );

  const hydrogen = groups.find((group) => group.label === 'Gemini 4 Hydrogen');
  assert.deepEqual(
    hydrogen?.choices.map((choice) => ({ label: choice.label, model: choice.modelValue })),
    [
      { label: 'Low', model: 'gemini-4-hydrogen-low' },
      { label: 'Medium', model: 'gemini-4-hydrogen-medium' },
      { label: 'High', model: 'gemini-4-hydrogen-high' },
      { label: 'XHigh', model: 'gemini-4-hydrogen-xhigh' },
    ],
  );

  const orchestrator = groups.find((group) => group.label === 'Orchestrator (Carbon)');
  assert.equal(orchestrator?.choices.length, 0);
  assert.equal(orchestrator?.directOption?.value, 'gemini-pro-orchestrator');
});

test('groupModelsByThinkingEffort merges non-adjacent variants and raw API slug suffixes', () => {
  const groups = groupModelsByThinkingEffort([
    { value: 'gpt-5.4-high', label: 'gpt-5.4-high' },
    { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
    { value: 'gpt-5.4-low', label: 'gpt-5.4-low' },
    { value: 'claude-sonnet-4-6-thinking', label: 'claude-sonnet-4-6-thinking' },
  ]);

  assert.deepEqual(
    groups.map((group) => ({
      label: group.label,
      efforts: group.choices.map((choice) => choice.label),
    })),
    [
      { label: 'gpt-5.4', efforts: ['Low', 'High'] },
      { label: 'claude-sonnet-4-6', efforts: ['Default', 'Thinking'] },
    ],
  );
});

test('ComposerModelMenu opens second-level thinking list for grouped variant models and selects directly when none exist', () => {
  const chosenModels: string[] = [];
  render(
    <ComposerModelMenu
      effort="default"
      effortOptions={[]}
      onSelectEffort={() => {}}
      model="gemini-3.8-flash-high"
      modelOptions={AGY_MODELS}
      onSelectModel={(next) => chosenModels.push(next)}
      modelsLoading={false}
    />,
  );

  const trigger = screen.getByRole('button', { name: /Select model and reasoning effort|选择模型与思考强度/ });
  assert.match(trigger.textContent ?? '', /Gemini 3\.8 Flash/);
  assert.match(trigger.textContent ?? '', /High/);

  fireEvent.click(trigger);

  // Level 1 shows grouped base model names, never repeating Gemini 4 Hydrogen four times.
  assert.equal(screen.getAllByText('Gemini 4 Hydrogen').length, 1);
  assert.equal(screen.queryByText('Gemini 4 Hydrogen (XHigh)'), null);

  fireEvent.mouseEnter(screen.getByRole('menuitem', { name: /Gemini 4 Hydrogen/ }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'XHigh' }));

  assert.deepEqual(chosenModels, ['gemini-4-hydrogen-xhigh']);

  // Direct model without thinking strength selects in one click.
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Orchestrator (Carbon)' }));
  assert.deepEqual(chosenModels, ['gemini-4-hydrogen-xhigh', 'gemini-pro-orchestrator']);
});

test('ComposerModelMenu handles per-model effort options in second-level submenu and narrow mobile drill-down', () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
  const combinedCalls: Array<{ model: string; effort: string }> = [];
  const effortOnlyCalls: string[] = [];

  render(
    <ComposerModelMenu
      effort="high"
      effortOptions={[{ value: 'low' }, { value: 'medium' }, { value: 'high' }]}
      onSelectEffort={(next) => effortOnlyCalls.push(next)}
      model="sonnet"
      modelOptions={CLAUDE_MODELS}
      onSelectModel={() => {}}
      onSelectModelAndEffort={(nextModel, nextEffort) => {
        combinedCalls.push({ model: nextModel, effort: nextEffort });
      }}
      modelsLoading={false}
    />,
  );

  const trigger = screen.getByRole('button', { name: /Select model and reasoning effort|选择模型与思考强度/ });
  fireEvent.click(trigger);

  // Drill into Opus on narrow screen, then pick Max.
  fireEvent.click(screen.getByRole('menuitem', { name: /Opus/ }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Max' }));
  assert.deepEqual(combinedCalls, [{ model: 'opus', effort: 'max' }]);

  // Reopen, drill into active Sonnet, go back, then re-enter Sonnet and change effort only.
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('menuitem', { name: /Sonnet/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Sonnet' }));
  screen.getByRole('menuitem', { name: /Opus/ });
  fireEvent.click(screen.getByRole('menuitem', { name: /Sonnet/ }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Low' }));
  assert.deepEqual(effortOnlyCalls, ['low']);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('ModelGroupList expands second-level thinking choices when a grouped model is clicked', () => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Element.prototype.scrollIntoView = () => undefined;
  const picks: Array<{ provider: string; model: string; effort?: string }> = [];

  render(
    <Command>
      <CommandList>
        <ModelGroupList
          groups={[
            {
              key: 'antigravity',
              provider: 'antigravity',
              name: 'Antigravity · agy',
              models: AGY_MODELS,
            },
          ]}
          provider="antigravity"
          currentModel="gemini-4-carbon-medium"
          loading={false}
          searching={false}
          onSelect={(provider, model, effort) => picks.push({ provider, model, effort })}
          loadingLabel="Loading…"
        />
      </CommandList>
    </Command>,
  );

  assert.equal(screen.queryByText('XHigh'), null);
  fireEvent.click(screen.getByText('Gemini 4 Hydrogen'));
  fireEvent.click(screen.getByText('XHigh'));
  assert.deepEqual(picks, [{ provider: 'antigravity', model: 'gemini-4-hydrogen-xhigh', effort: undefined }]);
});
