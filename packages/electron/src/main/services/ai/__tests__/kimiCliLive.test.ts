// @vitest-environment node
/**
 * Live proof for Kimi Code CLI terminal mode against the REAL `kimi` app.
 * Skipped unless KIMI_LIVE=1: it runs three tiny turns that bill the Kimi
 * account, in a throwaway temp folder (kimi runs tools on its own in --yolo).
 *
 * It drives kimi with the same modules the app uses: the spawn config, the
 * session runtime (session discovery + event log + translator), Nimbalyst's
 * CLI submit and Stop escalation, and the Kimi transcript parser. Only
 * Electron's terminal manager is replaced, by node-pty itself.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as pty from 'node-pty';
import { resolveKimiLaunch } from '@nimbalyst/runtime/ai/server/providers/kimiLaunch';
import { KimiACPRawParser } from '@nimbalyst/runtime/ai/server/transcript/parsers/KimiACPRawParser';
import { buildKimiCliSpawnConfig, kimiCliModelArg } from '../kimiCliSpawnConfig';
import { KimiCliSessionRuntime, type KimiCliRow } from '../kimiCliSessionRuntime';
import { findKimiSessionDir, kimiSessionIndexPath, kimiWirePath } from '../kimiCliSessionFiles';
import { submitClaudeCliPrompt } from '../claudeCliSubmit';
import { escalateClaudeCliInterrupt } from '../claudeCliInterrupt';
import { switchKimiCliModel } from '../kimiCliModelSwitch';

const LIVE = process.env.KIMI_LIVE === '1';
const KIMI = process.env.KIMI_PATH || path.join(os.homedir(), '.kimi-code', 'bin', 'kimi.exe');
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The suite runs silent, so the evidence goes to a file when KIMI_LIVE_OUT names one. */
function record(label: string, ...values: unknown[]): void {
  if (!process.env.KIMI_LIVE_OUT) return;
  fs.appendFileSync(process.env.KIMI_LIVE_OUT, `${label} ${values.map((v) => JSON.stringify(v, null, 1)).join(' ')}\n`);
}

async function waitFor(what: string, pred: () => boolean, timeoutMs = 90_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await delay(100);
  }
}

function launch(workDir: string, opts: { resume?: { kimiSessionId: string; sessionDir: string }; model?: string }) {
  const kimiLaunch = resolveKimiLaunch(KIMI)!;
  const spawnConfig = buildKimiCliSpawnConfig({
    launch: kimiLaunch,
    baseEnv: process.env as Record<string, string>,
    model: opts.model,
    resumeKimiSessionId: opts.resume?.kimiSessionId,
    yolo: true,
  });
  const log: string[] = [];
  const rows: KimiCliRow[] = [];
  let kimiSessionId: string | null = null;
  const proc = pty.spawn(spawnConfig.executable, spawnConfig.args, {
    name: 'xterm-256color', cols: 120, rows: 40, cwd: workDir, env: spawnConfig.env,
  });
  const runtime = new KimiCliSessionRuntime({
    workDir,
    indexPath: kimiSessionIndexPath(),
    resume: opts.resume,
    launchModel: kimiCliModelArg(opts.model),
    isClaimed: () => false,
    onKimiSessionId: (id) => { kimiSessionId = id; log.push(`kimi session ${id}`); },
    onTurnState: (state, reason) => log.push(`state ${state}${reason ? ` (${reason})` : ''}`),
    onRow: (row) => rows.push(row),
    // Stands in for the person pressing Enter on "Trust this folder" in the drawer.
    onNeedsAttention: () => { log.push('trust picker shown'); proc.write('\r'); },
  });
  proc.onData((data) => runtime.noteTerminalOutput(data));
  runtime.start(100);
  const submit = (prompt: string) => submitClaudeCliPrompt(
    { sessionId: 'live', workspacePath: workDir, prompt },
    {
      writeToTerminal: (_id, data) => proc.write(data),
      logUserPrompt: async () => {},
      sendAnalytics: () => {},
      delay,
      hasTurnStarted: () => runtime.getTurnState() === 'running',
    },
  );
  return { proc, runtime, log, rows, submit, get kimiSessionId() { return kimiSessionId; } };
}

async function transcript(rows: KimiCliRow[]): Promise<string[]> {
  const parser = new KimiACPRawParser();
  const lines: string[] = [];
  let id = 0;
  for (const row of rows) {
    const events = await parser.parseMessage({
      id: ++id, sessionId: 'live', source: 'kimi-code-cli', direction: row.direction,
      content: row.content, createdAt: row.createdAt, metadata: row.metadata,
    }, {
      sessionId: 'live', hasToolCall: () => false, hasSubagent: () => false,
      findByProviderToolCallId: async () => null, findActiveToolCallByRawProviderId: async () => null,
    });
    for (const e of events) {
      if (e.type === 'user_message') lines.push(`user: ${e.text}`);
      else if (e.type === 'assistant_message') lines.push(`assistant: ${e.text}`);
      else if (e.type === 'tool_call_started') lines.push(`tool ${e.toolName}: ${JSON.stringify(e.arguments)}`);
      else if (e.type === 'tool_call_completed') lines.push(`tool result: ${e.result}`);
      else if (e.type === 'system_message') lines.push(`${e.systemType}: ${e.text}`);
    }
  }
  return lines;
}

describe.skipIf(!LIVE)('Kimi Code CLI terminal mode, live', () => {
  it('runs, stops and resumes a real kimi session from Nimbalyst code', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-cli-live-')).replace(/\\/g, '/');

    // 1. Fresh launch, first turn with a tool call.
    const first = launch(workDir, { model: 'kimi-code-cli:k3' });
    await waitFor('kimi prompt box', () => first.runtime.getTurnState() === 'idle');
    await first.submit('Create a file named probe.txt containing exactly: ok. Then reply with the single word: done');
    await waitFor('first turn to end', () => first.log.some((l) => l.startsWith('state idle (')) && first.log.includes('state running'));
    await waitFor('rows to settle', () => first.rows.some((r) => r.content.includes('output_text')), 10_000);
    const firstTranscript = await transcript(first.rows);
    record('turn 1 log:', first.log);
    record('turn 1 transcript:', firstTranscript);
    expect(first.kimiSessionId).toMatch(/^session_/);
    expect(fs.readFileSync(path.join(workDir, 'probe.txt'), 'utf8').trim()).toBe('ok');
    expect(firstTranscript[0]).toMatch(/^user: Create a file named probe\.txt/);
    expect(firstTranscript.some((l) => l.startsWith('tool Write'))).toBe(true);
    expect(firstTranscript.some((l) => l.startsWith('tool result:'))).toBe(true);
    expect(firstTranscript.at(-1)).toMatch(/^assistant: .*done/i);

    // 2. Stop a running turn with Nimbalyst's escalation.
    const rowsBefore = first.rows.length;
    await first.submit('Write the numbers 1 to 400 as English words, one per line. Do not use any tools.');
    await waitFor('second turn to start', () => first.runtime.getTurnState() === 'running');
    await delay(3000);
    const stop = await escalateClaudeCliInterrupt({
      write: (d) => first.proc.write(d),
      kill: (s) => first.proc.kill(s),
      readTurnState: async () => first.runtime.getTurnState(),
    });
    record('stop resolved after:', stop.resolvedAfter, first.log.slice(-2));
    expect(stop.resolvedAfter).toBe('first-interrupt');
    expect(first.log.at(-1)).toBe('state idle (cancelled)');
    record('turn 2 transcript:', await transcript(first.rows.slice(rowsBefore)));
    const kimiSessionId = first.kimiSessionId!;
    first.runtime.stop();
    first.proc.kill();
    await delay(1500);

    // 3. Resume after "restart" on another model.
    const sessionDir = findKimiSessionDir(kimiSessionIndexPath(), kimiSessionId)!;
    const second = launch(workDir, { resume: { kimiSessionId, sessionDir }, model: 'kimi-code-cli:kimi-for-coding-highspeed' });
    await waitFor('resumed prompt box', () => second.runtime.getTurnState() === 'idle');
    await second.submit('Reply with the single word: pong');
    await waitFor('resumed turn to end', () => second.log.some((l) => l.startsWith('state idle (')));
    await waitFor('resumed rows', () => second.rows.some((r) => r.content.includes('output_text')), 10_000);
    const thirdTranscript = await transcript(second.rows);
    record('turn 3 log:', second.log);
    record('turn 3 transcript:', thirdTranscript);
    expect(thirdTranscript).toEqual(['user: Reply with the single word: pong', expect.stringMatching(/^assistant: .*pong/i)]);
    const wire = fs.readFileSync(kimiWirePath(sessionDir), 'utf8');
    const models = [...wire.matchAll(/"type":"llm\.request"[^\n]*?"modelAlias":"([^"]+)"/g)].map((m) => m[1]);
    record('models used per request:', models);
    expect(models.at(-1)).toBe('kimi-code/kimi-for-coding-highspeed');

    // 4. Switch the running session's model for this session only; kimi's global default stays.
    const configPath = path.join(os.homedir(), '.kimi-code', 'config.toml');
    const configBefore = fs.readFileSync(configPath, 'utf8');
    const switched = await switchKimiCliModel({ model: 'kimi-code-cli:k3-256k' }, {
      write: (d) => second.proc.write(d), delay, currentModel: () => second.runtime.getModel(),
    });
    record('live model switch:', switched, second.runtime.getModel());
    expect(switched).toEqual({ switched: true, cliArg: 'kimi-code/k3-256k' });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(configBefore);
    second.runtime.stop();
    second.proc.kill();
  }, 300_000);
});
