import { beforeEach, describe, expect, it, vi } from 'vitest';

// archive_session / unarchive_session: the meta-agent surface could create sessions and never
// tidy them up. These guard the three things that make the tool safe rather than merely present:
// archiving releases the provider, a session may not archive itself, and the workspace boundary
// is the same one every other session-targeting tool uses.
//
// Mock surface mirrors MetaAgentService.crossWorkspace.test.ts.
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { create: vi.fn(), updateMetadata: vi.fn(), get: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { list: vi.fn(), create: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/SessionFilesRepository', () => ({
  SessionFilesRepository: { getFilesBySession: vi.fn().mockResolvedValue([]) },
}));
const destroyProvider = vi.fn();
vi.mock('@nimbalyst/runtime/ai/server', () => ({
  SessionManager: class { async initialize() {} },
  ProviderFactory: { destroyProvider: (id: string) => destroyProvider(id) },
}));
vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  ModelIdentifier: { parse: (id: string) => ({ provider: id.split(':')[0], model: id.split(':')[1], combined: id }) },
}));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ subscribe: vi.fn() }),
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../SyncManager', () => ({ getSyncProvider: () => ({ pushChange: vi.fn() }) }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/store', () => ({ getDefaultAIModel: () => null }));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (v: unknown) => v }));
vi.mock('../WorktreeStore', () => ({ createWorktreeStore: vi.fn() }));
vi.mock('../GitWorktreeService', () => ({ GitWorktreeService: class {} }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: {} }));
vi.mock('./ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({ setMetaAgentToolFns: vi.fn() }));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({
  extractMessageText: (content: unknown) => (typeof content === 'string' ? content : ''),
  extractUserPrompts: () => [],
}));

const settingsGet = vi.fn();
vi.mock('../SettingsService', () => ({ getSettingsService: () => ({ get: settingsGet }) }));
const liveWindows = new Set<string>();
vi.mock('../../window/windowState', () => ({
  hasLiveWindowForWorkspace: (path: string) => liveWindows.has(path),
}));

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { MetaAgentService } from '../MetaAgentService';

const CALLER = 'meta-1';
const HOME = '/ws/home';
const OTHER = '/ws/other';

const session = (over: Record<string, unknown> = {}) => ({
  id: 'child-x',
  title: 'Anna renewal, Q3',
  provider: 'claude-code',
  model: 'claude-code:sonnet',
  workspacePath: HOME,
  createdBySessionId: CALLER,
  isArchived: false,
  metadata: null,
  createdAt: 1,
  updatedAt: 2,
  ...over,
});

const svc = () => MetaAgentService.getInstance() as never as {
  setSessionArchivedJson: (c: string, w: string, t: string, a: boolean) => Promise<string>;
};

describe('archive_session and unarchive_session', () => {
  beforeEach(() => {
    settingsGet.mockReset();
    settingsGet.mockReturnValue('off');
    liveWindows.clear();
    destroyProvider.mockReset();
    vi.mocked(AISessionsRepository.updateMetadata).mockReset();
    vi.mocked(AISessionsRepository.get).mockResolvedValue(session() as never);
  });

  it('archives and releases the provider, which is half the point of the tool', async () => {
    const out = JSON.parse(await svc().setSessionArchivedJson(CALLER, HOME, 'child-x', true));
    expect(out.ok).toBe(true);
    expect(out.changed).toBe(true);
    expect(out.archived).toBe(true);
    expect(out.providerReleased).toBe(true);
    expect(AISessionsRepository.updateMetadata).toHaveBeenCalledWith('child-x', { isArchived: true });
    expect(destroyProvider).toHaveBeenCalledWith('child-x');
  });

  it('unarchives without starting a provider, leaving that to the next prompt', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue(session({ isArchived: true }) as never);
    const out = JSON.parse(await svc().setSessionArchivedJson(CALLER, HOME, 'child-x', false));
    expect(out.ok).toBe(true);
    expect(out.archived).toBe(false);
    expect(AISessionsRepository.updateMetadata).toHaveBeenCalledWith('child-x', { isArchived: false });
    expect(destroyProvider).not.toHaveBeenCalled();
  });

  it('refuses to let a session archive itself, which would kill the call in flight', async () => {
    const out = JSON.parse(await svc().setSessionArchivedJson(CALLER, HOME, CALLER, true));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/cannot archive itself/i);
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
    expect(destroyProvider).not.toHaveBeenCalled();
  });

  it('is a no-op that says so when the session is already in the asked-for state', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue(session({ isArchived: true }) as never);
    const out = JSON.parse(await svc().setSessionArchivedJson(CALLER, HOME, 'child-x', true));
    expect(out.ok).toBe(true);
    expect(out.changed).toBe(false);
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
    expect(destroyProvider).not.toHaveBeenCalled();
  });

  it('honours the same workspace boundary as every other session-targeting tool', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue(
      session({ workspacePath: OTHER, createdBySessionId: 'someone-else' }) as never,
    );
    liveWindows.add(OTHER);
    await expect(svc().setSessionArchivedJson(CALLER, HOME, 'child-x', true)).rejects.toThrow(
      /crossWorkspaceMessaging=off/,
    );
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
  });

  it('reaches another workspace once the setting allows it', async () => {
    settingsGet.mockReturnValue('allow');
    vi.mocked(AISessionsRepository.get).mockResolvedValue(
      session({ workspacePath: OTHER, createdBySessionId: 'someone-else' }) as never,
    );
    liveWindows.add(OTHER);
    const out = JSON.parse(await svc().setSessionArchivedJson(CALLER, HOME, 'child-x', true));
    expect(out.ok).toBe(true);
    expect(destroyProvider).toHaveBeenCalledWith('child-x');
  });

  it('requires a session id rather than archiving something by accident', async () => {
    const out = JSON.parse(await svc().setSessionArchivedJson(CALLER, HOME, '', true));
    expect(out.ok).toBe(false);
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
  });
});
