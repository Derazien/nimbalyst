/**
 * Turns the genuine `kimi` CLI's event log (`agents/main/wire.jsonl` in the
 * kimi session directory) into what Nimbalyst needs from a terminal-driven
 * Kimi Code CLI session: turn state (running / waiting / idle) and transcript
 * rows.
 *
 * The rows use the shapes `KimiACPRawParser` already reads for the ACP-driven
 * `kimi-code` provider (plain-text input rows, `item.completed` assistant rows,
 * `session/update` tool_call / tool_call_update rows), so both Kimi transports
 * share one parser, the way claude-code and claude-code-cli do.
 *
 * The wire format is undocumented. Everything here follows what kimi 0.43.1
 * writes (see nimbalyst-local/kimi-code-cli-design-2026-09-19.md); any line
 * that is not JSON or whose kind is unknown translates to nothing.
 */

import type { ClaudeTurnState } from './claudeCliPidState';

export type KimiTurnEndReason = 'completed' | 'cancelled' | 'failed';

export type KimiWireAction =
  | { kind: 'turn-state'; state: ClaudeTurnState; endReason?: KimiTurnEndReason }
  /** The model kimi is on now, spelled `kimi-code/<alias>`. */
  | { kind: 'model'; alias: string }
  /** The thinking effort kimi is on now (`low`, `high`, `max`, `on`, `off`). */
  | { kind: 'thinking'; effort: string }
  | {
      kind: 'row';
      direction: 'input' | 'output';
      content: string;
      createdAt: Date;
      metadata?: Record<string, unknown>;
    };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(input: unknown): string {
  if (!Array.isArray(input)) return '';
  return input
    .map((part) => (isObject(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function outcomeToReason(value: unknown): KimiTurnEndReason {
  if (value === 'aborted' || value === 'cancelled') return 'cancelled';
  if (value === 'failed') return 'failed';
  return 'completed';
}

export class KimiCliWireTranslator {
  private state: ClaudeTurnState | null = null;
  private readonly endedTurns = new Set<string>();
  private readonly failedTurnsReported = new Set<string>();
  /** Assistant text of the step in progress; flushed as one row at step end. */
  private pendingText = '';
  private pendingTextAt: Date | null = null;

  translateLine(line: string): KimiWireAction[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return [];
    }
    if (!isObject(event) || typeof event.type !== 'string') return [];
    const at = new Date(typeof event.time === 'number' ? event.time : Date.now());

    switch (event.type) {
      case 'agent.turn.started':
        return this.setState('running');

      case 'profile.bind':
      case 'config.update':
        return [
          ...(typeof event.modelAlias === 'string' ? [{ kind: 'model' as const, alias: event.modelAlias }] : []),
          ...(typeof event.thinkingEffort === 'string' ? [{ kind: 'thinking' as const, effort: event.thinkingEffort }] : []),
        ];

      case 'llm.request':
        // What the request really ran at, which is the only place a
        // session-only pick made before the first prompt is recorded.
        return typeof event.thinkingEffort === 'string' ? [{ kind: 'thinking', effort: event.thinkingEffort }] : [];

      case 'turn.prompt':
      case 'turn.steer':
        return this.userRow(event, at);

      case 'interaction.request':
        return this.setState('waiting_for_input');

      case 'interaction.resolved':
        return this.state === 'waiting_for_input' ? this.setState('running') : [];

      case 'context.append_loop_event':
        return isObject(event.event) ? this.loopEvent(event.event, at) : [];

      case 'turn.step.interrupted':
        return this.flushText();

      case 'agent.turn.ended':
        return this.endTurn(event.turnId, outcomeToReason(event.outcome));

      case 'turn.ended': {
        const reason = outcomeToReason(event.reason);
        const actions = this.endTurn(event.turnId, reason);
        if (reason === 'failed') actions.push(...this.failureRow(event, at));
        return actions;
      }

      default:
        return [];
    }
  }

  private setState(state: ClaudeTurnState, endReason?: KimiTurnEndReason): KimiWireAction[] {
    if (this.state === state && state !== 'idle') return [];
    this.state = state;
    return [{ kind: 'turn-state', state, ...(endReason ? { endReason } : {}) }];
  }

  private endTurn(turnId: unknown, reason: KimiTurnEndReason): KimiWireAction[] {
    const actions = this.flushText();
    const key = String(turnId);
    if (this.endedTurns.has(key)) return actions;
    this.endedTurns.add(key);
    return [...actions, ...this.setState('idle', reason)];
  }

  private userRow(event: Json, at: Date): KimiWireAction[] {
    // Only what a person typed. kimi also injects reminders and skill text
    // through the same events, with another origin.
    if (!isObject(event.origin) || event.origin.kind !== 'user') return [];
    const text = textOf(event.input).trim();
    if (!text) return [];
    return [{ kind: 'row', direction: 'input', content: text, createdAt: at }];
  }

  private loopEvent(loop: Json, at: Date): KimiWireAction[] {
    switch (loop.type) {
      case 'content.part': {
        const part = loop.part;
        if (isObject(part) && part.type === 'text' && typeof part.text === 'string') {
          this.pendingText += part.text;
          this.pendingTextAt ??= at;
        }
        return [];
      }

      case 'step.end':
        return this.flushText();

      case 'tool.call': {
        if (typeof loop.toolCallId !== 'string') return [];
        // Text the model wrote before calling the tool reads before the card.
        const actions = this.flushText();
        const display = isObject(loop.display) ? loop.display : {};
        const rawInput = isObject(loop.args) ? loop.args : {};
        actions.push(this.outputRow({
          sessionUpdate: 'tool_call',
          toolCallId: loop.toolCallId,
          title: typeof loop.name === 'string' ? loop.name : 'Tool call',
          status: 'in_progress',
          rawInput,
          ...(typeof display.path === 'string' ? { locations: [{ path: display.path }] } : {}),
        }, at));
        return actions;
      }

      case 'tool.result': {
        if (typeof loop.toolCallId !== 'string') return [];
        const result = isObject(loop.result) ? loop.result : {};
        const output = result.output;
        return [this.outputRow({
          sessionUpdate: 'tool_call_update',
          toolCallId: loop.toolCallId,
          status: result.isError === true ? 'failed' : 'completed',
          rawOutput: typeof output === 'string' ? output : JSON.stringify(output ?? ''),
        }, at)];
      }

      default:
        return [];
    }
  }

  private outputRow(update: Json, at: Date): KimiWireAction {
    return {
      kind: 'row',
      direction: 'output',
      content: JSON.stringify({ type: 'session/update', update }),
      createdAt: at,
      metadata: { eventType: `session/update:${String(update.sessionUpdate)}`, kimiCli: true },
    };
  }

  private flushText(): KimiWireAction[] {
    const text = this.pendingText;
    const at = this.pendingTextAt ?? new Date();
    this.pendingText = '';
    this.pendingTextAt = null;
    if (!text.trim()) return [];
    return [{
      kind: 'row',
      direction: 'output',
      content: JSON.stringify({
        type: 'item.completed',
        item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
      }),
      createdAt: at,
      metadata: { eventType: 'item.completed', kimiCli: true },
    }];
  }

  private failureRow(event: Json, at: Date): KimiWireAction[] {
    const key = String(event.turnId);
    if (this.failedTurnsReported.has(key)) return [];
    this.failedTurnsReported.add(key);
    const error = isObject(event.error) ? event.error : {};
    const message = typeof error.message === 'string' && error.message
      ? error.message
      : 'The Kimi turn failed.';
    return [{
      kind: 'row',
      direction: 'output',
      content: JSON.stringify({ type: 'turn/failed', message }),
      createdAt: at,
      metadata: { eventType: 'turn/failed', kimiCli: true },
    }];
  }
}
