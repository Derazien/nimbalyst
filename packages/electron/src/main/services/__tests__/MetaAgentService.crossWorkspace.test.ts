import { beforeEach, describe, expect, it, vi } from 'vitest';

// Cross-workspace messaging: the session-targeting tools go through
// resolveSessionForCaller, which applies the agent.crossWorkspaceMessaging
// setting. The pure predicate is covered in crossWorkspaceMessaging.test.ts;
// this file guards the wiring: the setting is honoured, the refusal names it,
// and a cross-workspace send_prompt still executes in the TARGET's own cwd.
//
// Mock surface mirrors MetaAgentService.getSessionResultCompact.test.ts.
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { create: vi.fn(), updateMetadata: vi.fn(), get: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { list: vi.fn(), listTail: vi.fn(), create: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/SessionFilesRepository', () => ({
  SessionFilesRepository: { getFilesBySession: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@nimbalyst/runtime/ai/server', () => ({
  SessionManager: class { async initialize() {} },
}));
vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  ModelIdentifier: {
    parse: (id: string) => ({ provider: id.split(':')[0], model: id.split(':')[1], combined: id }),
    tryParse: (id: string) => {
      const i = typeof id === 'string' ? id.indexOf(':') : -1;
      return i > 0 ? { provider: id.slice(0, i), model: id.slice(i + 1) } : null;
    },
    getDefaultModelId: (provider: string) => `${provider}:default`,
  },
}));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ subscribe: vi.fn() }),
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../SyncManager', () => ({ getSyncProvider: () => ({ pushChange: vi.fn() }) }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
const alphaFeatures = vi.fn(() => ({ 'cross-project': false }));
vi.mock('../../utils/store', () => ({
  getDefaultAIModel: () => null,
  getAlphaFeatures: () => alphaFeatures(),
}));
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

// The two runtime bindings of the cross-workspace check.
const settingsGet = vi.fn();
vi.mock('../SettingsService', () => ({
  getSettingsService: () => ({ get: settingsGet }),
}));
const liveWindows = new Set<string>();
vi.mock('../../window/windowState', () => ({
  hasLiveWindowForWorkspace: (path: string) => liveWindows.has(path),
}));

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import { database } from '../../database/PGLiteDatabaseWorker';
import { MetaAgentService } from '../MetaAgentService';

const CALLER = 'meta-1';
const HOME = '/ws/home';
const OTHER = '/ws/other';

const OTHER_SESSION = {
  id: 'child-x',
  title: 'Other project child',
  provider: 'claude-code',
  model: 'claude-code:sonnet',
  workspacePath: OTHER,
  worktreePath: '/wt/other-child',
  createdBySessionId: 'someone-else',
  worktreeId: null,
  metadata: null,
  createdAt: 1,
  updatedAt: 2,
};

function serviceWithAi() {
  const service = MetaAgentService.getInstance() as any;
  service.aiService = {
    queuePromptForSession: vi.fn().mockResolvedValue({ id: 'q1', prompt: 'do it' }),
    triggerQueuedPromptProcessingForSession: vi.fn().mockResolvedValue(undefined),
    respondToInteractivePrompt: vi.fn().mockResolvedValue({ success: true }),
  };
  // Take the real queue path so the execution cwd is observable.
  vi.spyOn(service, 'shouldBypassChildAgentExecutionForTests').mockReturnValue(false);
  return service;
}

describe('MetaAgentService cross-workspace messaging', () => {
  beforeEach(() => {
    settingsGet.mockReset();
    liveWindows.clear();
    vi.mocked(database.query).mockClear();
    vi.mocked(AISessionsRepository.get).mockResolvedValue(OTHER_SESSION as never);
  });

  it('off refuses a session in another workspace and says why, without queueing anything', async () => {
    settingsGet.mockReturnValue('off');
    liveWindows.add(OTHER);
    const service = serviceWithAi();

    await expect(
      service.sendPromptToSession(CALLER, 'child-x', HOME, 'do it'),
    ).rejects.toThrow('Session child-x not found or not allowed across workspaces (crossWorkspaceMessaging=off)');
    expect(service.aiService.queuePromptForSession).not.toHaveBeenCalled();

    await expect(
      service.notifyUserJson(CALLER, HOME, { title: 'Hi', body: 'there', sessionId: 'child-x' }),
    ).rejects.toThrow('crossWorkspaceMessaging=off');
  });

  it('allow reaches a session whose workspace is open and executes in the target cwd', async () => {
    settingsGet.mockReturnValue('allow');
    liveWindows.add(OTHER);
    const service = serviceWithAi();

    const json = await service.sendPromptToSession(CALLER, 'child-x', HOME, 'do it');
    expect(JSON.parse(json)).toMatchObject({ sessionId: 'child-x', queuedPromptId: 'q1', processingTriggered: true });

    // The status lookup and the execution cwd both belong to the TARGET, not the caller.
    expect(vi.mocked(database.query).mock.calls[0][1]).toEqual(['child-x', OTHER]);
    expect(service.aiService.triggerQueuedPromptProcessingForSession).toHaveBeenCalledWith(
      'child-x',
      '/wt/other-child',
      'meta-agent',
    );
  });

  it('allow still refuses a session whose workspace has no live window', async () => {
    settingsGet.mockReturnValue('allow');
    const service = serviceWithAi();

    await expect(
      service.getSessionStatusJson('child-x', HOME, CALLER),
    ).rejects.toThrow('crossWorkspaceMessaging=allow');
  });

  it('creator reaches only the sessions the caller created', async () => {
    settingsGet.mockReturnValue('creator');
    const service = serviceWithAi();

    await expect(
      service.respondToPrompt(HOME, { sessionId: 'child-x', promptId: 'p1', promptType: 'ask_user_question_request', response: {} }, CALLER),
    ).rejects.toThrow('crossWorkspaceMessaging=creator');

    vi.mocked(AISessionsRepository.get).mockResolvedValue({ ...OTHER_SESSION, createdBySessionId: CALLER } as never);
    const json = await service.respondToPrompt(
      HOME,
      { sessionId: 'child-x', promptId: 'p1', promptType: 'ask_user_question_request', response: {} },
      CALLER,
    );
    expect(JSON.parse(json).sessionId).toBe('child-x');
  });
});

/**
 * Spawning INTO another project. The estate had cross-project READ and cross-project WRITE and
 * no cross-project CREATE: every session-targeting tool learned to look past the workspace
 * boundary, and nothing that MAKES a session did. The policy itself is covered in
 * crossWorkspaceMessaging.test.ts; this guards the wiring.
 */
describe('spawning into another project', () => {
  const PARENT = { ...OTHER_SESSION, id: CALLER, workspacePath: HOME, worktreeId: 'wt-home' };

  const spawnService = () => {
    const service = serviceWithAi();
    vi.mocked(AISessionsRepository.get).mockResolvedValue(PARENT as never);
    vi.mocked(database.query).mockResolvedValue({ rows: [{ in_flight: '0', total: '0' }] } as never);
    return service;
  };

  beforeEach(() => {
    // Sibling describe, so the suite-level beforeEach above does not run for these.
    settingsGet.mockReset();
    liveWindows.clear();
    alphaFeatures.mockReturnValue({ 'cross-project': true });
    vi.mocked(AISessionsRepository.create).mockClear();
  });

  it('creates the session in the named project, not the caller one', async () => {
    settingsGet.mockReturnValue('allow');
    liveWindows.add(OTHER);
    await spawnService().spawnSession(CALLER, HOME, { prompt: 'go', project: OTHER });
    expect(vi.mocked(AISessionsRepository.create).mock.calls[0][0]).toMatchObject({ workspaceId: OTHER });
  });

  it('spawns cross-project sessions at the top level, since a workstream cannot span two projects', async () => {
    settingsGet.mockReturnValue('allow');
    liveWindows.add(OTHER);
    await spawnService().spawnSession(CALLER, HOME, { prompt: 'go', project: OTHER });
    const created = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(created.parentSessionId).toBeNull();
    // The caller's worktree belongs to the caller's project; inheriting it would send the new
    // session's edits into a checkout of the wrong repository.
    expect(created.worktreeId).toBeUndefined();
  });

  it('refuses while the experimental toggle is off, naming the toggle', async () => {
    alphaFeatures.mockReturnValue({ 'cross-project': false });
    settingsGet.mockReturnValue('allow');
    liveWindows.add(OTHER);
    await expect(
      spawnService().spawnSession(CALLER, HOME, { prompt: 'go', project: OTHER }),
    ).rejects.toThrow(/Cross-project sessions experimental feature/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('refuses a project with no open window', async () => {
    settingsGet.mockReturnValue('allow');
    await expect(
      spawnService().spawnSession(CALLER, HOME, { prompt: 'go', project: OTHER }),
    ).rejects.toThrow(/not open in a window/);
  });

  it('naming the caller own project stays the ordinary same-project spawn', async () => {
    settingsGet.mockReturnValue('off');
    alphaFeatures.mockReturnValue({ 'cross-project': false });
    const service = spawnService();
    // No worktree on the parent: same-project spawn inherits one, and inheriting needs a
    // database this mock surface deliberately does not provide.
    vi.mocked(AISessionsRepository.get).mockResolvedValue({ ...PARENT, worktreeId: null } as never);
    await service.spawnSession(CALLER, HOME, { prompt: 'go', project: HOME, isolated: true });
    expect(vi.mocked(AISessionsRepository.create).mock.calls[0][0]).toMatchObject({ workspaceId: HOME });
  });

  it('another spelling of the caller own project is still home, filed under the caller key (#1551)', async () => {
    settingsGet.mockReturnValue('off');
    alphaFeatures.mockReturnValue({ 'cross-project': false });
    const service = spawnService();
    vi.mocked(AISessionsRepository.get).mockResolvedValue({ ...PARENT, worktreeId: null } as never);
    await service.spawnSession(CALLER, HOME, { prompt: 'go', project: `${HOME}/`, isolated: true });
    expect(vi.mocked(AISessionsRepository.create).mock.calls[0][0]).toMatchObject({ workspaceId: HOME });
  });

  it('honours an explicit provider, so a spawn is not stuck on the caller model', async () => {
    settingsGet.mockReturnValue('allow');
    liveWindows.add(OTHER);
    await spawnService().spawnSession(CALLER, HOME, {
      prompt: 'go',
      project: OTHER,
      provider: 'openai-codex',
      model: 'openai-codex:gpt-5.5',
    });
    expect(vi.mocked(AISessionsRepository.create).mock.calls[0][0]).toMatchObject({
      provider: 'openai-codex',
      model: 'openai-codex:gpt-5.5',
    });
  });

  it('create_session takes a project the same way', async () => {
    settingsGet.mockReturnValue('allow');
    liveWindows.add(OTHER);
    await spawnService().createChildSession(CALLER, HOME, { prompt: 'go', project: OTHER });
    expect(vi.mocked(AISessionsRepository.create).mock.calls[0][0]).toMatchObject({ workspaceId: OTHER });
  });
});

/**
 * Listing what you spawned elsewhere. Without this, a caller that just spawned into another
 * project has to hold the returned id or lose the session: `list_spawned_sessions` was scoped
 * to one workspace, so the thing it created became invisible the moment it was created.
 */
describe('list_spawned_sessions across projects', () => {
  const ROW = (over: Record<string, unknown> = {}) => ({
    id: 'kid-1',
    title: 'Elsewhere',
    provider: 'claude-code',
    model: 'claude-code:sonnet',
    status: 'idle',
    workspace_id: OTHER,
    created_by_session_id: CALLER,
    last_activity: 1,
    created_at: 1,
    updated_at: 2,
    worktree_id: null,
    agent_role: 'standard',
    ...over,
  });

  const listService = (rows: Array<Record<string, unknown>>) => {
    const service = serviceWithAi();
    vi.mocked(database.query).mockResolvedValue({ rows } as never);
    return service;
  };

  beforeEach(() => {
    settingsGet.mockReset();
    liveWindows.clear();
    alphaFeatures.mockReturnValue({ 'cross-project': true });
    // Sibling describe again, plus the assertions read call[0]: without the clear they see a
    // query from an earlier test.
    vi.mocked(database.query).mockClear();
    // buildSessionResultData walks each row's messages; empty is enough here.
    vi.mocked(AgentMessagesRepository.list).mockResolvedValue([] as never);
    vi.mocked(AgentMessagesRepository.listTail).mockResolvedValue([] as never);
  });

  it('stays scoped to the caller project unless asked otherwise', async () => {
    settingsGet.mockReturnValue('allow');
    const service = listService([]);
    await service.listSpawnedSessionsJson(CALLER, HOME, {});
    expect(vi.mocked(database.query).mock.calls[0][1]).toEqual([HOME, CALLER]);
  });

  it('drops the workspace filter when asked for every project', async () => {
    settingsGet.mockReturnValue('allow');
    const service = listService([]);
    await service.listSpawnedSessionsJson(CALLER, HOME, { allProjects: true });
    expect(vi.mocked(database.query).mock.calls[0][1]).toEqual([CALLER]);
  });

  it('reports which project each session is in, so the id can be acted on', async () => {
    settingsGet.mockReturnValue('allow');
    liveWindows.add(OTHER);
    const service = listService([ROW()]);
    const out = JSON.parse(await service.listSpawnedSessionsJson(CALLER, HOME, { allProjects: true }));
    expect(out[0]).toMatchObject({ sessionId: 'kid-1', project: OTHER });
  });

  it('hides a foreign session the messaging setting would refuse, so listing never exceeds reach', async () => {
    settingsGet.mockReturnValue('off');
    const service = listService([ROW()]);
    const out = JSON.parse(await service.listSpawnedSessionsJson(CALLER, HOME, { allProjects: true }));
    expect(out).toEqual([]);
  });

  it('refuses to widen while the experimental toggle is off', async () => {
    alphaFeatures.mockReturnValue({ 'cross-project': false });
    settingsGet.mockReturnValue('allow');
    const service = listService([]);
    await expect(
      service.listSpawnedSessionsJson(CALLER, HOME, { allProjects: true }),
    ).rejects.toThrow(/Cross-project sessions experimental feature/);
  });
});
