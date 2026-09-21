// @vitest-environment node
/**
 * KimiCodeProvider unit tests with a mock KimiACPProtocol (constructor-injected,
 * like the CopilotCLIProvider deps pattern). Narrow deep-path mocks only --
 * never the @nimbalyst/runtime barrel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { execFileSyncMock, getMcpServersConfigMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  getMcpServersConfigMock: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: execFileSyncMock };
});

vi.mock('../documentContextUtils', () => ({
  buildUserMessageAddition: (message: string) => ({
    userMessageAddition: null,
    messageWithContext: message,
  }),
}));

vi.mock('../workspacePreconditions', () => ({
  describeUnusableWorkspacePath: () => null,
}));

vi.mock('../../services/mcpServerConfig', () => ({
  getMcpConfigService: () => ({ getMcpServersConfig: getMcpServersConfigMock }),
  isInternalMcpServerEnabled: () => false,
  areTrackerToolsEnabled: () => false,
  resolveTrackersWorkspacePath: () => undefined,
}));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { KimiCodeProvider } from '../KimiCodeProvider';
import { BaseAgentProvider } from '../BaseAgentProvider';
import { readNodeShimTarget } from '../kimiLaunch';
import { toKimiSpawnableCommand } from '../kimiMcpCommand';
import { KimiACPProtocol } from '../../protocols/KimiACPProtocol';
import type { ProtocolEvent, ProtocolSession, SessionOptions } from '../../protocols/ProtocolInterface';
import type { StreamChunk } from '../../types';

const WORKSPACE = 'D:\\work\\kimi-test';

/**
 * A real KimiACPProtocol driving the mock kimi agent (the same fixture the
 * protocol suite uses), so provider-level behavior is checked end to end
 * against what actually reaches the agent.
 */
function makeMockAgentHarness() {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-provider-'));
  const auditPath = path.join(workspacePath, 'audit.ndjson');
  const protocol = new KimiACPProtocol(undefined, {
    command: process.execPath,
    args: [fileURLToPath(new URL('../../protocols/__tests__/fixtures/mockKimiAcpAgent.mjs', import.meta.url))],
    env: { KIMI_ACP_TEST_AUDIT_PATH: auditPath },
  });
  const auditMethods = () =>
    fs.existsSync(auditPath)
      ? fs.readFileSync(auditPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).method as string)
      : [];
  return {
    protocol,
    workspacePath,
    auditMethods,
    cleanup: () => {
      protocol.destroy();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

function makeProtocol(events: ProtocolEvent[], session?: Partial<ProtocolSession>) {
  const protocol = {
    createSession: vi.fn(async (_options: SessionOptions): Promise<ProtocolSession> => ({
      id: 'kimi-acp-session-1',
      platform: 'kimi-acp',
      appliedModel: 'kimi-code/k3',
      ...session,
    })),
    resumeSession: vi.fn(async (_sessionId: string, _options: SessionOptions): Promise<ProtocolSession> => ({
      id: 'kimi-acp-session-1',
      platform: 'kimi-acp',
      ...session,
    })),
    forkSession: vi.fn(),
    sendMessage: vi.fn(async function* () {
      for (const event of events) yield event;
    }),
    abortSession: vi.fn(),
    cleanupSession: vi.fn(),
    setKimiPath: vi.fn((_path: string) => {}),
    setProcessEnv: vi.fn((_env: Record<string, string> | undefined) => {}),
    destroy: vi.fn(),
  };
  return protocol;
}

async function collectChunks(provider: KimiCodeProvider): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.sendMessage(
    'write hello.txt',
    undefined,
    'nimbalyst-session-1',
    undefined,
    WORKSPACE,
  )) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('KimiCodeProvider', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue('kimi 0.43.1');
    getMcpServersConfigMock.mockReset();
    getMcpServersConfigMock.mockResolvedValue({});
    KimiCodeProvider.setMCPConfigLoader(null);
    KimiCodeProvider.setShellEnvironmentLoader(null);
    KimiCodeProvider.setEnhancedPathLoader(null);
    KimiCodeProvider.setKimiPathLoader(null);
  });

  afterEach(() => {
    KimiCodeProvider.setMCPConfigLoader(null);
    KimiCodeProvider.setShellEnvironmentLoader(null);
    KimiCodeProvider.setEnhancedPathLoader(null);
    KimiCodeProvider.setKimiPathLoader(null);
    vi.restoreAllMocks();
  });

  describe('turn gating and resume', () => {
    it('refuses a turn in an untrusted workspace before kimi is ever started', async () => {
      const protocol = makeProtocol([{ type: 'complete', content: '' }]);
      const provider = new KimiCodeProvider({ protocol: protocol as unknown as KimiACPProtocol });
      await provider.initialize({ model: 'kimi-code:k3' });
      BaseAgentProvider.setTrustChecker(() => ({ trusted: false, mode: null }));
      try {
        const chunks = await collectChunks(provider);

        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toMatchObject({ type: 'error' });
        expect(chunks[0].error).toMatch(/not trusted/i);
        // Kimi auto-approves its own tool requests, so trust is the only gate:
        // nothing may reach the CLI.
        expect(protocol.setProcessEnv).not.toHaveBeenCalled();
        expect(protocol.createSession).not.toHaveBeenCalled();
        expect(protocol.sendMessage).not.toHaveBeenCalled();
      } finally {
        BaseAgentProvider.setTrustChecker(null);
      }
    });

    it('resumes the kimi session it created on the next turn of the same Nimbalyst session', async () => {
      const protocol = makeProtocol([{ type: 'complete', content: '' }]);
      const provider = new KimiCodeProvider({ protocol: protocol as unknown as KimiACPProtocol });
      await provider.initialize({ model: 'kimi-code:k3' });

      await collectChunks(provider);
      await collectChunks(provider);

      expect(protocol.createSession).toHaveBeenCalledTimes(1);
      expect(protocol.resumeSession).toHaveBeenCalledTimes(1);
      expect(protocol.resumeSession.mock.calls[0][0]).toBe('kimi-acp-session-1');
      expect(provider.getInitData()?.isResumedSession).toBe(true);
    });
  });

  describe('sendMessage', () => {
    it('streams text, tool_call, and complete chunks from protocol events', async () => {
      const events: ProtocolEvent[] = [
        {
          type: 'raw_event',
          metadata: {
            rawEvent: {
              type: 'session/update',
              sessionId: 'kimi-acp-session-1',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
            },
          },
        },
        { type: 'text', content: 'Hello' },
        { type: 'tool_call', toolCall: { id: 'tc-1', name: 'Write', arguments: { file_path: 'D:\\work\\kimi-test\\hello.txt' } } },
        { type: 'complete', content: 'Hello', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
      ];
      const protocol = makeProtocol(events);
      const provider = new KimiCodeProvider({ protocol: protocol as unknown as KimiACPProtocol });
      await provider.initialize({ model: 'kimi-code:k3' });

      const chunks = await collectChunks(provider);

      const types = chunks.map((c) => c.type);
      expect(types).toContain('text');
      expect(types).toContain('tool_call');
      expect(types).toContain('complete');

      const textChunk = chunks.find((c) => c.type === 'text');
      expect(textChunk?.content).toBe('Hello');

      const toolChunk = chunks.find((c) => c.type === 'tool_call');
      expect(toolChunk?.toolCall?.name).toBe('Write');

      const completeChunk = chunks.find((c) => c.type === 'complete');
      expect(completeChunk?.isComplete).toBe(true);
      expect(completeChunk?.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });

      // The provider session id is captured for resume.
      expect(provider.getProviderSessionData('nimbalyst-session-1')?.providerSessionId).toBe('kimi-acp-session-1');
    });

    it('maps the Nimbalyst model id onto the ACP alias and reports the applied model', async () => {
      const protocol = makeProtocol([], { appliedModel: 'kimi-code/kimi-for-coding' });
      const provider = new KimiCodeProvider({ protocol: protocol as unknown as KimiACPProtocol });
      await provider.initialize({ model: 'kimi-code:kimi-for-coding' });

      await collectChunks(provider);

      expect(protocol.createSession).toHaveBeenCalledTimes(1);
      const options = protocol.createSession.mock.calls[0][0];
      expect(options.model).toBe('kimi-code/kimi-for-coding');
      expect(options.workspacePath).toBe(WORKSPACE);
      // The protocol's applied model wins over the requested one.
      expect(provider.getInitData()?.model).toBe('kimi-code/kimi-for-coding');
    });

    it('hands the effort picked in the composer to the ACP session on every turn', async () => {
      const protocol = makeProtocol([]);
      const provider = new KimiCodeProvider({ protocol: protocol as unknown as KimiACPProtocol });
      await provider.initialize({ model: 'kimi-code:k3', effortLevel: 'max' });
      await collectChunks(provider);
      // The composer selection changed between turns.
      await provider.initialize({ model: 'kimi-code:k3', effortLevel: 'low' });
      await collectChunks(provider);

      expect(protocol.createSession.mock.calls[0][0].raw).toMatchObject({ effortLevel: 'max' });
      expect(protocol.resumeSession.mock.calls[0][1].raw).toMatchObject({ effortLevel: 'low' });
    });

    it('consults the MCP config service and delivers servers to the ACP session', async () => {
      getMcpServersConfigMock.mockResolvedValue({ nimbalyst: { type: 'http', url: 'http://127.0.0.1:9999' } });
      const protocol = makeProtocol([]);
      const provider = new KimiCodeProvider({ protocol: protocol as unknown as KimiACPProtocol });
      await provider.initialize({ model: 'kimi-code:k3' });

      await collectChunks(provider);

      expect(getMcpServersConfigMock).toHaveBeenCalledWith({
        sessionId: 'nimbalyst-session-1',
        workspacePath: WORKSPACE,
        profile: 'standard',
      });
      const options = protocol.createSession.mock.calls[0][0];
      expect(Object.keys(options.mcpServers ?? {})).toEqual(['nimbalyst']);
      expect(provider.getInitData()?.mcpServerCount).toBe(1);
    });

    it('configures the protocol from the static DI loaders', async () => {
      KimiCodeProvider.setKimiPathLoader(() => 'D:\\tools\\kimi\\kimi.exe');
      KimiCodeProvider.setShellEnvironmentLoader(() => ({
        MOONSHOT_API_KEY: 'sk-secret',
        KIMI_API_KEY: 'sk-secret-2',
        ANTHROPIC_API_KEY: 'sk-secret-3',
        CUSTOM_FLAG: '1',
      }));
      KimiCodeProvider.setEnhancedPathLoader(() => 'D:\\tools\\kimi');

      const protocol = makeProtocol([]);
      const provider = new KimiCodeProvider({ protocol: protocol as unknown as KimiACPProtocol });
      (provider as any).configureProtocol();

      expect(protocol.setKimiPath).toHaveBeenCalledWith('D:\\tools\\kimi\\kimi.exe', [], {});
      expect(protocol.setProcessEnv).toHaveBeenCalledTimes(1);
      const env = protocol.setProcessEnv.mock.calls[0][0] as Record<string, string>;
      expect(env.CUSTOM_FLAG).toBe('1');
      expect(env.PATH).toBe('D:\\tools\\kimi');
      // API keys are scrubbed per CLAUDE.md -- kimi auth is `kimi login` only.
      expect(env.MOONSHOT_API_KEY).toBeUndefined();
      expect(env.KIMI_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('maps auth failures to an isAuthError chunk naming `kimi login`', async () => {
      const protocol = makeProtocol([]);
      protocol.createSession.mockRejectedValue(
        new Error('session/new failed: {"code":-32000,"message":"authRequired: authentication required"}'),
      );
      const provider = new KimiCodeProvider({ protocol: protocol as unknown as KimiACPProtocol });
      await provider.initialize({ model: 'kimi-code:k3' });

      const chunks = await collectChunks(provider);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].type).toBe('error');
      expect(chunks[0].isAuthError).toBe(true);
      expect(chunks[0].error).toContain('kimi login');
    });

    it('maps protocol-emitted auth error events to isAuthError chunks', async () => {
      const protocol = makeProtocol([
        { type: 'error', error: 'unauthorized: run kimi login' },
      ]);
      const provider = new KimiCodeProvider({ protocol: protocol as unknown as KimiACPProtocol });
      await provider.initialize({ model: 'kimi-code:k3' });

      const chunks = await collectChunks(provider);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].isAuthError).toBe(true);
      expect(chunks[0].error).toContain('kimi login');
    });

    it('reports install instructions when the kimi executable is missing', async () => {
      execFileSyncMock.mockImplementation(() => {
        const err = new Error('spawn kimi ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      });
      const protocol = makeProtocol([]);
      const provider = new KimiCodeProvider({ protocol: protocol as unknown as KimiACPProtocol });
      await provider.initialize({ model: 'kimi-code:k3' });

      const chunks = await collectChunks(provider);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].type).toBe('error');
      expect(chunks[0].error).toContain('@moonshot-ai/kimi-code');
      expect(chunks[0].error).toContain('kimi login');
      // The session is never created when the CLI is absent.
      expect(protocol.createSession).not.toHaveBeenCalled();
    });

    it('yields an error for an unusable workspace without touching the protocol', async () => {
      const protocol = makeProtocol([]);
      const provider = new KimiCodeProvider({ protocol: protocol as unknown as KimiACPProtocol });
      const chunks: StreamChunk[] = [];
      for await (const chunk of provider.sendMessage('hi', undefined, 's1', undefined, undefined)) {
        chunks.push(chunk);
      }
      expect(chunks).toHaveLength(1);
      expect(chunks[0].type).toBe('error');
      expect(protocol.createSession).not.toHaveBeenCalled();
    });

    it('forwards tool results as tool_call chunks so file tracking sees the outcome', async () => {
      const protocol = makeProtocol([
        { type: 'tool_call', toolCall: { id: 'tc-1', name: 'Write', arguments: { path: 'D:\\work\\kimi-test\\hello.txt' } } },
        { type: 'tool_result', toolResult: { id: 'tc-1', name: 'Write', result: { success: true, output: 'Wrote 5 bytes' } } },
        { type: 'complete', content: '' },
      ]);
      const provider = new KimiCodeProvider({ protocol: protocol as unknown as KimiACPProtocol });
      await provider.initialize({ model: 'kimi-code:k3' });

      const chunks = await collectChunks(provider);

      const toolChunks = chunks.filter((c) => c.type === 'tool_call');
      expect(toolChunks).toHaveLength(2);
      expect(toolChunks[1].toolCall).toMatchObject({ id: 'tc-1', name: 'Write', result: { success: true } });
    });

    it('persists the text streamed so far when the turn ends in an error instead of complete', async () => {
      const protocol = makeProtocol([
        { type: 'text', content: 'partial answer' },
        { type: 'error', error: 'kimi fell over' },
      ]);
      const provider = new KimiCodeProvider({ protocol: protocol as unknown as KimiACPProtocol });
      await provider.initialize({ model: 'kimi-code:k3' });
      const logged: string[] = [];
      (provider as any).logAgentMessage = vi.fn(async (_s: string, _p: string, _d: string, content: string) => {
        logged.push(content);
      });

      const chunks = await collectChunks(provider);

      expect(chunks.some((c) => c.type === 'error')).toBe(true);
      // The item.completed row is what the parser renders after a reload;
      // without it the streamed text vanishes from the transcript.
      const completed = logged.filter((c) => c.includes('"item.completed"'));
      expect(completed).toHaveLength(1);
      expect(completed[0]).toContain('partial answer');
    });

    it('builds its protocol with the registered file-write hooks', () => {
      const before = async () => {};
      const after = async () => {};
      KimiCodeProvider.setOnBeforeFileWrite(before);
      KimiCodeProvider.setOnTurnFilesEdited(after);
      try {
        const provider = new KimiCodeProvider();
        const protocol = (provider as any).protocol;
        expect(protocol.onBeforeFileWrite).toBe(before);
        expect(protocol.onTurnFilesEdited).toBe(after);
      } finally {
        KimiCodeProvider.setOnBeforeFileWrite(null);
        KimiCodeProvider.setOnTurnFilesEdited(null);
      }
    });

  });

  describe('Windows npm install (kimi.cmd shim)', () => {
    // What `npm install -g @moonshot-ai/kimi-code` writes on Windows
    // (cmd-shim, npm 10), and pnpm's equivalent.
    const npmShim = (target: string) => [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
      'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
      '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`, '',
    ].join('\r\n');
    const pnpmShim = [
      '@SETLOCAL',
      '@IF EXIST "%~dp0\\node.exe" (',
      '  "%~dp0\\node.exe"  "%~dp0\\global\\5\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs" %*',
      ') ELSE (',
      '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
      '  node  "%~dp0\\global\\5\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs" %*',
      ')',
    ].join('\r\n');

    it('reads the script a Windows npm or pnpm shim launches, relative to the shim', () => {
      expect(readNodeShimTarget(npmShim('node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs'), 'C:\\npm\\kimi.cmd'))
        .toBe(path.win32.join('C:\\npm', 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs'));
      expect(readNodeShimTarget(pnpmShim, 'C:\\pnpm\\kimi.cmd'))
        .toBe(path.win32.join('C:\\pnpm', 'global', '5', 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs'));
      // A batch file that launches no node script is not something we can run.
      expect(readNodeShimTarget('@echo off\r\n"%~dp0\\kimi.exe" %*\r\n', 'C:\\x\\kimi.cmd')).toBeUndefined();
    });

    it.runIf(process.platform === 'win32')('runs a turn when kimi is installed as an npm kimi.cmd shim', async () => {
      const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-npm-prefix-'));
      const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-npm-ws-'));
      const auditPath = path.join(workspacePath, 'audit.ndjson');
      const agentScript = fileURLToPath(new URL('../../protocols/__tests__/fixtures/mockKimiAcpAgent.mjs', import.meta.url));
      const shimPath = path.join(prefix, 'kimi.cmd');
      fs.writeFileSync(shimPath, npmShim(path.relative(prefix, agentScript)));
      // Discovery must not find the real kimi.exe on this machine instead.
      KimiCodeProvider.setKimiPathLoader(() => shimPath);
      const protocol = new KimiACPProtocol(undefined, { env: { KIMI_ACP_TEST_AUDIT_PATH: auditPath } });
      const provider = new KimiCodeProvider({ protocol });
      await provider.initialize({ model: 'kimi-code:k3' });

      try {
        const chunks: StreamChunk[] = [];
        for await (const chunk of provider.sendMessage('Apply the kimi edit', undefined, undefined, undefined, workspacePath)) {
          chunks.push(chunk);
        }

        expect(chunks.filter((c) => c.type === 'error')).toEqual([]);
        expect(chunks.some((c) => c.type === 'complete')).toBe(true);
        expect(fs.readFileSync(auditPath, 'utf8')).toContain('"session/new"');
        // The install check runs the same launch, never the .cmd itself
        // (Node refuses to execFile a batch file: EINVAL).
        expect(String(execFileSyncMock.mock.calls[0]?.[0]).toLowerCase().endsWith('.cmd')).toBe(false);
      } finally {
        protocol.destroy();
        fs.rmSync(prefix, { recursive: true, force: true });
        fs.rmSync(workspacePath, { recursive: true, force: true });
      }
    }, 15000);

    // kimi starts MCP servers without a shell, and Nimbalyst's MCP config turns
    // `npx` into `npx.cmd` on Windows, so every npx-based server the user had
    // configured died in kimi with "spawn EINVAL" (seen live on kimi 2.0.2).
    describe('MCP servers that are batch files', () => {
      // What Node's installer ships as npx.cmd (npm 10).
      const npxBatch = [
        ':: Created by npm, please don\'t edit manually.', '@ECHO OFF', '', 'SETLOCAL', '',
        'SET "NODE_EXE=%~dp0\\node.exe"', 'IF NOT EXIST "%NODE_EXE%" (', '  SET "NODE_EXE=node"', ')', '',
        'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
        'SET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"',
        'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
        '  SET "NPM_PREFIX_NPX_CLI_JS=%%F\\node_modules\\npm\\bin\\npx-cli.js"', ')',
        'IF EXIST "%NPM_PREFIX_NPX_CLI_JS%" (', '  SET "NPX_CLI_JS=%NPM_PREFIX_NPX_CLI_JS%"', ')', '',
        '"%NODE_EXE%" "%NPX_CLI_JS%" %*', '',
      ].join('\r\n');
      const files: Record<string, string> = {
        'C:\\nodejs\\node.exe': '',
        'C:\\nodejs\\npx.cmd': npxBatch,
        'C:\\nodejs\\node_modules\\npm\\bin\\npx-cli.js': '',
        'C:\\npm\\gmail-mcp.cmd': npmShim('node_modules\\gmail-mcp\\dist\\index.js'),
        'C:\\npm\\node_modules\\gmail-mcp\\dist\\index.js': '',
        'C:\\tools\\uvx.exe': '',
        'C:\\tools\\legacy.bat': '@echo off\r\n"%~dp0\\legacy-server.exe" %*\r\n',
      };
      const deps = {
        platform: 'win32' as const,
        pathValue: 'C:\\nodejs;C:\\npm;C:\\tools',
        comSpec: 'C:\\Windows\\System32\\cmd.exe',
        exists: (file: string) => file in files,
        readFile: (file: string) => {
          if (!(file in files)) throw new Error(`ENOENT ${file}`);
          return files[file];
        },
      };

      it('runs npx.cmd and an npm-installed server as node plus the script they launch', () => {
        expect(toKimiSpawnableCommand('npx.cmd', ['-y', 'chrome-devtools-mcp@latest'], deps)).toEqual({
          command: 'C:\\nodejs\\node.exe',
          args: ['C:\\nodejs\\node_modules\\npm\\bin\\npx-cli.js', '-y', 'chrome-devtools-mcp@latest'],
        });
        // No extension, and only a .cmd by that name on PATH: plain spawn says ENOENT.
        expect(toKimiSpawnableCommand('gmail-mcp', [], deps)).toEqual({
          command: 'C:\\nodejs\\node.exe',
          args: ['C:\\npm\\node_modules\\gmail-mcp\\dist\\index.js'],
        });
      });

      it('leaves real executables and other platforms as they are', () => {
        expect(toKimiSpawnableCommand('uvx', ['mcp-server-git'], deps)).toEqual({ command: 'uvx', args: ['mcp-server-git'] });
        expect(toKimiSpawnableCommand('npx.cmd', ['-y', 'x'], { ...deps, platform: 'darwin' }))
          .toEqual({ command: 'npx.cmd', args: ['-y', 'x'] });
      });

      it('runs a batch file that launches no node script through cmd.exe', () => {
        expect(toKimiSpawnableCommand('C:\\tools\\legacy.bat', ['--port', '9'], deps)).toEqual({
          command: 'C:\\Windows\\System32\\cmd.exe',
          args: ['/d', '/s', '/c', 'C:\\tools\\legacy.bat', '--port', '9'],
        });
      });
    });
  });

  describe('against the mock kimi agent', () => {
    it('abort() mid-turn sends session/cancel and ends the stream', async () => {
      const harness = makeMockAgentHarness();
      const provider = new KimiCodeProvider({ protocol: harness.protocol });
      await provider.initialize({ model: 'kimi-code:k3' });

      try {
        const chunks: StreamChunk[] = [];
        // 'never finish' makes the mock agent run until it receives
        // session/cancel; without the cancel this loop never ends.
        for await (const chunk of provider.sendMessage(
          'never finish',
          undefined,
          undefined,
          undefined,
          harness.workspacePath,
        )) {
          chunks.push(chunk);
          if (chunk.type === 'text') {
            provider.abort();
          }
        }

        // session/new in the audit proves the mock agent, not a real kimi, took the turn.
        expect(harness.auditMethods()).toContain('session/new');
        expect(harness.auditMethods()).toContain('session/cancel');
        expect(chunks.some((c) => c.type === 'error')).toBe(false);
      } finally {
        harness.cleanup();
      }
    }, 10000);
  });
});
