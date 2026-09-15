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

      const toolCall = events.find((event) => event.type === 'tool_call' && event.toolCall?.id === 'tool-1');
      expect(toolCall?.toolCall?.name).toBe('Write kimi-target.txt');
      expect(toolCall?.toolCall?.arguments?.path).toBe(path.join(workspacePath, 'kimi-target.txt'));

      const toolResult = events.find((event) => event.type === 'tool_result');
      expect(toolResult?.toolResult?.id).toBe('tool-1');
      expect(toolResult?.toolResult?.name).toBe('Write kimi-target.txt');
      expect(toolResult?.toolResult?.result?.success).toBe(true);
      expect(toolResult?.toolResult?.result?.output).toMatchObject({ bytesWritten: 16 });

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

  it('captures a pre-edit baseline and reports the edited file on fs/write_text_file', async () => {
    const editedFiles: string[] = [];
    let preEditContent: string | undefined;
    const { protocol, workspacePath, cleanup } = makeHarness({
      onBeforeFileWrite: async (filePath) => {
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
