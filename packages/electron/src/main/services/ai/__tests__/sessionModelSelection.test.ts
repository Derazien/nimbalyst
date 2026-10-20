// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';
import { resolveSelectionWithDefault, resolveSessionModelSelection } from '../sessionModelSelection';

describe('resolveSelectionWithDefault', () => {
  it('takes the provider from the default model when the creator named neither (mobile, voice, child)', () => {
    expect(resolveSelectionWithDefault({ defaultModel: 'claude-code-cli:opus-1m' })).toEqual({
      provider: 'claude-code-cli',
      model: 'claude-code-cli:opus-1m',
    });
  });

  it('lets an explicit model decide the provider over a stale provider', () => {
    expect(
      resolveSelectionWithDefault({ provider: 'claude-code', model: 'claude-code-cli:sonnet', defaultModel: 'openai-codex:gpt-5.6-sol' }),
    ).toEqual({ provider: 'claude-code-cli', model: 'claude-code-cli:sonnet' });
  });

  it('uses the named provider default when only a provider is given, and claude-code only as the last resort', () => {
    expect(resolveSelectionWithDefault({ provider: 'openai-codex' }).provider).toBe('openai-codex');
    expect(resolveSelectionWithDefault({}).provider).toBe('claude-code');
  });
});

describe('resolveSessionModelSelection', () => {
  it('derives the provider from a provider-qualified Codex model', () => {
    expect(resolveSessionModelSelection('claude-code', 'openai-codex:gpt-5.6-sol')).toEqual({
      provider: 'openai-codex',
      model: 'openai-codex:gpt-5.6-sol',
    });
  });

  it('keeps a matching Claude provider and model', () => {
    expect(resolveSessionModelSelection('claude-code', 'claude-code:sonnet')).toEqual({
      provider: 'claude-code',
      model: 'claude-code:sonnet',
    });
  });

  it('uses the requested provider default when no model is provided', () => {
    const selection = resolveSessionModelSelection('openai-codex');

    expect(selection.provider).toBe('openai-codex');
    expect(selection.model).toBe(ModelIdentifier.getDefaultModelId('openai-codex'));
  });
});
