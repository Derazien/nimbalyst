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
import { readNodeShimTarget } from '../kimiLaunch';
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

  describe('identity and model catalog', () => {
    it('reports the kimi-code provider name', () => {
      const provider = new KimiCodeProvider({ protocol: makeProtocol([]) as unknown as KimiACPProtocol });
      expect(provider.getProviderName()).toBe('kimi-code');
    });

    it('stores initialize config for later turns', async () => {
      const provider = new KimiCodeProvider({ protocol: makeProtocol([]) as unknown as KimiACPProtocol });
      await provider.initialize({ model: 'kimi-code:kimi-for-coding' });
      expect((provider as any).config.model).toBe('kimi-code:kimi-for-coding');
    });

    it('exposes the static alias catalog with honest names and context windows', async () => {
      const models = await KimiCodeProvider.getModels();
      expect(models.map((m) => m.id)).toEqual([
        'kimi-code:k3',
        'kimi-code:k3-256k',
        'kimi-code:kimi-for-coding',
        'kimi-code:kimi-for-coding-highspeed',
      ]);
      expect(models.every((m) => m.provider === 'kimi-code')).toBe(true);
      expect(models.find((m) => m.id === 'kimi-code:k3')?.contextWindow).toBe(1048576);
      expect(models.find((m) => m.id === 'kimi-code:kimi-for-coding')?.contextWindow).toBe(262144);
    });

    it('uses the registry default model', () => {
      expect(KimiCodeProvider.getDefaultModel()).toBe('kimi-code:k3');
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

    it('destroy() destroys the protocol', () => {
      const protocol = makeProtocol([]);
      const provider = new KimiCodeProvider({ protocol: protocol as unknown as KimiACPProtocol });
      provider.destroy();
      expect(protocol.destroy).toHaveBeenCalledTimes(1);
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
