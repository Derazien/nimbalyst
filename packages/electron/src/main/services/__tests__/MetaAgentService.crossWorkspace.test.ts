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
  AgentMessagesRepository: { list: vi.fn(), create: vi.fn() },
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
  },
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
