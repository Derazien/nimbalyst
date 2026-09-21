// @vitest-environment node
/**
 * Live proof for Kimi Code CLI terminal mode against the REAL `kimi` app.
 * Skipped unless KIMI_LIVE=1: it runs five tiny turns that bill the Kimi
 * account, in throwaway temp folders (kimi runs tools on its own in --yolo).
 *
 * It drives kimi with the same modules the app uses: the spawn config, the
 * session runtime (session discovery + event log + translator), Nimbalyst's
 * CLI submit and Stop escalation, and the Kimi transcript parser. Only
 * Electron's terminal manager is replaced, by node-pty itself.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import * as pty from 'node-pty';
import { resolveKimiLaunch } from '@nimbalyst/runtime/ai/server/providers/kimiLaunch';
import { KimiACPRawParser } from '@nimbalyst/runtime/ai/server/transcript/parsers/KimiACPRawParser';
import { buildKimiCliSpawnConfig, kimiCliModelArg } from '../kimiCliSpawnConfig';
import { KimiCliSessionRuntime, type KimiCliRow } from '../kimiCliSessionRuntime';
import { findKimiSessionDir, kimiSessionIndexPath, kimiWirePath } from '../kimiCliSessionFiles';
import { submitClaudeCliPrompt } from '../claudeCliSubmit';
import { escalateClaudeCliInterrupt } from '../claudeCliInterrupt';
import { switchKimiCliModel } from '../kimiCliModelSwitch';
import { switchKimiCliEffort } from '../kimiCliEffortSwitch';
import { kimiCliPromptForSubmit } from '../kimiCliPromptNote';

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

function launch(workDir: string, opts: { resume?: { kimiSessionId: string; sessionDir: string }; model?: string; extraEnv?: Record<string, string> }) {
  const kimiLaunch = resolveKimiLaunch(KIMI)!;
  const spawnConfig = buildKimiCliSpawnConfig({
    launch: kimiLaunch,
    baseEnv: process.env as Record<string, string>,
    model: opts.model,
    resumeKimiSessionId: opts.resume?.kimiSessionId,
    yolo: true,
    extraEnv: opts.extraEnv,
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

    // 5. Take a thinking effort for this session only, through kimi's own picker.
    const effort = await switchKimiCliEffort({ effort: 'low', model: 'kimi-code-cli:k3-256k' }, {
      write: (d) => second.proc.write(d), delay,
      currentEffort: () => second.runtime.getThinkingEffort(),
      pickerLevels: () => second.runtime.getEffortPickerLevels(),
    });
    record('live effort switch:', effort, second.runtime.getThinkingEffort());
    expect(effort).toEqual({ switched: true, effort: 'low' });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(configBefore);
    const idleBefore = second.log.filter((l) => l.startsWith('state idle (')).length;
    await second.submit('Reply with the single word: ping');
    await waitFor('effort turn to end', () => second.log.filter((l) => l.startsWith('state idle (')).length > idleBefore);
    const requests = fs.readFileSync(kimiWirePath(sessionDir), 'utf8').split(/\r?\n/).filter(Boolean)
      .map((l) => JSON.parse(l)).filter((r) => r.type === 'llm.request');
    record('effort the last request ran at:', requests.at(-1)?.thinkingEffort);
    expect(requests.at(-1)?.thinkingEffort).toBe('low');
    second.runtime.stop();
    second.proc.kill();
  }, 300_000);

  it('gives the terminal kimi its MCP servers through the launcher and the private session file', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-cli-live-mcp-')).replace(/\\/g, '/');
    const launcher = path.resolve(__dirname, '../../../../../resources/kimiCliMcpLauncher.cjs');

    // One stdio server and one shaped like Nimbalyst's own: SSE, bearer token, session in the address.
    const stdioScript = path.join(workDir, 'stdio-server.cjs');
    fs.writeFileSync(stdioScript, `
      let buffer = '';
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        for (let at = buffer.indexOf('\\n'); at >= 0; at = buffer.indexOf('\\n')) {
          const m = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
          if (m.id === undefined) continue;
          const result = m.method === 'tools/list' ? { tools: [{ name: 'echo_stdio', description: 'Returns its text prefixed with STDIO-OK', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }
            : m.method === 'tools/call' ? { content: [{ type: 'text', text: 'STDIO-OK ' + m.params.arguments.text }] }
            : { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'probe-stdio', version: '1' } };
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
        }
      });
    `);
    const seen: string[] = [];
    const streams = new Map<string, http.ServerResponse>();
    const sse = http.createServer((req, res) => {
      const url = new URL(req.url!, 'http://127.0.0.1');
      seen.push(`${req.method} ${url.search} ${req.headers.authorization}`);
      if (req.headers.authorization !== 'Bearer live-token') { res.writeHead(401).end(); return; }
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: endpoint\ndata: /messages?stream=1\n\n');
        streams.set('1', res);
        return;
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(202).end();
        const m = JSON.parse(body);
        if (m.id === undefined) return;
        const result = m.method === 'tools/list' ? { tools: [{ name: 'echo_sse', description: 'Returns its text prefixed with SSE-OK', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }
          : m.method === 'tools/call' ? { content: [{ type: 'text', text: `SSE-OK ${m.params.arguments.text}` }] }
          : { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'probe-sse', version: '1' } };
        streams.get('1')!.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`);
      });
    });
    await new Promise<void>((resolve) => sse.listen(0, '127.0.0.1', resolve));
    const port = (sse.address() as AddressInfo).port;

    // Stands in for Nimbalyst's own core server: the tool the first prompt's note asks for.
    const metaCalls = path.join(workDir, 'meta-calls.jsonl');
    const metaScript = path.join(workDir, 'nimbalyst-server.cjs');
    fs.writeFileSync(metaScript, `
      const fs = require('fs');
      let buffer = '';
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        for (let at = buffer.indexOf('\\n'); at >= 0; at = buffer.indexOf('\\n')) {
          const m = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
          if (m.id === undefined) continue;
          if (m.method === 'tools/call') fs.appendFileSync(${JSON.stringify(metaCalls)}, JSON.stringify(m.params.arguments) + '\\n');
          const result = m.method === 'tools/list' ? { tools: [{ name: 'update_session_meta', description: 'Set this session\\'s name, tags and phase.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, add: { type: 'array', items: { type: 'string' } }, phase: { type: 'string' } } } }] }
            : m.method === 'tools/call' ? { content: [{ type: 'text', text: 'Session metadata updated.' }] }
            : { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'nimbalyst', version: '1' } };
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
        }
      });
    `);

    const sessionFile = path.join(workDir, 'session.mcp.json');
    fs.writeFileSync(sessionFile, JSON.stringify({ mcpServers: {
      nimbalyst: { type: 'stdio', command: process.execPath, args: [metaScript] },
      'probe-stdio': { type: 'stdio', command: process.execPath, args: [stdioScript] },
      'probe-sse': { type: 'sse', url: `http://127.0.0.1:${port}/mcp?sessionId=nimbalyst-live`, headers: { Authorization: 'Bearer live-token' } },
    } }));
    // The app names these in ~/.kimi-code/mcp.json. A test must not write
    // there, so it uses the file kimi reads for this one folder instead. The
    // entries are the same: a server name and the launcher, nothing else.
    fs.mkdirSync(path.join(workDir, '.kimi-code'));
    fs.writeFileSync(path.join(workDir, '.kimi-code', 'mcp.json'), JSON.stringify({ mcpServers: {
      nimbalyst: { command: process.execPath, args: [launcher, 'nimbalyst'] },
      'probe-stdio': { command: process.execPath, args: [launcher, 'probe-stdio'] },
      'probe-sse': { command: process.execPath, args: [launcher, 'probe-sse'] },
    } }));

    const kimi = launch(workDir, { model: 'kimi-code-cli:k3-256k', extraEnv: { NIMBALYST_KIMI_MCP_CONFIG: sessionFile } });
    try {
      await waitFor('kimi prompt box', () => kimi.runtime.getTurnState() === 'idle');
      // kimi connects a folder's servers once the folder is trusted.
      await waitFor('kimi to list the SSE server\'s tools', () => seen.filter((l) => l.startsWith('POST')).length >= 3, 60_000);
      // The first prompt as the app types it: the person's words, then Nimbalyst's note.
      const asked = 'Call the tool echo_stdio with the text "a", then the tool echo_sse with the text "b", then reply with the single word: done';
      await kimi.submit(kimiCliPromptForSubmit(asked, { isFirstPrompt: true, hasNimbalystTools: true }));
      await waitFor('the MCP turn to end', () => {
        // An approval prompt for an MCP tool: answer it as the person would.
        if (kimi.runtime.getTurnState() === 'waiting_for_input') kimi.proc.write('\r');
        return kimi.log.some((l) => l.startsWith('state idle ('));
      }, 180_000);
      await waitFor('rows to settle', () => kimi.rows.some((r) => r.content.includes('output_text')), 10_000);
      const lines = await transcript(kimi.rows);
      record('mcp turn transcript:', lines);
      record('what the SSE server saw:', seen.slice(0, 4));
      expect(lines.some((l) => l.startsWith('tool mcp__probe-stdio__echo_stdio'))).toBe(true);
      expect(lines.some((l) => l.startsWith('tool mcp__probe-sse__echo_sse'))).toBe(true);
      expect(lines.some((l) => l.includes('STDIO-OK a'))).toBe(true);
      expect(lines.some((l) => l.includes('SSE-OK b'))).toBe(true);
      expect(seen[0]).toBe('GET ?sessionId=nimbalyst-live Bearer live-token');

      // kimi has no flag for instructions, so the note on the first prompt is the
      // only thing telling it to name the session. It has to work on the real
      // model, and the person's own words are what the transcript keeps.
      const meta = fs.existsSync(metaCalls) ? fs.readFileSync(metaCalls, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      record('update_session_meta calls:', meta);
      expect(meta.length).toBeGreaterThan(0);
      expect(typeof meta[0].name).toBe('string');
      expect(lines[0]).toBe(`user: ${asked}`);
    } finally {
      kimi.runtime.stop();
      kimi.proc.kill();
      sse.close();
    }
  }, 300_000);
});
