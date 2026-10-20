// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '@nimbalyst/runtime';
import { createPGLiteSessionStore } from '../../PGLiteSessionStore';
import {
  ProviderDisabledError,
  resolveEnabledSelection,
  withSessionProviderGuard,
  type SessionProviderGuardSettings,
} from '../sessionProviderGuard';

/** Settings as the user has them: Claude Agent off, Claude Code CLI on and default. */
function settingsFor(overrides: Partial<SessionProviderGuardSettings> & { enabled?: string[] } = {}) {
  const enabled = new Set(overrides.enabled ?? ['claude-code-cli']);
  const log = vi.fn();
  const settings: SessionProviderGuardSettings = {
    isProviderEnabled: (provider) => enabled.has(provider),
    getDefaultModel: () => 'claude-code-cli:opus-1m',
    getDefaultProvider: () => undefined,
    isExtensionProvider: () => false,
    log,
    ...overrides,
  };
  return { settings, log };
}

function fakeStore(existingIds: string[] = []) {
  const create = vi.fn(async () => {});
  const store = {
    create,
    get: vi.fn(async (id: string) => (existingIds.includes(id) ? ({ id } as any) : null)),
  } as unknown as SessionStore;
  return { store, create };
}

const payload = (extra: Record<string, unknown> = {}) => ({
  id: 's1',
  provider: 'claude-code',
  model: 'claude-code:opus-1m',
  workspaceId: '/ws',
  ...extra,
});

describe('session provider guard at the store choke point', () => {
  it('redirects a create on a disabled provider to the configured default and logs it', async () => {
    const { settings, log } = settingsFor();
    const { store, create } = fakeStore();

    await withSessionProviderGuard(store, settings).create(payload() as any);

    expect(create).toHaveBeenCalledTimes(1);
    const persisted = (create.mock.calls[0] as any[])[0];
    expect(persisted.provider).toBe('claude-code-cli');
    expect(persisted.model).toBe('claude-code-cli:opus-1m');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('[provider-guard] requested claude-code is disabled, using claude-code-cli'),
    );
  });

  it('refuses, naming the disabled provider, when no enabled default exists', async () => {
    const { settings } = settingsFor({ enabled: [], getDefaultModel: () => 'claude-code:opus-1m' });
    const { store, create } = fakeStore();

    const attempt = withSessionProviderGuard(store, settings).create(payload() as any);

    await expect(attempt).rejects.toBeInstanceOf(ProviderDisabledError);
    await expect(attempt).rejects.toThrow(/"claude-code" is disabled/);
    expect(create).not.toHaveBeenCalled();
  });

  it('falls back to an explicitly stored default provider when the default model is disabled', async () => {
    const { settings } = settingsFor({
      enabled: ['openai-codex'],
      getDefaultModel: () => 'claude-code:opus-1m',
      getDefaultProvider: () => 'openai-codex',
    });
    const { store, create } = fakeStore();

    await withSessionProviderGuard(store, settings).create(payload() as any);

    expect((create.mock.calls[0] as any[])[0].provider).toBe('openai-codex');
  });

  it('keeps the model when it names a different, enabled provider', async () => {
    const { settings } = settingsFor();
    const { store, create } = fakeStore();

    await withSessionProviderGuard(store, settings).create(
      payload({ model: 'claude-code-cli:sonnet' }) as any,
    );

    const persisted = (create.mock.calls[0] as any[])[0];
    expect(persisted.provider).toBe('claude-code-cli');
    expect(persisted.model).toBe('claude-code-cli:sonnet');
  });

  it('leaves an enabled provider, extension providers, existing rows, imports and branches alone', async () => {
    const { settings, log } = settingsFor({ enabled: ['claude-code-cli'], isExtensionProvider: (p) => p === 'ext-agent' });
    const { store, create } = fakeStore(['existing']);
    const guarded = withSessionProviderGuard(store, settings);

    await guarded.create(payload({ provider: 'claude-code-cli', model: 'claude-code-cli:opus' }) as any);
    await guarded.create(payload({ provider: 'ext-agent', model: undefined }) as any);
    await guarded.create(payload({ id: 'existing' }) as any);
    await guarded.create(payload({ providerConfig: { imported: true } }) as any);
    await guarded.create(payload({ branchedFromSessionId: 'parent' }) as any);

    const providers = create.mock.calls.map((call: any[]) => call[0].provider);
    expect(providers).toEqual(['claude-code-cli', 'ext-agent', 'claude-code', 'claude-code', 'claude-code']);
    expect(log).not.toHaveBeenCalled();
  });

  it('applies to a meta-agent child that inherited a disabled parent provider', () => {
    const { settings } = settingsFor();

    const selection = resolveEnabledSelection(
      { provider: 'claude-code', model: 'claude-code:opus', workspacePath: '/ws' },
      settings,
    );

    expect(selection).toMatchObject({
      provider: 'claude-code-cli',
      model: 'claude-code-cli:opus-1m',
      redirected: true,
    });
  });

  it('persists the redirected provider through the real session store insert', async () => {
    const { settings } = settingsFor();
    const inserts: any[][] = [];
    const db = {
      query: vi.fn(async (sql: string, params: any[] = []) => {
        if (sql.includes('INSERT INTO ai_sessions')) inserts.push(params);
        return { rows: [] };
      }),
    };

    await withSessionProviderGuard(createPGLiteSessionStore(db as any), settings).create(payload() as any);

    expect(inserts).toHaveLength(1);
    // $6 provider, $7 model in the INSERT column order.
    expect(inserts[0][5]).toBe('claude-code-cli');
    expect(inserts[0][6]).toBe('claude-code-cli:opus-1m');
  });
});
