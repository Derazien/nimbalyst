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
  packageRoot: '',
  rows: [] as Array<{ direction: 'input' | 'output'; content: string; createdAt: Date; metadata?: Record<string, unknown> }>,
  statuses: [] as string[],
  session: { id: 'nim-kimi-1', provider: 'kimi-code-cli', model: 'kimi-code-cli:k3', providerSessionId: undefined as string | undefined },
  flushes: 0,
}));

vi.mock('electron', () => ({
  // getAppPath: the package root, where resources/kimiCliMcpLauncher.cjs lives in development.
  app: { getPath: () => h.userData, getAppPath: () => h.packageRoot, isReady: () => true, isPackaged: false },
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
// The app-wide effort default. kimi's own is "high", so a launch has to walk its picker to get here.
vi.mock('../../../utils/store', () => ({ getAttachmentStagingConfig: () => ({ mode: 'workspace' }), getDefaultEffortLevel: () => 'max' }));

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

function wireRecords(kimiSessionId: string): Array<Record<string, unknown>> {
  const index = fs.readFileSync(path.join(os.homedir(), '.kimi-code', 'session_index.jsonl'), 'utf8')
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as { sessionId: string; sessionDir: string });
  const sessionDir = index.find((entry) => entry.sessionId === kimiSessionId)!.sessionDir;
  return fs.readFileSync(path.join(sessionDir, 'agents', 'main', 'wire.jsonl'), 'utf8')
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

describe.skipIf(!LIVE)('Kimi Code CLI app wiring, live', () => {
  it('launches, submits, persists the transcript, switches model and resumes through the production launcher', async () => {
    h.packageRoot = path.resolve(__dirname, '../../../../..');
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
    // kimi takes no effort on its command line: the launcher walked kimi's
    // picker when the prompt box came up, ahead of this first prompt.
    const firstRequest = wireRecords(h.session.providerSessionId!).find((r) => r.type === 'llm.request');
    record('app turn 1 ran at effort:', firstRequest?.thinkingEffort);
    expect(firstRequest?.thinkingEffort).toBe('max');

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

  // The one proof that writes where the app writes: the real ~/.kimi-code/mcp.json.
  // It adds one launcher entry and takes it back out, and leaves everything else
  // in that file as it found it. Off unless KIMI_LIVE_HOME=1 as well, because
  // that file is the user's own kimi setup.
  it.skipIf(process.env.KIMI_LIVE_HOME !== '1')('names a server in kimi\'s own mcp.json for the launch and takes it back out after', async () => {
    h.packageRoot = path.resolve(__dirname, '../../../../..');
    h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-app-userdata-'));
    h.session = { id: 'nim-kimi-home-1', provider: 'kimi-code-cli', model: 'kimi-code-cli:k3-256k', providerSessionId: undefined };
    h.rows.length = 0;
    h.statuses.length = 0;
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-app-ws-')).replace(/\\/g, '/');
    const homeFile = path.join(os.homedir(), '.kimi-code', 'mcp.json');
    const before = fs.existsSync(homeFile) ? JSON.parse(fs.readFileSync(homeFile, 'utf8')) : null;
    const script = path.join(workspace, 'probe-server.cjs');
    fs.writeFileSync(script, `
      let buffer = '';
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        for (let at = buffer.indexOf('\\n'); at >= 0; at = buffer.indexOf('\\n')) {
          const m = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
          if (m.id === undefined) continue;
          const result = m.method === 'tools/list' ? { tools: [{ name: 'echo_home', description: 'Returns its text prefixed with HOME-OK', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }
            : m.method === 'tools/call' ? { content: [{ type: 'text', text: 'HOME-OK ' + m.params.arguments.text }] }
            : { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } };
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
        }
      });
    `);
    const { ensureKimiCliSession, KimiCliLauncherConfig } = await import('../kimiCliLauncherSingleton');
    const { submitClaudeCliPromptProduction } = await import('../claudeCliSubmitSingleton');
    const { getTerminalSessionManager } = await import('../../TerminalSessionManager');
    const manager = getTerminalSessionManager();
    const sessionId = h.session.id;
    const state = () => manager.getClaudeCliLiveTurnState(sessionId);
    KimiCliLauncherConfig.setMcpConfigLoader(async () => ({
      'nimbalyst-live-probe': { type: 'stdio', command: process.execPath, args: [script] },
    }));

    try {
      expect(await ensureKimiCliSession({ sessionId, workspacePath: workspace, cwd: workspace, model: h.session.model })).toEqual({ success: true });
      const during = JSON.parse(fs.readFileSync(homeFile, 'utf8'));
      record('home entry during the session:', during.mcpServers['nimbalyst-live-probe']);
      expect(JSON.stringify(during.mcpServers['nimbalyst-live-probe'])).toContain('kimiCliMcpLauncher.cjs');

      await waitFor('trust picker or prompt box', async () =>
        (manager.getScrollbackBuffer(sessionId) ?? '').includes('Trust this folder') || (await state()) === 'idle');
      if ((await state()) !== 'idle') manager.writeToTerminal(sessionId, '\r');
      await waitFor('kimi idle at its prompt', async () => (await state()) === 'idle');
      await submitClaudeCliPromptProduction({ sessionId, workspacePath: workspace, prompt: 'Call the tool echo_home with the text "x", then reply with the single word: done' });
      await waitFor('the turn to finish', async () => {
        if ((await state()) === 'waiting_for_input') manager.writeToTerminal(sessionId, '\r');
        return h.statuses.includes('running') && h.statuses.at(-1) === 'idle' && h.rows.some((r) => r.content.includes('output_text'));
      }, 180_000);
      const lines = await transcript(h.rows);
      record('home-file turn transcript:', lines);
      expect(lines.some((l) => l.startsWith('tool mcp__nimbalyst-live-probe__echo_home'))).toBe(true);
      expect(lines.some((l) => l.includes('HOME-OK x'))).toBe(true);
    } finally {
      await manager.destroyTerminal(sessionId);
      KimiCliLauncherConfig.setMcpConfigLoader(null);
      await waitFor('the entry to be taken back out', () => {
        const now = fs.existsSync(homeFile) ? JSON.parse(fs.readFileSync(homeFile, 'utf8')) : null;
        return !now?.mcpServers?.['nimbalyst-live-probe'];
      }, 15_000);
    }
    const after = JSON.parse(fs.readFileSync(homeFile, 'utf8'));
    expect(after).toEqual(before ?? { mcpServers: {} });
  }, 300_000);
});
