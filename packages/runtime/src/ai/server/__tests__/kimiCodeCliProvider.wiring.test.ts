// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { shouldBlockStartedSessionProviderSwitch } from '../types';
import { ModelIdentifier } from '../ModelIdentifier';
import { ProviderFactory } from '../ProviderFactory';
import { ModelRegistry } from '../ModelRegistry';
import { agentCapabilitiesForProviderType } from '../agentCapabilities';
import { KimiCodeCliProvider } from '../providers/KimiCodeCliProvider';
import { KimiCodeProvider } from '../providers/KimiCodeProvider';

/**
 * Phase 0 wiring for the interactive-CLI Kimi provider `kimi-code-cli`.
 * This is the provider ID that (in Phase 1+) runs the genuine `kimi` CLI in
 * the terminal strip on the user's Kimi membership, alongside `kimi-code`
 * (ACP transport). It mirrors the claude-code / claude-code-cli precedent
 * and shares the Kimi model alias namespace.
 */
describe('kimi-code-cli provider wiring (Phase 0)', () => {
  it('locks transport: cannot switch between kimi-code and kimi-code-cli once a session has messages', () => {
    // Switching across the transport axis mid-session must be blocked.
    expect(shouldBlockStartedSessionProviderSwitch('kimi-code', 'kimi-code-cli', true)).toBe(true);
    expect(shouldBlockStartedSessionProviderSwitch('kimi-code-cli', 'kimi-code', true)).toBe(true);
    // No messages yet -> creation-time choice is allowed.
    expect(shouldBlockStartedSessionProviderSwitch('kimi-code', 'kimi-code-cli', false)).toBe(false);
  });

  it('parses model identifiers in the shared Kimi alias namespace', () => {
    const id = ModelIdentifier.parse('kimi-code-cli:k3');
    expect(id.provider).toBe('kimi-code-cli');
    expect(id.model).toBe('k3');
  });

  it('has a parseable default model', () => {
    const id = ModelIdentifier.getDefaultModelId('kimi-code-cli');
    expect(id).toBe('kimi-code-cli:k3');
    expect(() => ModelIdentifier.parse(id)).not.toThrow();
  });

  it('the registry resolves the default model through the provider class', async () => {
    await expect(ModelRegistry.getDefaultModel('kimi-code-cli')).resolves.toBe('kimi-code-cli:k3');
    await expect(ModelRegistry.getDefaultModel('kimi-code')).resolves.toBe('kimi-code:k3');
  });

  it('declares a Phase-0 agent capability entry (nothing enumerable, context reporting like claude-code-cli)', () => {
    expect(agentCapabilitiesForProviderType('kimi-code-cli')).toEqual({
      slashCommands: false,
      skills: false,
      compaction: 'unsupported',
      contextReporting: 'context-window',
    });
  });

  it('the factory can construct a kimi-code-cli provider', () => {
    const provider = ProviderFactory.createProvider('kimi-code-cli', 'wiring-test-session') as unknown as {
      getProviderName(): string;
    };
    expect(provider).toBeTruthy();
    expect(provider.getProviderName()).toBe('kimi-code-cli');
    ProviderFactory.destroyProvider('wiring-test-session', 'kimi-code-cli');
  });

  it('sendMessage is a Phase-1 stub that throws', async () => {
    const provider = new KimiCodeCliProvider();
    await expect(async () => {
      for await (const chunk of provider.sendMessage('hello')) {
        void chunk;
      }
    }).rejects.toThrow(/not yet implemented \(Phase 1\)/);
  });


  it('keeps the kimi-code-cli catalog in step with kimi-code (the two lists are written out separately)', async () => {
    const strip = (models: Array<{ id: string; contextWindow?: number }>) =>
      models.map((m) => ({ alias: ModelIdentifier.parse(m.id).model, contextWindow: m.contextWindow }));
    const cli = await KimiCodeCliProvider.getModels();
    const acp = await KimiCodeProvider.getModels();
    expect(cli.every((m) => m.provider === 'kimi-code-cli')).toBe(true);
    expect(strip(cli)).toEqual(strip(acp));
  });
});
