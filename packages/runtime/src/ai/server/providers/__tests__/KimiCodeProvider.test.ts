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

import { KimiCodeProvider } from '../KimiCodeProvider';
import type { KimiACPProtocol } from '../../protocols/KimiACPProtocol';
import type { ProtocolEvent, ProtocolSession, SessionOptions } from '../../protocols/ProtocolInterface';
import type { StreamChunk } from '../../types';

const WORKSPACE = 'D:\\work\\kimi-test';

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

      expect(protocol.setKimiPath).toHaveBeenCalledWith('D:\\tools\\kimi\\kimi.exe');
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

    it('destroy() destroys the protocol', () => {
      const protocol = makeProtocol([]);
      const provider = new KimiCodeProvider({ protocol: protocol as unknown as KimiACPProtocol });
      provider.destroy();
      expect(protocol.destroy).toHaveBeenCalledTimes(1);
    });
  });
});
