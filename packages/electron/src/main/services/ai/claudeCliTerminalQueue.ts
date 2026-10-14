/**
 * Busy-time prompts go into the Claude CLI's OWN queue.
 *
 * A prompt sent while a CLI turn is running used to wait in Nimbalyst's queue
 * until the turn ended (or until a send-now pressed Ctrl+C). The CLI has its own
 * queue: text pasted and submitted with a plain Enter mid-turn is queued and
 * absorbed at the next tool boundary, or run right away when only background
 * agents are working. Verified on CLI 2.1.296 with the 07 probes
 * (`nimbalyst-local/cli-paste-probes/07-*.mjs`).
 *
 * The Nimbalyst row stays `pending` with a `cliTerminalQueue` marker in its
 * document context while the CLI holds it, and is completed (and only then
 * written to the transcript) once the CLI's session jsonl shows it consumed.
 *
 * Pure core: screen reading and jsonl matching. Production wiring lives in
 * `claudeCliTerminalQueueSingleton.ts`.
 */

/** Stored on a forwarded row's document context. */
export interface CliTerminalQueueMarker {
  /** When Nimbalyst typed the row into the CLI (epoch ms). */
  typedAt: number;
  /** The exact text typed, which is what the jsonl records. */
  typedText: string;
  /** The session jsonl the CLI writes. */
  jsonlPath: string;
  /** Byte size of that jsonl just before typing; only later entries count. */
  jsonlOffset: number;
  /** Set once the CLI shows it holds the row in its queue (epoch ms). */
  queuedAt?: number;
}

export function readCliTerminalQueueMarker(documentContext: unknown): CliTerminalQueueMarker | null {
  if (!documentContext || typeof documentContext !== 'object') return null;
  const marker = (documentContext as { cliTerminalQueue?: unknown }).cliTerminalQueue;
  if (!marker || typeof marker !== 'object') return null;
  const m = marker as Partial<CliTerminalQueueMarker>;
  if (typeof m.typedText !== 'string' || typeof m.jsonlPath !== 'string') return null;
  return {
    typedAt: typeof m.typedAt === 'number' ? m.typedAt : 0,
    typedText: m.typedText,
    jsonlPath: m.jsonlPath,
    jsonlOffset: typeof m.jsonlOffset === 'number' ? m.jsonlOffset : 0,
    ...(typeof m.queuedAt === 'number' ? { queuedAt: m.queuedAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

const BOX_RULE = /^[\s╭╰╮╯│|]*[─━]{8,}/u;
const PROMPT_ROW = /^\s*[│|]?\s*[❯>](?:\s|$)/u;
/** The input row's placeholder while the CLI holds queued messages. */
export const CLI_QUEUED_HINT = /^Press up to edit queued messages$/i;
/** Lines that only appear while a selection dialog owns the keyboard. */
const DIALOG_MARKERS: readonly RegExp[] = [
  /\besc to cancel\b/i,
  /\benter to select\b/i,
  /↑\/↓ to navigate/,
];
const TAIL_LINES = 14;

/**
 * The CLI's input box, read bottom-up: the last two box rules and the rows
 * between them, the first of which is the `❯` prompt row. Null when the screen
 * shows no input box (a dialog, a question, the CLI starting).
 */
export function readCliInputBox(lines: readonly string[] | null | undefined): { text: string } | null {
  if (!Array.isArray(lines)) return null;
  const rows = lines.map((line) => (typeof line === 'string' ? line.trimEnd() : ''));
  let bottom = -1;
  let top = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (!BOX_RULE.test(rows[i])) continue;
    if (bottom < 0) bottom = i;
    else { top = i; break; }
  }
  if (top < 0 || bottom - top < 2) return null;
  const inside = rows.slice(top + 1, bottom);
  if (!PROMPT_ROW.test(inside[0])) return null;
  const first = inside[0].replace(/^\s*[│|]?\s*[❯>]\s?/u, '');
  const text = [first, ...inside.slice(1)].map((row) => row.replace(/[│|]\s*$/u, '').trim()).join('\n').trim();
  return { text };
}

function tail(lines: readonly string[]): string[] {
  return lines.map((line) => (typeof line === 'string' ? line : '')).filter((line) => line.trim()).slice(-TAIL_LINES);
}

/**
 * Safe to paste a prompt into the CLI: its input box is on screen, nothing the
 * user typed is in it (only the queued-messages placeholder at most), and no
 * dialog owns the keyboard.
 */
export function canTypeIntoCliQueue(lines: readonly string[] | null | undefined): boolean {
  const box = readCliInputBox(lines);
  if (!box) return false;
  if (box.text && !CLI_QUEUED_HINT.test(box.text)) return false;
  return !tail(lines as readonly string[]).some((line) => DIALOG_MARKERS.some((marker) => marker.test(line)));
}

/** The CLI shows it is holding queued messages. */
export function cliShowsQueuedMessages(lines: readonly string[] | null | undefined): boolean {
  const box = readCliInputBox(lines);
  return !!box && CLI_QUEUED_HINT.test(box.text);
}

// ---------------------------------------------------------------------------
// jsonl
// ---------------------------------------------------------------------------

/**
 * CLI 2.1.299 logs a long pasted prompt inside `<pasted_content id="eeae">` ...
 * `</pasted_content id="eeae">`; the typed text has no such tags.
 */
const PASTED_CONTENT_TAG = /<\/?pasted_content(?:\s+id="[^"]*")?>/g;

export function normalizePromptText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(PASTED_CONTENT_TAG, '').trim();
}

function userEntryText(entry: Record<string, any>): string | null {
  const origin = entry.origin?.kind;
  if (origin !== undefined && origin !== 'human') return null;
  if (entry.isMeta) return null;
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  if (content.some((block) => block?.type === 'tool_result')) return null;
  const texts = content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text);
  return texts.length ? texts.join('\n') : null;
}

export type CliQueueEvent =
  | { kind: 'queued'; text: string }
  | { kind: 'consumed'; text: string };

/**
 * What one jsonl entry says about a typed prompt. The CLI records:
 *  - `queue-operation enqueue {content}` when it queues the prompt;
 *  - `queue-operation remove {content, reason: absorbed_mid_turn}` (plus a
 *    `queued_command` attachment) when it folds it into the running turn;
 *  - a human-origin `user` entry with the text when it runs it as a turn
 *    (after a `dequeue`, on Ctrl+Enter, or at once while a foreground agent
 *    runs, with no queue operation at all).
 */
export function cliQueueEventOf(entry: unknown): CliQueueEvent | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, any>;
  if (e.type === 'queue-operation' && typeof e.content === 'string') {
    if (e.operation === 'enqueue') return { kind: 'queued', text: normalizePromptText(e.content) };
    if (e.operation === 'remove' && e.reason === 'absorbed_mid_turn') {
      return { kind: 'consumed', text: normalizePromptText(e.content) };
    }
    return null;
  }
  if (e.type === 'user') {
    const text = userEntryText(e);
    return text === null ? null : { kind: 'consumed', text: normalizePromptText(text) };
  }
  return null;
}

export interface TypedRow {
  id: string;
  typedText: string;
  typedAt: number;
}

/**
 * Match jsonl entries to typed rows, oldest row first for identical text.
 * Returns the ids the CLI queued and the ids it consumed (a consumed row is
 * also reported queued only when an enqueue for it was seen).
 */
export function matchCliQueueEntries(
  entries: readonly unknown[],
  rows: readonly TypedRow[],
): { queued: string[]; consumed: string[]; unmatchedConsumed: string[] } {
  const ordered = [...rows].sort((a, b) => a.typedAt - b.typedAt);
  const queued = new Set<string>();
  const consumed = new Set<string>();
  const unmatchedConsumed: string[] = [];
  for (const entry of entries) {
    const event = cliQueueEventOf(entry);
    if (!event) continue;
    const taken = event.kind === 'queued' ? queued : consumed;
    const row = ordered.find((r) => !taken.has(r.id) && !consumed.has(r.id) && normalizePromptText(r.typedText) === event.text);
    if (row) taken.add(row.id);
    else if (event.kind === 'consumed' && event.text) unmatchedConsumed.push(event.text);
  }
  return { queued: [...queued], consumed: [...consumed], unmatchedConsumed };
}

/** Complete jsonl lines in `chunk`, and how many bytes of it they used. */
export function splitJsonlChunk(chunk: string): { entries: unknown[]; consumedBytes: number } {
  const lastNewline = chunk.lastIndexOf('\n');
  if (lastNewline < 0) return { entries: [], consumedBytes: 0 };
  const complete = chunk.slice(0, lastNewline + 1);
  const entries: unknown[] = [];
  for (const line of complete.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* a torn or foreign line */ }
  }
  return { entries, consumedBytes: Buffer.byteLength(complete, 'utf8') };
}

/** A prompt that must keep the idle path: the CLI may run a command at once instead of queueing it. */
export function mustWaitForIdle(prompt: string): boolean {
  const trimmed = prompt.trim();
  return trimmed.startsWith('/') || trimmed.startsWith('#');
}
