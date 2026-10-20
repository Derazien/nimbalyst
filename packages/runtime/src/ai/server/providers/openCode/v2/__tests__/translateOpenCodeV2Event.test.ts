// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import {
  OpenCodeV2EventTranslator,
  parseOpenCodeV2SseFrame,
  type OpenCodeV2Event,
} from '../translateOpenCodeV2Event';
import { OpenCodeRawParser } from '../../../../transcript/parsers/OpenCodeRawParser';
import type {
  CanonicalEventDescriptor,
  ParseContext,
} from '../../../../transcript/parsers/IRawMessageParser';
import type { RawMessage } from '../../../../transcript/TranscriptTransformer';
import {
  EDIT_STREAM,
  FAILED_STREAM,
  PERMISSION_STREAM,
  REJECT_INTERRUPT_COMPACT_STREAM,
  TOOLS_STREAM,
} from './fixtures/openCodeV2Streams';

/** Test view of a translated event: properties are read by key, not by static type. */
interface LooseEvent {
  type: string;
  properties: any;
}

class LooseTranslator extends OpenCodeV2EventTranslator {
  override translate(event: OpenCodeV2Event): LooseEvent[] {
    return super.translate(event) as LooseEvent[];
  }
}

const DIRECTORY = '/work/project';

function translateAll(stream: OpenCodeV2Event[], fallbackDirectory?: string): LooseEvent[] {
  const translator = new LooseTranslator(fallbackDirectory);
  return stream.flatMap((event) => translator.translate(event));
}

function ofType(events: LooseEvent[], type: string): LooseEvent[] {
  return events.filter((event) => event.type === type);
}

function toolParts(events: LooseEvent[]): Array<Record<string, any>> {
  return ofType(events, 'message.part.updated')
    .map((event) => event.properties.part as Record<string, any>)
    .filter((part) => part.type === 'tool');
}

function rawEvent(overrides: Partial<OpenCodeV2Event> & { type: string }): OpenCodeV2Event {
  return { location: { directory: DIRECTORY }, ...overrides };
}

describe('OpenCodeV2EventTranslator on captured 2.1.0 streams', () => {
  it('turns a read + shell turn into 1.x step, reasoning, text, tool and idle events', () => {
    const events = translateAll(TOOLS_STREAM);
    const sessionID = 'ses_ea6cb8508ffeweQMNvroZtifJR';

    // Text arrives as message.part.delta with field "text", one stable part per ordinal.
    const textDeltas = ofType(events, 'message.part.delta');
    expect(textDeltas.length).toBeGreaterThan(0);
    for (const delta of textDeltas) {
      expect(delta.properties).toMatchObject({ sessionID, field: 'text' });
      expect(delta.properties.partID).toBe(`${delta.properties.messageID}-text-0`);
    }
    expect(textDeltas.map((e) => e.properties.delta).join('')).toBe(
      TOOLS_STREAM.filter((e) => e.type === 'session.text.delta')
        .map((e) => (e.data as any).delta)
        .join(''),
    );

    // Reasoning is a reasoning part carrying the new chunk plus the cumulative text.
    const reasoning = ofType(events, 'message.part.updated').filter(
      (e) => e.properties.part.type === 'reasoning',
    );
    expect(reasoning.length).toBeGreaterThanOrEqual(2);
    expect(reasoning[0].properties.delta).toBe(reasoning[0].properties.part.text);
    expect(reasoning[1].properties.part.text).toBe(
      reasoning[0].properties.delta + reasoning[1].properties.delta,
    );
    expect(reasoning[0].properties.part.id).toBe(
      `${reasoning[0].properties.part.messageID}-reasoning-0`,
    );

    // Tool names come from tool.input.started; tool.success carries none of its own.
    const parts = toolParts(events);
    expect(parts.map((p) => `${p.tool}:${p.state.status}`)).toEqual([
      'read:running',
      'shell:running',
      'read:completed',
      'shell:completed',
    ]);
    const [readRunning, shellRunning, readDone, shellDone] = parts;
    expect(readRunning).toMatchObject({
      id: 'call_9b7093cf69454358844f995b',
      callID: 'call_9b7093cf69454358844f995b',
      sessionID,
      state: { status: 'running', input: { path: 'note.txt' } },
    });
    expect(shellRunning.state.input).toEqual({ command: 'echo captured' });
    expect(readDone.state).toMatchObject({
      status: 'completed',
      input: { path: 'note.txt' },
      output: 'Read file note.txt, lines 1-1\n1: hello file',
    });
    expect(shellDone.state).toMatchObject({
      status: 'completed',
      input: { command: 'echo captured' },
      output: 'captured\n',
    });
    expect(readDone.messageID).toBe(readRunning.messageID);
    expect(readRunning.messageID).toMatch(/^msg_/);

    // Step start names the model; step end carries tokens and finish.
    const messageUpdates = ofType(events, 'message.updated').map((e) => e.properties.info);
    expect(messageUpdates[0]).toMatchObject({
      role: 'assistant',
      sessionID,
      providerID: 'opencode',
      modelID: 'big-pickle',
    });
    const ended = messageUpdates.filter((info) => typeof info.finish === 'string');
    expect(ended.map((info) => info.finish)).toEqual(['tool-calls', 'stop']);
    expect(ended[1].tokens).toMatchObject({ input: expect.any(Number), output: expect.any(Number) });

    // The turn ends with exactly one session.idle, and it is last.
    expect(ofType(events, 'session.idle')).toHaveLength(1);
    expect(events[events.length - 1]).toEqual({ type: 'session.idle', properties: { sessionID } });
  });

  it('emits only event types the 1.x consumers understand', () => {
    const known = new Set([
      'server.connected',
      'message.updated',
      'message.part.updated',
      'message.part.delta',
      'file.edited',
      'session.idle',
      'session.error',
      'permission.asked',
      'permission.replied',
    ]);
    for (const stream of [
      TOOLS_STREAM,
      PERMISSION_STREAM,
      REJECT_INTERRUPT_COMPACT_STREAM,
      EDIT_STREAM,
      FAILED_STREAM,
    ]) {
      const types = new Set(translateAll(stream).map((e) => e.type));
      for (const type of types) expect(known.has(type)).toBe(true);
    }
  });

  it('drops catalog notices, inbox, usage, shell, compaction and step lifecycle noise', () => {
    const noise = REJECT_INTERRUPT_COMPACT_STREAM.filter((e) =>
      /^(session\.(created|inbox\.|instructions\.|usage\.|renamed|compaction\.|step\.(streamed|failed)|execution\.started|text\.(started|ended)|reasoning\.(started|ended)|tool\.input\.ended)|project\.|provider\.|shell\.)/.test(
        e.type,
      ),
    );
    expect(noise.length).toBeGreaterThan(3);
    const translator = new LooseTranslator(DIRECTORY);
    for (const event of noise) expect(translator.translate(event)).toEqual([]);
  });

  it('maps permission.asked and permission.replied for both tools in a gated turn', () => {
    const events = translateAll(PERMISSION_STREAM);
    const asked = ofType(events, 'permission.asked').map((e) => e.properties);
    expect(asked).toEqual([
      {
        id: 'per_15936d136001Pzt84BzQkrWO0E',
        sessionID: 'ses_ea6c9671effeW9LfdfdnGgMecq',
        permission: 'read',
        patterns: ['note.txt'],
        always: ['*'],
        metadata: {},
        tool: {
          messageID: 'msg_159369961001E35dNpViSg5435',
          callID: 'f03ee3d9-0cc4-4fb8-a032-88c85c4e3f2d',
        },
      },
      {
        id: 'per_15936d13a001QDWXMUuCHlfVPU',
        sessionID: 'ses_ea6c9671effeW9LfdfdnGgMecq',
        permission: 'shell',
        patterns: ['echo captured'],
        always: ['echo *'],
        metadata: {},
        tool: {
          messageID: 'msg_159369961001E35dNpViSg5435',
          callID: 'd3d7085a-7cfc-4c94-a9f3-514b87400d37',
        },
      },
    ]);
    expect(ofType(events, 'permission.replied').map((e) => e.properties)).toEqual([
      {
        sessionID: 'ses_ea6c9671effeW9LfdfdnGgMecq',
        permissionID: 'per_15936d136001Pzt84BzQkrWO0E',
        response: 'once',
      },
      {
        sessionID: 'ses_ea6c9671effeW9LfdfdnGgMecq',
        permissionID: 'per_15936d13a001QDWXMUuCHlfVPU',
        response: 'once',
      },
    ]);
    // The permission's tool call id is the id of a tool part seen earlier in the stream.
    const callIds = toolParts(events).map((p) => p.callID);
    for (const request of asked) expect(callIds).toContain(request.tool.callID);
  });

  it('maps a rejected tool, an interrupt and a compaction turn', () => {
    const events = translateAll(REJECT_INTERRUPT_COMPACT_STREAM);

    const failed = toolParts(events).find((p) => p.state.status === 'error');
    expect(failed).toMatchObject({
      tool: 'shell',
      callID: 'call_3bad08b4d43d44eea25521a8',
      state: { status: 'error', error: 'not allowed in test' },
    });
    expect(ofType(events, 'permission.replied')[0].properties).toMatchObject({
      response: 'reject',
    });

    // succeeded, interrupted and the compaction turn's succeeded each end a turn.
    expect(ofType(events, 'session.idle')).toHaveLength(3);
    // The interrupted step's session.step.failed is not an error the user must see.
    expect(ofType(events, 'session.error')).toHaveLength(0);
    // Compaction text is not chat text.
    const text = ofType(events, 'message.part.delta')
      .map((e) => e.properties.delta)
      .join('');
    expect(text).not.toContain('Objective');
  });

  it('turns edit success into file.edited with an absolute path under the event directory', () => {
    const events = translateAll(EDIT_STREAM);
    const edited = ofType(events, 'file.edited');
    expect(edited).toHaveLength(1);
    expect(edited[0].properties).toEqual({
      sessionID: 'ses_ea6c55bb2ffe2u25dBB9WDplwo',
      file: path.join(DIRECTORY, 'note.txt'),
    });
    expect(path.isAbsolute(edited[0].properties.file)).toBe(true);

    const parts = toolParts(events);
    const edit = parts.find((p) => p.tool === 'edit' && p.state.status === 'completed');
    expect(edit?.state.output).toBe('Edited note.txt (1 replacement)');
    expect(edit?.state.metadata.files[0]).toMatchObject({ file: 'note.txt', status: 'modified' });
    const write = parts.find((p) => p.tool === 'write' && p.state.status === 'completed');
    expect(write?.state.input).toMatchObject({ content: 'hi\n' });
    expect(write?.state.output).toBe('Created file successfully: new.txt');
  });

  it('reports a failed execution as session.error then session.idle', () => {
    const events = translateAll(FAILED_STREAM);
    expect(events.map((e) => e.type)).toEqual(['server.connected', 'session.error', 'session.idle']);
    expect(events[1].properties).toEqual({
      sessionID: 'ses_ea6c684beffeEU0p3x0Mg5tJkg',
      error: {
        name: 'provider.no-route',
        message: 'Model unavailable: opencode/no-such-model',
        data: { message: 'Model unavailable: opencode/no-such-model' },
      },
    });
  });
});

describe('OpenCodeV2EventTranslator edge cases', () => {
  const data = { sessionID: 'ses_1', assistantMessageID: 'msg_1', id: 'call_1' };

  it('uses the fallback directory when the event has no location', () => {
    const noLocation: OpenCodeV2Event = {
      type: 'session.tool.success',
      data: { ...data, content: [], metadata: { files: [{ file: 'src/a.ts' }] } },
    };
    const withFallback = new LooseTranslator('/ws').translate(noLocation);
    expect(ofType(withFallback, 'file.edited')[0].properties.file).toBe(path.join('/ws', 'src/a.ts'));

    // Without any directory the relative path is passed through rather than invented.
    const bare = new LooseTranslator().translate(noLocation);
    expect(ofType(bare, 'file.edited')[0].properties.file).toBe('src/a.ts');
  });

  it('keeps an already absolute edited path untouched', () => {
    const abs = path.resolve('/elsewhere/b.ts');
    const events = new LooseTranslator().translate(
      rawEvent({
        type: 'session.tool.success',
        data: { ...data, content: [], metadata: { files: [{ file: abs }] } },
      }),
    );
    expect(ofType(events, 'file.edited')[0].properties.file).toBe(abs);
  });

  it('names a tool "unknown" when its input.started was never seen, then remembers nothing', () => {
    const translator = new LooseTranslator(DIRECTORY);
    const [part] = translator.translate(
      rawEvent({ type: 'session.tool.called', data: { ...data, input: { x: 1 } } }),
    );
    expect(part.properties.part.tool).toBe('unknown');
    const [done] = translator.translate(
      rawEvent({ type: 'session.tool.success', data: { ...data, content: [{ type: 'text', text: 'ok' }] } }),
    );
    expect(done.properties.part).toMatchObject({ tool: 'unknown', state: { status: 'completed', output: 'ok' } });
    // The call is finished, so a later reuse of the id starts fresh.
    const [again] = translator.translate(
      rawEvent({ type: 'session.tool.called', data: { ...data, name: 'read', input: {} } }),
    );
    expect(again.properties.part.tool).toBe('read');
  });

  it('restarts cumulative reasoning text after session.reasoning.ended', () => {
    const translator = new LooseTranslator(DIRECTORY);
    const delta = (text: string) =>
      rawEvent({
        type: 'session.reasoning.delta',
        data: { sessionID: 'ses_1', assistantMessageID: 'msg_1', ordinal: 0, delta: text },
      });
    translator.translate(delta('a'));
    expect(translator.translate(delta('b'))[0].properties.part.text).toBe('ab');
    translator.translate(
      rawEvent({
        type: 'session.reasoning.ended',
        data: { sessionID: 'ses_1', assistantMessageID: 'msg_1', ordinal: 0, text: 'ab' },
      }),
    );
    expect(translator.translate(delta('c'))[0].properties.part.text).toBe('c');
  });

  it('ignores empty deltas and events missing the ids they need', () => {
    const translator = new LooseTranslator(DIRECTORY);
    expect(
      translator.translate(
        rawEvent({ type: 'session.text.delta', data: { sessionID: 's', assistantMessageID: 'm', delta: '' } }),
      ),
    ).toEqual([]);
    expect(translator.translate(rawEvent({ type: 'session.execution.succeeded', data: {} }))).toEqual([]);
    expect(translator.translate(rawEvent({ type: 'permission.asked', data: { sessionID: 's' } }))).toEqual([]);
    expect(translator.translate(rawEvent({ type: 'never.heard.of', data: { sessionID: 's' } }))).toEqual([]);
  });

  it('omits the tool link on a permission that has no source and falls back for a bare tool error', () => {
    const translator = new LooseTranslator(DIRECTORY);
    const [asked] = translator.translate(
      rawEvent({
        type: 'permission.asked',
        data: { id: 'p1', sessionID: 's', action: 'edit', resources: ['a.ts'], save: [] },
      }),
    );
    expect(asked.properties).not.toHaveProperty('tool');
    expect(asked.properties.always).toEqual([]);

    const [failed] = translator.translate(
      rawEvent({ type: 'session.tool.failed', data: { ...data, error: {} } }),
    );
    expect(failed.properties.part.state.error).toBe('Tool execution failed');
  });
});

describe('parseOpenCodeV2SseFrame', () => {
  it('decodes a data frame and skips comments and undecodable payloads', () => {
    const event = { type: 'session.execution.succeeded', data: { sessionID: 's' } };
    expect(parseOpenCodeV2SseFrame(`data: ${JSON.stringify(event)}`)).toEqual(event);
    expect(parseOpenCodeV2SseFrame(`event: message\r\ndata:${JSON.stringify(event)}`)).toEqual(event);
    expect(parseOpenCodeV2SseFrame(': heartbeat')).toBeNull();
    expect(parseOpenCodeV2SseFrame('data: {not json')).toBeNull();
    expect(parseOpenCodeV2SseFrame('data: {"no":"type"}')).toBeNull();
    expect(parseOpenCodeV2SseFrame('')).toBeNull();
  });
});

describe('translated 2.x streams replayed through OpenCodeRawParser', () => {
  /** Persist each translated event as a raw row, the way OpenCodeProvider does, and parse it back. */
  async function replay(stream: OpenCodeV2Event[]): Promise<CanonicalEventDescriptor[]> {
    const parser = new OpenCodeRawParser();
    const seen = new Set<string>();
    const context: ParseContext = {
      sessionId: 'nim-session-1',
      hasToolCall: (id) => seen.has(id),
      hasSubagent: () => false,
      findByProviderToolCallId: vi.fn(async () => null),
      findActiveToolCallByRawProviderId: vi.fn(async () => null),
    };
    const descriptors: CanonicalEventDescriptor[] = [];
    let id = 0;
    for (const event of translateAll(stream)) {
      const row: RawMessage = {
        id: ++id,
        sessionId: 'nim-session-1',
        source: 'opencode',
        direction: 'output',
        content: JSON.stringify(event),
        createdAt: new Date('2026-10-20T00:00:00Z'),
        hidden: true,
      };
      for (const descriptor of await parser.parseMessage(row, context)) {
        if (descriptor.type === 'tool_call_started') seen.add(descriptor.providerToolCallId as string);
        descriptors.push(descriptor);
      }
    }
    return descriptors;
  }

  it('rebuilds assistant text, tool calls with results and the turn end', async () => {
    const descriptors = await replay(TOOLS_STREAM);

    const text = descriptors
      .filter((d) => d.type === 'assistant_message')
      .map((d: any) => d.text)
      .join('');
    expect(text).toBe(
      TOOLS_STREAM.filter((e) => e.type === 'session.text.delta')
        .map((e) => (e.data as any).delta)
        .join(''),
    );
    expect(text).toContain('hello file');

    const started = descriptors.filter((d) => d.type === 'tool_call_started') as any[];
    expect(started.map((d) => [d.toolName, d.providerToolCallId])).toEqual([
      ['read', 'call_9b7093cf69454358844f995b'],
      ['shell', 'call_d359b3de939d4ae499a2e8cf'],
    ]);
    expect(started[0]).toMatchObject({ arguments: { path: 'note.txt' }, targetFilePath: 'note.txt' });
    expect(started[1]).toMatchObject({ toolDisplayName: 'Bash', arguments: { command: 'echo captured' } });

    const completed = descriptors.filter((d) => d.type === 'tool_call_completed') as any[];
    expect(completed.map((d) => [d.providerToolCallId, d.status, d.result])).toEqual([
      ['call_9b7093cf69454358844f995b', 'completed', 'Read file note.txt, lines 1-1\n1: hello file'],
      ['call_d359b3de939d4ae499a2e8cf', 'completed', 'captured\n'],
    ]);

    const finalStep = [...TOOLS_STREAM].reverse().find((e) => e.type === 'session.step.ended')!;
    const tokens = (finalStep.data as any).tokens;
    const ended = descriptors.filter((d) => d.type === 'turn_ended') as any[];
    expect(ended).toHaveLength(1);
    expect(ended[0].contextFill).toMatchObject({
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheReadInputTokens: tokens.cache.read,
    });
    expect(descriptors[descriptors.length - 1].type).toBe('turn_ended');
  });

  it('shows the permission cards and completes them with the user decision', async () => {
    const descriptors = await replay(PERMISSION_STREAM);
    const cards = descriptors.filter(
      (d) => d.type === 'tool_call_started' && (d as any).toolName === 'ToolPermission',
    ) as any[];
    expect(cards.map((d) => d.providerToolCallId)).toEqual([
      'per_15936d136001Pzt84BzQkrWO0E',
      'per_15936d13a001QDWXMUuCHlfVPU',
    ]);
    expect(cards[1].arguments).toMatchObject({
      requestId: 'per_15936d13a001QDWXMUuCHlfVPU',
      toolName: 'shell',
      pattern: 'OpenCode(shell:echo *)',
      suppressAlwaysAllowRule: false,
    });
    const replies = descriptors.filter(
      (d) => d.type === 'tool_call_completed' && String((d as any).providerToolCallId).startsWith('per_'),
    ) as any[];
    expect(replies.map((d) => [d.status, d.result])).toEqual([
      ['completed', JSON.stringify({ decision: 'allow', scope: 'once' })],
      ['completed', JSON.stringify({ decision: 'allow', scope: 'once' })],
    ]);
    // The gated tools still complete once the user allowed them.
    expect(
      descriptors.filter((d) => d.type === 'tool_call_completed' && (d as any).status === 'completed').length,
    ).toBeGreaterThanOrEqual(4);
  });

  it('records a rejected permission and its failed tool as errors', async () => {
    const descriptors = await replay(REJECT_INTERRUPT_COMPACT_STREAM);
    const completed = descriptors.filter((d) => d.type === 'tool_call_completed') as any[];
    const rejectedPermission = completed.find((d) => String(d.providerToolCallId).startsWith('per_'));
    expect(rejectedPermission).toMatchObject({
      status: 'error',
      result: JSON.stringify({ decision: 'deny', scope: 'once' }),
    });
    const failedTool = completed.find((d) => d.providerToolCallId === 'call_3bad08b4d43d44eea25521a8');
    expect(failedTool).toMatchObject({ status: 'error', isError: true, result: 'not allowed in test' });
    expect(descriptors.filter((d) => d.type === 'turn_ended')).toHaveLength(3);
  });

  it('records the edit as a file_edit with the absolute path and the tool calls', async () => {
    const descriptors = await replay(EDIT_STREAM);
    const fileEdit = descriptors.find(
      (d) => d.type === 'tool_call_started' && (d as any).toolName === 'file_edit',
    ) as any;
    expect(fileEdit.targetFilePath).toBe(path.join(DIRECTORY, 'note.txt'));
    const names = descriptors
      .filter((d) => d.type === 'tool_call_started')
      .map((d: any) => d.toolName);
    expect(names).toContain('edit');
    expect(names).toContain('write');
  });

  it('shows a failed turn as an error message and still ends the turn', async () => {
    const descriptors = await replay(FAILED_STREAM);
    expect(descriptors).toEqual([
      expect.objectContaining({
        type: 'system_message',
        systemType: 'error',
        text: 'Model unavailable: opencode/no-such-model',
      }),
      expect.objectContaining({ type: 'turn_ended' }),
    ]);
  });
});
