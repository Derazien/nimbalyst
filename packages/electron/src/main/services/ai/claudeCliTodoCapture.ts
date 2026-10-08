/**
 * Mirrors the genuine Claude CLI's todo tools into session metadata so the
 * right-sidebar TodoPanel (`currentTodos`) and TaskListPanel (`currentTaskList`)
 * light up for `claude-code-cli` sessions, the same way the SDK lane does in
 * `ClaudeCodeProvider` (emitTodoUpdate / captureTaskListMutation).
 *
 * Inputs come from the SSE-tee proxy:
 *   - `noteAssistantToolUses`: each assembled assistant message, synchronously, so a
 *     tool_use is known before its tool_result can show up in the next request body;
 *   - `noteTurnAttributed`: the same message once sub-agent attribution has resolved.
 *     Only a LEAD turn may drive the panels, so a sub-agent's own TodoWrite or
 *     TaskCreate is discarded here;
 *   - `noteToolResults`: the `tool_result` blocks of the next request body. TaskCreate's
 *     new id exists only in its result text, so it cannot be applied at tool_use time.
 *
 * Attribution is async (a sidecar read) and the next request body can beat it, so a
 * result is parked on the pending call until the turn is confirmed as lead, and a call is
 * applied once it has both. Persistence and the renderer refresh are injected, so this
 * module has no electron dependency.
 */

import {
  applyTaskListMutation,
  sortTaskList,
  type TaskListItem,
} from '@nimbalyst/runtime/ai/server/providers/claudeCode/taskListReconstruct';

const TODO_WRITE = 'TodoWrite';
const TASK_CREATE = 'TaskCreate';
const TASK_UPDATE = 'TaskUpdate';
const TRACKED_TOOLS: ReadonlySet<string> = new Set([TODO_WRITE, TASK_CREATE, TASK_UPDATE]);

/** Bound on parked calls that never get attributed (e.g. a persist that threw). */
const MAX_PENDING_CALLS = 200;

export interface TodoMetadataPatch {
  currentTodos?: unknown[];
  currentTaskList?: TaskListItem[];
}

export interface ClaudeCliTodoCaptureDeps {
  loadMetadata: (sessionId: string) => Promise<Record<string, unknown> | undefined>;
  saveMetadata: (sessionId: string, metadata: Record<string, unknown>) => Promise<void>;
  /** Tell the renderer to reload the session (so it re-reads metadata). */
  notify: (sessionId: string) => void;
}

interface ToolUseLike {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface ToolResultLike {
  toolUseId: string;
  content: string;
  isError: boolean;
}

interface PendingCall {
  name: string;
  input: Record<string, unknown>;
  lead: boolean;
  result?: ToolResultLike;
}

interface SessionState {
  tasks: Map<string, TaskListItem>;
  pending: Map<string, PendingCall>;
  hydrated: boolean;
  /** Serializes read-merge-write so two quick turns cannot interleave. */
  chain: Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * TaskCreate reports its id as "Task #3 created successfully: ..." in older CLIs and as
 * `{"task":{"id":"3","subject":"..."}}` in newer ones. Normalize to the text form that
 * `applyTaskListMutation` understands.
 */
export function normalizeTaskCreateResult(content: string): string {
  if (/Task #[^\s:]+/.test(content)) return content;
  try {
    const parsed: unknown = JSON.parse(content);
    const task = isRecord(parsed) ? (isRecord(parsed.task) ? parsed.task : parsed) : undefined;
    const id = task?.id;
    if (typeof id === 'string' || typeof id === 'number') return `Task #${id} created`;
  } catch {
    // not JSON; fall through
  }
  return content;
}

export class ClaudeCliTodoCapture {
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly deps: ClaudeCliTodoCaptureDeps) {}

  private state(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { tasks: new Map(), pending: new Map(), hydrated: false, chain: Promise.resolve() };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /** Register a just-assembled assistant message's todo tool calls (sync, lead unconfirmed). */
  noteAssistantToolUses(sessionId: string, content: readonly ToolUseLike[] | undefined): void {
    if (!sessionId || !Array.isArray(content)) return;
    let state: SessionState | undefined;
    for (const block of content) {
      if (block?.type !== 'tool_use' || !block.id || !block.name || !TRACKED_TOOLS.has(block.name)) continue;
      state ??= this.state(sessionId);
      if (state.pending.size >= MAX_PENDING_CALLS) {
        const oldest = state.pending.keys().next().value;
        if (oldest !== undefined) state.pending.delete(oldest);
      }
      state.pending.set(block.id, {
        name: block.name,
        input: isRecord(block.input) ? block.input : {},
        lead: false,
      });
    }
  }

  /**
   * The turn's attribution resolved. A sub-agent turn drops its calls; a lead turn
   * confirms them, applying TodoWrite now and any task call whose result already arrived.
   */
  noteTurnAttributed(
    sessionId: string,
    content: readonly ToolUseLike[] | undefined,
    isLead: boolean,
  ): Promise<TodoMetadataPatch | null> {
    const state = this.sessions.get(sessionId);
    if (!state || !Array.isArray(content)) return Promise.resolve(null);
    const ids = content
      .filter((b) => b?.type === 'tool_use' && typeof b.id === 'string' && state.pending.has(b.id))
      .map((b) => b.id as string);
    if (ids.length === 0) return Promise.resolve(null);
    if (!isLead) {
      for (const id of ids) state.pending.delete(id);
      return Promise.resolve(null);
    }
    return this.enqueue(sessionId, state, () => {
      const patch: TodoMetadataPatch = {};
      for (const id of ids) {
        const call = state.pending.get(id);
        if (!call) continue;
        call.lead = true;
        this.applyCall(state, id, call, patch);
      }
      return patch;
    });
  }

  /** Feed the tool_result blocks of the next request body (re-sent on every later body). */
  noteToolResults(sessionId: string, results: readonly ToolResultLike[]): Promise<TodoMetadataPatch | null> {
    const state = this.sessions.get(sessionId);
    if (!state || results.length === 0) return Promise.resolve(null);
    const relevant = results.filter((r) => state.pending.has(r.toolUseId));
    if (relevant.length === 0) return Promise.resolve(null);
    return this.enqueue(sessionId, state, () => {
      const patch: TodoMetadataPatch = {};
      for (const result of relevant) {
        const call = state.pending.get(result.toolUseId);
        if (!call) continue;
        call.result = result;
        this.applyCall(state, result.toolUseId, call, patch);
      }
      return patch;
    });
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Apply `call` to session state if it is ready; consumed calls leave `pending`. */
  private applyCall(state: SessionState, id: string, call: PendingCall, patch: TodoMetadataPatch): void {
    if (!call.lead) return;
    if (call.name === TODO_WRITE) {
      state.pending.delete(id);
      const todos = call.input.todos;
      if (Array.isArray(todos)) patch.currentTodos = todos;
      return;
    }
    if (!call.result) return;
    state.pending.delete(id);
    if (call.result.isError) return;
    const resultText =
      call.name === TASK_CREATE ? normalizeTaskCreateResult(call.result.content) : call.result.content;
    if (applyTaskListMutation(state.tasks, call.name, call.input, resultText)) {
      patch.currentTaskList = sortTaskList(state.tasks.values());
    }
  }

  private enqueue(
    sessionId: string,
    state: SessionState,
    compute: () => TodoMetadataPatch,
  ): Promise<TodoMetadataPatch | null> {
    const run = async (): Promise<TodoMetadataPatch | null> => {
      try {
        // Hydrate before the first mutation so a resumed session merges onto its board.
        if (!state.hydrated) {
          state.hydrated = true;
          const persisted = (await this.deps.loadMetadata(sessionId))?.currentTaskList;
          if (Array.isArray(persisted)) {
            for (const item of persisted as TaskListItem[]) {
              if (item && typeof item.id === 'string' && !state.tasks.has(item.id)) state.tasks.set(item.id, item);
            }
          }
        }
        const patch = compute();
        if (patch.currentTodos === undefined && patch.currentTaskList === undefined) return null;
        const current = (await this.deps.loadMetadata(sessionId)) ?? {};
        await this.deps.saveMetadata(sessionId, { ...current, ...patch });
        this.deps.notify(sessionId);
        return patch;
      } catch (err) {
        console.warn('[ClaudeCliTodoCapture] failed to persist todo state:', err);
        return null;
      }
    };
    const next = state.chain.then(run, run);
    state.chain = next;
    return next;
  }
}
