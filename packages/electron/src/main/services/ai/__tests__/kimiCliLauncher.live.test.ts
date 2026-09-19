// @vitest-environment node
/**
 * Live proof of the APP wiring for Kimi Code CLI: the production launcher
 * (`ensureKimiCliSession`), the real TerminalSessionManager with node-pty, the
 * real submit path the `claude-cli:submit-prompt` IPC calls, and the real
 * model-switch path of `claude-cli:set-model`, against the real `kimi`.
 * Storage and Electron windows are stubbed; the rows the launcher stores are
 * run through the Kimi transcript parser the app uses.
 *
 * Skipped unless KIMI_LIVE=1 (two tiny billed turns, throwaway temp folder).
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const LIVE = process.env.KIMI_LIVE === '1';
const h = vi.hoisted(() => ({
  userData: '',
  rows: [] as Array<{ direction: 'input' | 'output'; content: string; createdAt: Date; metadata?: Record<string, unknown> }>,
  statuses: [] as string[],
  session: { id: 'nim-kimi-1', provider: 'kimi-code-cli', model: 'kimi-code-cli:k3', providerSessionId: undefined as string | undefined },
  flushes: 0,
}));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, isReady: () => true, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('@nimbalyst/runtime', () => ({
  AgentMessagesRepository: { create: vi.fn(async (row: any) => { h.rows.push(row); }) },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: {
    get: vi.fn(async () => ({ ...h.session })),
    updateMetadata: vi.fn(async (_id: string, meta: { providerSessionId?: string }) => {
      if (meta.providerSessionId) h.session.providerSessionId = meta.providerSessionId;
    }),
  },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository', () => ({
  TranscriptMigrationRepository: { hasService: () => false },
}));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({
    startSession: async (s: { initialStatus?: string }) => { h.statuses.push(`start:${s.initialStatus}`); },
    updateActivity: async (s: { status: string }) => { h.statuses.push(s.status); },
    endSession: async () => { h.statuses.push('end'); },
  }),
}));
vi.mock('../../externalSessions/ExternalSessionService', () => ({ claimExternalSessionForLocalExecution: async () => {} }));
vi.mock('../../PermissionService', () => ({ getPermissionService: () => ({ getPermissionMode: () => 'allow-all' }) }));
vi.mock('../../shellEnvironment', () => ({ getEnhancedPath: () => process.env.PATH ?? '', getShellEnvironment: () => null }));
vi.mock('../../attachments/attachmentStagingRoot', () => ({ resolveAttachmentStagingAllowDirectories: () => [] }));
vi.mock('../HooklessAgentFileWatcher', () => ({
  HooklessAgentFileWatcher: class { ensureForSession = async () => {}; scheduleStop = () => {}; stopForSession = async () => {}; },
}));
vi.mock('../claudeCliQueueFlushSingleton', () => ({ flushNextClaudeCliQueuedPromptForSession: async () => { h.flushes++; return false; } }));
vi.mock('../claudeCliSessionAutoNameSingleton', () => ({ maybeAutoNameClaudeCliSessionProduction: async () => {} }));
vi.mock('../../../window/WindowManager', () => ({ findWindowByWorkspace: () => null }));
vi.mock('../../analytics/AnalyticsService', () => ({ AnalyticsService: { getInstance: () => ({ sendEvent: () => {} }) } }));
vi.mock('../../ClaudeSettingsManager', () => ({ ClaudeSettingsManager: { getInstance: () => ({}) } }));
vi.mock('../../../utils/store', () => ({ getAttachmentStagingConfig: () => ({ mode: 'workspace' }) }));

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(what: string, pred: () => boolean | Promise<boolean>, timeoutMs = 90_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await delay(100);
  }
}
function record(label: string, value: unknown): void {
  if (process.env.KIMI_LIVE_OUT) fs.appendFileSync(process.env.KIMI_LIVE_OUT, `${label} ${JSON.stringify(value, null, 1)}\n`);
}

async function transcript(rows: typeof h.rows): Promise<string[]> {
  const { KimiACPRawParser } = await import('@nimbalyst/runtime/ai/server/transcript/parsers/KimiACPRawParser');
  const parser = new KimiACPRawParser();
  const lines: string[] = [];
  let id = 0;
  for (const row of rows) {
    for (const e of await parser.parseMessage(
      { id: ++id, sessionId: h.session.id, source: 'kimi-code-cli', direction: row.direction, content: row.content, createdAt: row.createdAt, metadata: row.metadata },
      { sessionId: h.session.id, hasToolCall: () => false, hasSubagent: () => false, findByProviderToolCallId: async () => null, findActiveToolCallByRawProviderId: async () => null },
    )) {
      if (e.type === 'user_message') lines.push(`user: ${e.text}`);
      else if (e.type === 'assistant_message') lines.push(`assistant: ${e.text}`);
      else if (e.type === 'tool_call_started') lines.push(`tool ${e.toolName}: ${JSON.stringify(e.arguments)}`);
      else if (e.type === 'tool_call_completed') lines.push(`tool result: ${e.result}`);
      else if (e.type === 'system_message') lines.push(`${e.systemType}: ${e.text}`);
    }
  }
  return lines;
}

describe.skipIf(!LIVE)('Kimi Code CLI app wiring, live', () => {
  it('launches, submits, persists the transcript, switches model and resumes through the production launcher', async () => {
    h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-app-userdata-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-app-ws-')).replace(/\\/g, '/');
    const { ensureKimiCliSession, setKimiCliSessionModel } = await import('../kimiCliLauncherSingleton');
    const { submitClaudeCliPromptProduction } = await import('../claudeCliSubmitSingleton');
    const { getTerminalSessionManager } = await import('../../TerminalSessionManager');
    const manager = getTerminalSessionManager();
    const sessionId = h.session.id;
    const state = () => manager.getClaudeCliLiveTurnState(sessionId);

    // Launch as the drawer does, then answer kimi's first-run trust picker as the person would.
    expect(await ensureKimiCliSession({ sessionId, workspacePath: workspace, cwd: workspace, model: h.session.model })).toEqual({ success: true });
    await waitFor('trust picker or prompt box', async () =>
      (manager.getScrollbackBuffer(sessionId) ?? '').includes('Trust this folder') || (await state()) === 'idle');
    if ((await state()) !== 'idle') manager.writeToTerminal(sessionId, '\r');
    await waitFor('kimi idle at its prompt', async () => (await state()) === 'idle');
    const flushesAtReady = h.flushes;

    // Turn 1, through the same function the submit IPC calls.
    await submitClaudeCliPromptProduction({ sessionId, workspacePath: workspace, prompt: 'Create a file named app-probe.txt containing exactly: ok. Then reply with the single word: done' });
    await waitFor('turn 1 to finish', () => h.statuses.includes('running') && h.statuses.at(-1) === 'idle' && h.rows.some((r) => r.content.includes('output_text')));
    const turn1 = await transcript(h.rows);
    record('app turn 1 statuses:', h.statuses);
    record('app turn 1 stored kimi session id:', h.session.providerSessionId);
    record('app turn 1 transcript from stored rows:', turn1);
    expect(h.session.providerSessionId).toMatch(/^session_/);
    expect(fs.readFileSync(path.join(workspace, 'app-probe.txt'), 'utf8').trim()).toBe('ok');
    expect(turn1[0]).toMatch(/^user: Create a file named app-probe\.txt/);
    expect(turn1.some((l) => l.startsWith('tool Write'))).toBe(true);
    expect(turn1.at(-1)).toMatch(/^assistant: .*done/i);
    expect(h.flushes).toBeGreaterThan(flushesAtReady); // idle drains the queue

    // Model switch, through the same function the set-model IPC calls.
    const switched = await setKimiCliSessionModel(sessionId, 'kimi-code-cli:kimi-for-coding-highspeed');
    record('app model switch:', switched);
    expect(switched).toEqual({ switched: true, cliArg: 'kimi-code/kimi-for-coding-highspeed' });

    // "Restart": the terminal goes away, the next ensure resumes the stored kimi session.
    await manager.destroyTerminal(sessionId);
    await waitFor('terminal gone', () => !manager.isTerminalActive(sessionId), 10_000);
    const rowsBefore = h.rows.length;
    expect(await ensureKimiCliSession({ sessionId, workspacePath: workspace, cwd: workspace, model: 'kimi-code-cli:kimi-for-coding-highspeed' })).toEqual({ success: true });
    try {
      await waitFor('resumed kimi idle', async () => (await state()) === 'idle', 30_000);
    } catch (error) {
      record('resume screen:', (manager.getScrollbackBuffer(sessionId) ?? '').replace(/[[0-9;?<>=]*[ -/]*[@-~]/g, '').slice(-1500));
      throw error;
    }
    await submitClaudeCliPromptProduction({ sessionId, workspacePath: workspace, prompt: 'Reply with the single word: pong' });
    await waitFor('turn 2 to finish', () => h.rows.slice(rowsBefore).some((r) => r.content.includes('output_text')));
    const turn2 = await transcript(h.rows.slice(rowsBefore));
    record('app resumed turn transcript (new rows only):', turn2);
    expect(turn2).toEqual(['user: Reply with the single word: pong', expect.stringMatching(/^assistant: .*pong/i)]);

    await manager.destroyTerminal(sessionId);
  }, 300_000);
});
