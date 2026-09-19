#!/usr/bin/env node

/**
 * Mock ACP agent for KimiACPProtocol.test.ts. Implements the agent side of
 * the Agent Client Protocol over stdio, mirroring the kimi CLI behaviors the
 * protocol-under-test depends on (model picker configOptions, set_model /
 * set_config_option, approve_once/approve_always/reject permission options,
 * session/load history replay, fs reverse-RPC edits).
 *
 * Test observation point: when KIMI_ACP_TEST_AUDIT_PATH is set, every
 * interesting inbound call is appended there as NDJSON, so tests can assert
 * what actually reached the agent rather than what the adapter meant to send.
 *
 * KIMI_ACP_TEST_FAIL_SET_MODEL=1 makes session/set_model fail so the
 * adapter's set_config_option fallback is exercised.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk';

const auditPath = process.env.KIMI_ACP_TEST_AUDIT_PATH;
function audit(method, params) {
  if (!auditPath) return;
  fs.appendFileSync(auditPath, `${JSON.stringify({ method, params })}\n`, 'utf8');
}

const MODEL_OPTIONS = [
  { value: 'kimi-code/kimi-for-coding', name: 'K2.8 Preview' },
  { value: 'kimi-code/kimi-for-coding-highspeed', name: 'K2.7 Code Highspeed' },
  { value: 'kimi-code/k3', name: 'K3' },
];

class MockKimiAcpAgent {
  constructor(connection) {
    this.connection = connection;
    this.sessions = new Map();
  }

  async initialize() {
    audit('initialize', {});
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
      },
    };
  }

  async authenticate() {
    return {};
  }

  async newSession(params) {
    const sessionId = `session_${randomUUID()}`;
    this.sessions.set(sessionId, { cwd: params.cwd, model: 'kimi-code/k3', cancelled: false });
    audit('session/new', { sessionId, cwd: params.cwd });
    return {
      sessionId,
      configOptions: [
        {
          type: 'select',
          id: 'model',
          name: 'Model',
          currentValue: 'kimi-code/k3',
          options: MODEL_OPTIONS,
        },
      ],
      modes: {
        currentModeId: 'default',
        availableModes: [{ id: 'default', name: 'Default' }],
      },
    };
  }

  async loadSession(params) {
    audit('session/load', { sessionId: params.sessionId });
    if (!this.sessions.has(params.sessionId)) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }
    // Kimi replays history as session/update notifications BEFORE the
    // session/load response settles.
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'replayed history' },
      },
    });
    return {};
  }

  async unstable_forkSession(params) {
    const source = this.sessions.get(params.sessionId);
    if (!source) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }
    const sessionId = `session_${randomUUID()}`;
    this.sessions.set(sessionId, { ...source });
    audit('session/fork', { from: params.sessionId, sessionId });
    return { sessionId };
  }

  async closeSession(params) {
    audit('session/close', { sessionId: params.sessionId });
    this.sessions.delete(params.sessionId);
    return {};
  }

  async setSessionMode() {
    return {};
  }

  async unstable_setSessionModel(params) {
    audit('session/set_model', { sessionId: params.sessionId, modelId: params.modelId });
    if (process.env.KIMI_ACP_TEST_FAIL_SET_MODEL === '1') {
      throw new Error('set_model disabled by test');
    }
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }
    session.model = params.modelId;
    return {};
  }

  async setSessionConfigOption(params) {
    audit('session/set_config_option', {
      sessionId: params.sessionId,
      configId: params.configId,
      value: params.value,
    });
    const session = this.sessions.get(params.sessionId);
    if (session && params.configId === 'model') {
      session.model = params.value;
    }
    return {};
  }

  async prompt(params) {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }

    const text = (params.prompt ?? []).find((block) => block.type === 'text')?.text ?? '';
    audit('session/prompt', { sessionId: params.sessionId, text });

    if (text.includes('never finish')) {
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Working forever' },
        },
      });
      while (!session.cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      session.cancelled = false;
      return { stopReason: 'cancelled' };
    }

    // Event order below was recorded from a real `kimi acp` (0.43.1) turn on
    // 2026-09-17: the first tool_call carries only a title; the arguments and
    // the absolute location arrive in a later in_progress update, right
    // before the fs/write_text_file call; kimi spells absolute paths with
    // forward slashes on every platform and the rawInput path is relative to
    // the session cwd.
    const targetPath = path.join(session.cwd, 'kimi-target.txt');
    const kimiStylePath = targetPath.replace(/\\/g, '/');
    const toolCallId = '0:tool_kimi_write_1';

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking about the edit' },
      },
    });

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Kimi turn started' },
      },
    });

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'Write',
        kind: 'edit',
        status: 'pending',
        content: [],
      },
    });

    for (let i = 0; i < 2; i += 1) {
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: [],
        },
      });
    }

    const permission = await this.connection.requestPermission({
      sessionId: params.sessionId,
      toolCall: {
        toolCallId,
        title: 'Write',
        kind: 'edit',
        status: 'pending',
      },
      options: process.env.KIMI_ACP_TEST_NO_REJECT_OPTION === '1'
        ? [
            { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
            { optionId: 'approve_always', name: 'Approve for this session', kind: 'allow_always' },
          ]
        : [
            { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
            { optionId: 'approve_always', name: 'Approve for this session', kind: 'allow_always' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
    });
    audit('session/request_permission:response', {
      sessionId: params.sessionId,
      outcome: permission.outcome?.outcome ?? null,
      optionId: permission.outcome?.optionId ?? null,
    });

    if (permission.outcome.outcome !== 'selected' || permission.outcome.optionId === 'reject') {
      // Not observed live (the probe only approved); shape assumed.
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'failed',
          rawOutput: { error: 'User denied the edit' },
        },
      });
      return { stopReason: 'cancelled' };
    }

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        title: 'Writing kimi-target.txt',
        kind: 'edit',
        status: 'in_progress',
        rawInput: { path: 'kimi-target.txt', content: 'after from kimi\n' },
        locations: [{ path: kimiStylePath }],
        content: [],
      },
    });

    await this.connection.writeTextFile({
      sessionId: params.sessionId,
      path: kimiStylePath,
      content: 'after from kimi\n',
    });

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        rawOutput: 'Wrote 16 bytes to kimi-target.txt',
        locations: [{ path: kimiStylePath }],
        content: [],
      },
    });

    // Not observed from kimi 0.43.1 in the recorded turn (no usage_update and
    // no usage on the prompt response); kept so the adapter's handling of the
    // ACP usage_update notification stays covered.
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: 'usage_update', used: 123, size: 256000 },
    });

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Kimi turn done' },
      },
    });

    return { stopReason: 'end_turn' };
  }

  async cancel(params) {
    audit('session/cancel', { sessionId: params.sessionId });
    const session = this.sessions.get(params.sessionId);
    if (session) {
      session.cancelled = true;
    }
  }
}

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

new AgentSideConnection((connection) => new MockKimiAcpAgent(connection), stream);
