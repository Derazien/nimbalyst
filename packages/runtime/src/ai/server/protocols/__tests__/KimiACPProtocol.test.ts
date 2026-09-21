// @vitest-environment node

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { KimiACPProtocol } from '../KimiACPProtocol';

function fixturePath(): string {
  return fileURLToPath(new URL('./fixtures/mockKimiAcpAgent.mjs', import.meta.url));
}

function auditRows(auditPath: string): Array<{ method: string; params: Record<string, unknown> }> {
  if (!fs.existsSync(auditPath)) {
    return [];
  }
  return fs.readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

interface Harness {
  protocol: KimiACPProtocol;
  workspacePath: string;
  auditPath: string;
  cleanup: () => void;
}

function makeHarness(
  overrides?: {
    env?: Record<string, string>;
    onPermissionRequest?: (request: { toolName: string; options: Array<{ optionId: string }> }) => Promise<{ decision: 'allow' | 'deny'; scope: 'once' | 'session' }>;
    onBeforeFileWrite?: (filePath: string, sessionId: string | undefined) => Promise<void>;
    onTurnFilesEdited?: (filePaths: Set<string>, sessionId: string | undefined) => Promise<void>;
  },
): Harness {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-acp-protocol-'));
  const auditPath = path.join(workspacePath, 'audit.ndjson');
  const protocol = new KimiACPProtocol(undefined, {
    command: process.execPath,
    args: [fixturePath()],
    env: {
      KIMI_ACP_TEST_AUDIT_PATH: auditPath,
      ...overrides?.env,
    },
    onPermissionRequest: overrides?.onPermissionRequest ?? (async () => ({ decision: 'allow', scope: 'once' })),
    onBeforeFileWrite: overrides?.onBeforeFileWrite,
    onTurnFilesEdited: overrides?.onTurnFilesEdited,
  });

  return {
    protocol,
    workspacePath,
    auditPath,
    cleanup: () => {
      protocol.destroy();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

describe('KimiACPProtocol', () => {
  it('applies the requested model through session/set_model and reports appliedModel', async () => {
    const { protocol, workspacePath, auditPath, cleanup } = makeHarness();

    try {
      const session = await protocol.createSession({
        workspacePath,
        model: 'kimi-code:kimi-for-coding',
      });

      expect(session.platform).toBe('kimi-acp');
      expect(session.id.startsWith('session_')).toBe(true);
      // Nimbalyst-style 'kimi-code:kimi-for-coding' maps onto the ACP alias
      // 'kimi-code/kimi-for-coding'.
      expect(session.appliedModel).toBe('kimi-code/kimi-for-coding');

      const rows = auditRows(auditPath);
      const setModel = rows.find((row) => row.method === 'session/set_model');
      expect(setModel?.params).toMatchObject({ sessionId: session.id, modelId: 'kimi-code/kimi-for-coding' });
      // set_model succeeded, so the fallback must not fire.
      expect(rows.some((row) => row.method === 'session/set_config_option')).toBe(false);
    } finally {
      cleanup();
    }
  }, 15000);

  it('reports the current model without a setter call when it is already applied', async () => {
    const { protocol, workspacePath, auditPath, cleanup } = makeHarness();

    try {
      // The fake's picker currentValue is 'kimi-code/k3'; asking for it must
      // not issue session/set_model again.
      const session = await protocol.createSession({
        workspacePath,
        model: 'kimi-code:k3',
      });

      expect(session.appliedModel).toBe('kimi-code/k3');
      const rows = auditRows(auditPath);
      expect(rows.some((row) => row.method === 'session/set_model')).toBe(false);
      expect(rows.some((row) => row.method === 'session/set_config_option')).toBe(false);
    } finally {
      cleanup();
    }
  }, 15000);

  it('falls back to session/set_config_option when session/set_model fails', async () => {
    const { protocol, workspacePath, auditPath, cleanup } = makeHarness({
      env: { KIMI_ACP_TEST_FAIL_SET_MODEL: '1' },
    });

    try {
      const session = await protocol.createSession({
        workspacePath,
        model: 'kimi-code/kimi-for-coding',
      });

      expect(session.appliedModel).toBe('kimi-code/kimi-for-coding');

      const rows = auditRows(auditPath);
      expect(rows.some((row) => row.method === 'session/set_model')).toBe(true);
      const fallback = rows.find((row) => row.method === 'session/set_config_option');
      expect(fallback?.params).toMatchObject({
        sessionId: session.id,
        configId: 'model',
        value: 'kimi-code/kimi-for-coding',
      });
    } finally {
      cleanup();
    }
  }, 15000);

  it('puts the selected effort on the session after the model, and only when it changes', async () => {
    const { protocol, workspacePath, auditPath, cleanup } = makeHarness();
    const thinkingCalls = () => auditRows(auditPath)
      .filter((row) => row.method === 'session/set_config_option' && row.params.configId === 'thinking')
      .map((row) => row.params.value);

    try {
      // kimi puts a session back on the model's default effort when the model
      // changes, so the effort has to land after set_model.
      const session = await protocol.createSession({
        workspacePath,
        model: 'kimi-code:kimi-for-coding',
        raw: { effortLevel: 'max' },
      });
      const methods = auditRows(auditPath).map((row) => row.method);
      expect(methods.indexOf('session/set_model')).toBeLessThan(methods.indexOf('session/set_config_option'));
      expect(thinkingCalls()).toEqual(['max']);

      // Same effort on the next turn: nothing to send.
      await protocol.resumeSession(session.id, { workspacePath, model: 'kimi-code:kimi-for-coding', raw: { effortLevel: 'max' } });
      expect(thinkingCalls()).toEqual(['max']);

      // xhigh is not a level kimi has; it runs at the nearest one below.
      await protocol.resumeSession(session.id, { workspacePath, model: 'kimi-code:kimi-for-coding', raw: { effortLevel: 'xhigh' } });
      expect(thinkingCalls()).toEqual(['max', 'high']);
    } finally {
      cleanup();
    }
  }, 15000);

  it('gives kimi Nimbalyst\'s instructions ahead of the message, again only when they change', async () => {
    // ACP has no system-prompt field. Without this the prompt Nimbalyst builds
    // (session naming, its question tools, trackers) was shown in the UI as sent
    // and never reached kimi, so no Kimi session ever named or tagged itself.
    const { protocol, workspacePath, auditPath, cleanup } = makeHarness();
    const prompts = () => auditRows(auditPath).filter((row) => row.method === 'session/prompt');
    const drain = async (session: Awaited<ReturnType<typeof protocol.createSession>>, content: string) => {
      for await (const _event of protocol.sendMessage(session, { content, sessionId: 'nim-1', mode: 'agent' })) { /* drain */ }
    };

    try {
      const first = await protocol.createSession({ workspacePath, systemPrompt: 'Call update_session_meta early.' });
      await drain(first, 'hello');
      expect(prompts()[0].params.blocks).toEqual(['resource', 'text']);
      expect(prompts()[0].params.resources).toEqual([
        { uri: 'nimbalyst://system-instructions', text: 'Call update_session_meta early.' },
      ]);

      // Same instructions on the next turn: they are already in kimi's history.
      const same = await protocol.resumeSession(first.id, { workspacePath, systemPrompt: 'Call update_session_meta early.' });
      await drain(same, 'again');
      expect(prompts()[1].params.blocks).toEqual(['text']);

      // Changed (trackers switched on, say): kimi gets the new text once.
      const changed = await protocol.resumeSession(first.id, { workspacePath, systemPrompt: 'Call update_session_meta early. Trackers are on.' });
      await drain(changed, 'third');
      expect(prompts()[2].params.resources).toEqual([
        { uri: 'nimbalyst://system-instructions', text: 'Call update_session_meta early. Trackers are on.' },
      ]);
    } finally {
      cleanup();
    }
  }, 20000);

  it('leaves kimi on its own effort when none is selected or the model has no levels', async () => {
    const { protocol, workspacePath, auditPath, cleanup } = makeHarness();

    try {
      await protocol.createSession({ workspacePath, model: 'kimi-code:k3' });
      // The composer shows no effort selector for this model, so an app-wide
      // default must not reach it either.
      await protocol.createSession({
        workspacePath,
        model: 'kimi-code:kimi-for-coding-highspeed',
        raw: { effortLevel: 'max' },
      });
      expect(auditRows(auditPath).some((row) => row.method === 'session/set_config_option')).toBe(false);
    } finally {
      cleanup();
    }
  }, 15000);

  it.runIf(process.platform === 'win32')('hands kimi a batch-file MCP server as node plus its script, never the .cmd', async () => {
    // kimi starts MCP servers without a shell; on Windows a .cmd then fails
    // with EINVAL, which took out every npx-based server the user configured.
    const { protocol, workspacePath, auditPath, cleanup } = makeHarness();
    const shimDir = path.join(workspacePath, 'npm');
    fs.mkdirSync(path.join(shimDir, 'node_modules', 'some-mcp'), { recursive: true });
    fs.writeFileSync(path.join(shimDir, 'node_modules', 'some-mcp', 'cli.js'), '');
    fs.writeFileSync(path.join(shimDir, 'some-mcp.cmd'), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\some-mcp\\cli.js" %*\r\n');

    try {
      await protocol.createSession({
        workspacePath,
        mcpServers: { 'some-mcp': { command: path.join(shimDir, 'some-mcp.cmd'), args: ['--stdio'], env: { TOKEN: 't' } } },
      });
      const delivered = auditRows(auditPath).find((row) => row.method === 'session/new')?.params.mcpServers as
        Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }>;
      expect(delivered).toHaveLength(1);
      expect(delivered[0].command.toLowerCase().endsWith('.cmd')).toBe(false);
      expect(delivered[0].args).toEqual([path.win32.join(shimDir, 'node_modules', 'some-mcp', 'cli.js'), '--stdio']);
      expect(delivered[0].env).toContainEqual({ name: 'TOKEN', value: 't' });
    } finally {
      cleanup();
    }
  }, 15000);

  it('streams text, tool_call, tool_result, usage, and complete in order, and round-trips the permission choice', async () => {
    const { protocol, workspacePath, auditPath, cleanup } = makeHarness({
      onPermissionRequest: async () => ({ decision: 'allow', scope: 'session' }),
    });

    try {
      const session = await protocol.createSession({ workspacePath });

      const events: any[] = [];
      for await (const event of protocol.sendMessage(session, {
        content: 'Apply the kimi edit',
      })) {
        events.push(event);
      }

      // Required ordering, allowing repeats (a permission preview tool_call)
      // and interleaved raw_event entries.
      const order = ['text', 'tool_call', 'tool_result', 'usage', 'complete'];
      let cursor = 0;
      for (const event of events) {
        if (event.type === order[cursor]) {
          cursor += 1;
        }
      }
      expect(cursor).toBe(order.length);

      expect(events.some((event) => event.type === 'reasoning' && event.content === 'thinking about the edit')).toBe(true);
      expect(events.some((event) => event.type === 'text' && event.content === 'Kimi turn started')).toBe(true);
      expect(events.some((event) => event.type === 'text' && event.content === 'Kimi turn done')).toBe(true);

      // Real kimi announces a tool with a bare title first and sends the
      // arguments in a later in_progress update. The card must carry those
      // arguments, and only one tool_call may be emitted for the call.
      const toolCalls = events.filter((event) => event.type === 'tool_call' && event.toolCall?.id === '0:tool_kimi_write_1');
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].toolCall?.name).toBe('Write');
      expect(toolCalls[0].toolCall?.arguments?.content).toBe('after from kimi\n');
      // kimi's rawInput path is relative to the session cwd; the absolute
      // locations[] path wins, normalized to the platform's separators, so
      // file tracking can resolve it inside the workspace.
      expect(toolCalls[0].toolCall?.arguments?.path).toBe(path.join(workspacePath, 'kimi-target.txt'));

      const toolResult = events.find((event) => event.type === 'tool_result');
      expect(toolResult?.toolResult?.id).toBe('0:tool_kimi_write_1');
      // A progress title ("Writing kimi-target.txt") never replaces the tool name.
      expect(toolResult?.toolResult?.name).toBe('Write');
      expect(toolResult?.toolResult?.result?.success).toBe(true);
      expect(toolResult?.toolResult?.result?.output).toBe('Wrote 16 bytes to kimi-target.txt');

      const usage = events.find((event) => event.type === 'usage');
      expect(usage?.contextFillTokens).toBe(123);
      expect(usage?.contextWindow).toBe(256000);

      const complete = events.find((event) => event.type === 'complete');
      expect(complete?.metadata?.stopReason).toBe('end_turn');
      expect(complete?.content).toBe('Kimi turn startedKimi turn done');
      expect(complete?.contextFillTokens).toBe(123);
      expect(complete?.contextWindow).toBe(256000);

      // Transcript persistence: raw ACP notifications ride along as raw_event.
      expect(events.some((event) => event.type === 'raw_event' && event.metadata?.rawEvent?.type === 'session/update')).toBe(true);
      expect(events.some((event) => event.type === 'raw_event' && event.metadata?.rawEvent?.type === 'session/request_permission')).toBe(true);

      // scope 'session' maps to kimi's approve_always, and the choice reached
      // the agent.
      const permissionResponse = auditRows(auditPath).find((row) => row.method === 'session/request_permission:response');
      expect(permissionResponse?.params).toMatchObject({ outcome: 'selected', optionId: 'approve_always' });
    } finally {
      cleanup();
    }
  }, 15000);

  it('maps a denied permission request to kimi\'s reject option and a failed tool result', async () => {
    const { protocol, workspacePath, auditPath, cleanup } = makeHarness({
      onPermissionRequest: async () => ({ decision: 'deny', scope: 'once' }),
    });

    try {
      const session = await protocol.createSession({ workspacePath });

      const events: any[] = [];
      for await (const event of protocol.sendMessage(session, {
        content: 'Reject the kimi edit',
      })) {
        events.push(event);
      }

      const toolResult = events.find((event) => event.type === 'tool_result');
      expect(toolResult?.toolResult?.result?.success).toBe(false);
      expect(fs.existsSync(path.join(workspacePath, 'kimi-target.txt'))).toBe(false);

      const permissionResponse = auditRows(auditPath).find((row) => row.method === 'session/request_permission:response');
      expect(permissionResponse?.params).toMatchObject({ outcome: 'selected', optionId: 'reject' });
    } finally {
      cleanup();
    }
  }, 15000);

  it('answers cancelled, never an approval, when a denied request offers no reject option', async () => {
    const { protocol, workspacePath, auditPath, cleanup } = makeHarness({
      env: { KIMI_ACP_TEST_NO_REJECT_OPTION: '1' },
      onPermissionRequest: async () => ({ decision: 'deny', scope: 'once' }),
    });

    try {
      const session = await protocol.createSession({ workspacePath });
      for await (const event of protocol.sendMessage(session, { content: 'Reject the kimi edit' })) {
        void event;
      }

      const permissionResponse = auditRows(auditPath).find((row) => row.method === 'session/request_permission:response');
      expect(permissionResponse?.params).toMatchObject({ outcome: 'cancelled', optionId: null });
      expect(fs.existsSync(path.join(workspacePath, 'kimi-target.txt'))).toBe(false);
    } finally {
      cleanup();
    }
  }, 15000);

  it('cancels a permission request that is still waiting on the user when the turn is aborted', async () => {
    const controller = new AbortController();
    const { protocol, workspacePath, auditPath, cleanup } = makeHarness({
      // The user never answers; Stop is pressed while the prompt is open.
      onPermissionRequest: () => {
        controller.abort();
        return new Promise(() => {});
      },
    });

    try {
      const session = await protocol.createSession({ workspacePath });
      const events: any[] = [];
      for await (const event of protocol.sendMessage(session, {
        content: 'Apply the kimi edit',
        abortSignal: controller.signal,
      })) {
        events.push(event);
      }

      const rows = auditRows(auditPath);
      const permissionResponse = rows.find((row) => row.method === 'session/request_permission:response');
      expect(permissionResponse?.params).toMatchObject({ outcome: 'cancelled' });
      expect(rows.some((row) => row.method === 'session/cancel')).toBe(true);
      expect(events.find((event) => event.type === 'complete')?.metadata?.stopReason).toBe('cancelled');
      expect(fs.existsSync(path.join(workspacePath, 'kimi-target.txt'))).toBe(false);
    } finally {
      cleanup();
    }
  }, 15000);

  it('captures a pre-edit baseline and reports the edited file on fs/write_text_file', async () => {
    const editedFiles: string[] = [];
    let preEditContent: string | undefined;
    let preEditPath: string | undefined;
    const { protocol, workspacePath, cleanup } = makeHarness({
      onBeforeFileWrite: async (filePath) => {
        preEditPath = filePath;
        preEditContent = fs.readFileSync(filePath, 'utf-8');
      },
      onTurnFilesEdited: async (filePaths) => {
        editedFiles.push(...filePaths);
      },
    });
    const targetPath = path.join(workspacePath, 'kimi-target.txt');
    fs.writeFileSync(targetPath, 'before from kimi\n', 'utf-8');

    try {
      const session = await protocol.createSession({ workspacePath });

      for await (const event of protocol.sendMessage(session, {
        content: 'Apply the kimi edit',
      })) {
        void event;
      }

      expect(preEditContent).toBe('before from kimi\n');
      expect(fs.readFileSync(targetPath, 'utf-8')).toBe('after from kimi\n');
      // kimi sends forward-slash paths on every platform; the hooks (history
      // tags, session_files) key on native paths, so they get normalized ones.
      expect(preEditPath).toBe(targetPath);
      expect(editedFiles).toContain(targetPath);
    } finally {
      cleanup();
    }
  }, 15000);

  it('resumeSession suppresses replayed history updates', async () => {
    const { protocol, workspacePath, auditPath, cleanup } = makeHarness();

    try {
      const created = await protocol.createSession({ workspacePath });

      // Force the loadSession path: the adapter must not consider the session
      // known, while the fake agent still has it.
      (protocol as unknown as { knownSessionIds: Set<string> }).knownSessionIds.delete(created.id);

      const resumed = await protocol.resumeSession(created.id, { workspacePath });
      expect(resumed.id).toBe(created.id);
      expect(auditRows(auditPath).some((row) => row.method === 'session/load')).toBe(true);

      const events: any[] = [];
      for await (const event of protocol.sendMessage(resumed, {
        content: 'Apply the kimi edit',
      })) {
        events.push(event);
      }

      // The replayed chunk from session/load must not leak into the new turn.
      expect(events.some((event) => event.type === 'text' && event.content === 'replayed history')).toBe(false);
      expect(events.some((event) => event.type === 'text' && event.content === 'Kimi turn started')).toBe(true);
    } finally {
      cleanup();
    }
  }, 15000);

  it('falls back to a new session when session/load reports an unknown session', async () => {
    const { protocol, workspacePath, auditPath, cleanup } = makeHarness();

    try {
      const session = await protocol.resumeSession('session_missing', { workspacePath });

      expect(session.id).not.toBe('session_missing');
      expect(session.id.startsWith('session_')).toBe(true);

      const rows = auditRows(auditPath);
      expect(rows.some((row) => row.method === 'session/load')).toBe(true);
      expect(rows.some((row) => row.method === 'session/new')).toBe(true);
    } finally {
      cleanup();
    }
  }, 15000);

  it('puts the session in kimi plan mode for a planning turn and back to default for an agent turn', async () => {
    const { protocol, workspacePath, auditPath, cleanup } = makeHarness();

    try {
      const session = await protocol.createSession({ workspacePath });
      const drain = async (mode: 'planning' | 'agent') => {
        for await (const event of protocol.sendMessage(session, { content: 'Apply the kimi edit', mode })) {
          void event;
        }
      };
      const setModes = () => auditRows(auditPath)
        .filter((row) => row.method === 'session/set_mode')
        .map((row) => row.params.modeId);

      await drain('planning');
      expect(setModes()).toEqual(['plan']);

      await drain('agent');
      expect(setModes()).toEqual(['plan', 'default']);

      // Already in default: no extra round-trip.
      await drain('agent');
      expect(setModes()).toEqual(['plan', 'default']);
    } finally {
      cleanup();
    }
  }, 20000);

  it('never lets a provider API key reach the kimi child, whatever env it was handed', async () => {
    // These arrive through the last merge before spawn, the place the
    // provider-side deletes cannot reach.
    const { protocol, workspacePath, auditPath, cleanup } = makeHarness({
      env: {
        MOONSHOT_API_KEY: 'sk-moonshot-leak',
        KIMI_API_KEY: 'sk-kimi-leak',
        ANTHROPIC_API_KEY: 'sk-ant-leak',
        KIMI_ACP_TEST_MARKER: 'kept',
      },
    });

    try {
      await protocol.createSession({ workspacePath });

      const newSession = auditRows(auditPath).find((row) => row.method === 'session/new');
      expect(newSession?.params.env).toEqual({
        MOONSHOT_API_KEY: null,
        KIMI_API_KEY: null,
        ANTHROPIC_API_KEY: null,
        KIMI_ACP_TEST_MARKER: 'kept',
        // kimi drops a tool call after 60 seconds (measured on 2.0.2), which is
        // shorter than a person takes to answer AskUserQuestion or a commit
        // proposal. ACP has no per-server timeout, so it is set for the process.
        KIMI_MCP_TOOL_TIMEOUT_MS: '604800000',
      });
    } finally {
      cleanup();
    }
  }, 15000);

  it('sends session/cancel when the per-turn abort signal fires', async () => {
    const { protocol, workspacePath, auditPath, cleanup } = makeHarness();

    try {
      const session = await protocol.createSession({ workspacePath });
      const controller = new AbortController();

      const events: any[] = [];
      for await (const event of protocol.sendMessage(session, {
        content: 'never finish',
        abortSignal: controller.signal,
      })) {
        events.push(event);
        if (event.type === 'text') {
          controller.abort();
        }
      }

      const complete = events.find((event) => event.type === 'complete');
      expect(complete?.metadata?.stopReason).toBe('cancelled');
      expect(auditRows(auditPath).some((row) => row.method === 'session/cancel')).toBe(true);
    } finally {
      cleanup();
    }
  }, 15000);
});
