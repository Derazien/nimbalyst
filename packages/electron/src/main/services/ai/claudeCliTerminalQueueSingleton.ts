/**
 * Production wiring for busy-time prompts going into the Claude CLI's own queue
 * (`claudeCliTerminalQueue.ts` holds the pure rules and the evidence).
 *
 * - `forwardPendingIntoClaudeCli` types every pending row into a BUSY CLI as
 *   soon as its input box is free (no dialog, nothing typed by hand), oldest
 *   first, and marks each row as held by the CLI.
 * - A watcher tails the session jsonl while the CLI holds rows: an `enqueue`
 *   (or the "Press up to edit queued messages" placeholder) marks the row as in
 *   the CLI's queue; a consumption completes it and only then writes the
 *   transcript user row.
 * - `sendClaudeCliQueuedNow` is the CLI's own send-now (Ctrl+Enter). Never Ctrl+C.
 *
 * Rows typed in this app run are tracked in memory, so the watcher costs no
 * database reads. A marked row the tracker does not know (left by a previous
 * run, whose CLI and its queue are gone) is released by the idle flush.
 */

import fs from 'fs';
import { BrowserWindow } from 'electron';
import { resolveClaudeConfigDir } from '@nimbalyst/runtime/ai/server/providers/claudeCode/claudeConfigDir';
import type { ChatAttachment, PromptProvenance } from '@nimbalyst/runtime/ai/server/types';
import { getQueuedPromptsStore } from '../RepositoryManager';
import { getSyncProvider } from '../SyncManager';
import { getTerminalSessionManager } from '../TerminalSessionManager';
import { typeIntoClaudeCliQueue } from './claudeCliSubmit';
import { claudeCliSubmitLatch } from './claudeCliSubmitLatch';
import { claudeCliInterruptGate } from './claudeCliInterruptGate';
import { resolveClaudeCliJsonlPath } from './claudeCliJsonlPath';
import { logClaudeCliUserPrompt } from './claudeCliUserPromptLog';
import { publishQueuedPromptClaim } from './queuedPromptClaimEvents';
import { publishQueuedPromptsToSync } from './queuedPromptSyncPublisher';
import { flushNextClaudeCliQueuedPromptForSession } from './claudeCliQueueFlushSingleton';
import { broadcastClaudeCliRevealTerminal } from './claudeCliRevealTerminal';
import {
  CLI_QUEUED_HINT,
  canTypeIntoCliQueue,
  cliShowsQueuedMessages,
  matchCliQueueEntries,
  mustWaitForIdle,
  readCliInputBox,
  readCliTerminalQueueMarker,
  splitJsonlChunk,
  type CliTerminalQueueMarker,
} from './claudeCliTerminalQueue';

/** The CLI's own send-now: Ctrl+Enter in the kitty keyboard encoding. */
export const CLI_SEND_NOW_KEY = '\x1b[13;5u';
const WATCH_INTERVAL_MS = 500;
/** A held row the CLI has not taken after this long idle was pulled back by hand. */
const STALE_IDLE_MS = 20_000;

interface TrackedRow {
  id: string;
  prompt: string;
  attachments?: ChatAttachment[];
  promptProvenance?: PromptProvenance;
  marker: CliTerminalQueueMarker;
}

interface SessionQueue {
  workspacePath: string;
  jsonlPath: string;
  rows: Map<string, TrackedRow>;
  readPosition: number | null;
  timer: NodeJS.Timeout | null;
  idleSince: number | null;
  /** Rows pulled back into the CLI's input with Up for editing; the next prompt it takes is their edit. */
  editing: TrackedRow[];
}

const sessions = new Map<string, SessionQueue>();
const typingInFlight = new Set<string>();
/** Sessions with rows held back by a dialog, retried on the next screen change. */
const heldByScreen = new Set<string>();

/** Called at launch: where this session's CLI writes its jsonl. */
export function registerClaudeCliTerminalQueue(input: {
  sessionId: string;
  workspacePath: string;
  cwd: string;
  cliSessionId: string;
}): void {
  const jsonlPath = resolveClaudeCliJsonlPath({
    configDir: resolveClaudeConfigDir(),
    cwd: input.cwd,
    sessionId: input.cliSessionId,
  });
  const existing = sessions.get(input.sessionId);
  if (existing) {
    existing.workspacePath = input.workspacePath;
    existing.jsonlPath = jsonlPath;
    return;
  }
  sessions.set(input.sessionId, {
    workspacePath: input.workspacePath,
    jsonlPath,
    rows: new Map(),
    readPosition: null,
    timer: null,
    idleSince: null,
    editing: [],
  });
}

/** True when this app run typed the row into the CLI and is still watching it. */
export function isClaudeCliTerminalRowTracked(sessionId: string, promptId: string): boolean {
  return !!sessions.get(sessionId)?.rows.has(promptId);
}

/**
 * A row marked by an earlier app run: read that CLI's log from where the row
 * was typed. If the CLI took it, complete it and write its transcript row now;
 * otherwise clear the marker so it is sent again. Never resends a taken row.
 */
export async function settleUntrackedClaudeCliTerminalRow(
  sessionId: string,
  workspacePath: string,
  promptId: string,
): Promise<'consumed' | 'released'> {
  const store = getQueuedPromptsStore();
  const row = await store.get(promptId);
  const marker = readCliTerminalQueueMarker(row?.documentContext);
  if (!row || !marker) return 'released';
  let entries: unknown[] = [];
  try {
    const buffer = fs.readFileSync(marker.jsonlPath).subarray(marker.jsonlOffset);
    entries = splitJsonlChunk(buffer.toString('utf8')).entries;
  } catch {
    // No log to read: the CLI never ran, so it cannot have taken the row.
  }
  const { consumed } = matchCliQueueEntries(entries, [{ id: promptId, typedText: marker.typedText, typedAt: marker.typedAt }]);
  if (consumed.includes(promptId)) {
    await store.complete(promptId);
    await logClaudeCliUserPrompt({
      sessionId,
      workspacePath,
      prompt: row.prompt,
      attachments: row.attachments as ChatAttachment[] | undefined,
      promptProvenance: row.documentContext?.promptProvenance,
    });
    notifyClaimed(sessionId, promptId);
    console.log(`[ClaudeCliTerminalQueue] ${promptId} was already taken by the earlier CLI; completed, not resent`);
    return 'consumed';
  }
  await store.setCliTerminalQueueMarker(promptId, null);
  console.log(`[ClaudeCliTerminalQueue] ${promptId} was never taken by the earlier CLI; released to send again`);
  return 'released';
}

/** The CLI exited: its queue is gone, so rows it held go back to Nimbalyst's queue. */
export async function releaseClaudeCliTerminalQueue(sessionId: string): Promise<void> {
  const queue = sessions.get(sessionId);
  if (!queue) return;
  stopWatcher(queue);
  const ids = [...queue.rows.keys()];
  queue.rows.clear();
  queue.readPosition = null;
  queue.editing = [];
  // The CLI may have taken a row just before it exited; its log decides.
  for (const id of ids) {
    await settleUntrackedClaudeCliTerminalRow(sessionId, queue.workspacePath, id).catch(() => 'released');
  }
  if (ids.length) notifyQueueChanged(sessionId);
}

/**
 * Edit a prompt the CLI holds: press Up, which pulls the CLI's queued messages
 * back into its input box without stopping the turn (never Esc: a second Esc
 * stops the turn), and open the terminal so it can be edited there. The rows
 * leave Nimbalyst's queue; the next prompt the CLI takes is logged as their edit.
 */
export async function pullClaudeCliQueuedBackForEdit(sessionId: string): Promise<{ pulled: boolean; reason?: string }> {
  const queue = sessions.get(sessionId);
  const manager = getTerminalSessionManager();
  if (!queue || queue.rows.size === 0) return { pulled: false, reason: 'nothing in the terminal queue' };
  if (!manager.isTerminalActive(sessionId)) return { pulled: false, reason: 'terminal not running' };
  if (!canTypeIntoCliQueue(manager.getScreenLines(sessionId))) {
    return { pulled: false, reason: 'the terminal input is busy (a dialog, or text typed there)' };
  }
  manager.writeToTerminal(sessionId, '\x1b[A');
  broadcastClaudeCliRevealTerminal({ sessionId, interactive: true, source: 'input', command: 'edit-queued' });
  const store = getQueuedPromptsStore();
  const rows = [...queue.rows.values()].sort((a, b) => a.marker.typedAt - b.marker.typedAt);
  queue.rows.clear();
  queue.editing.push(...rows);
  for (const row of rows) {
    await store.complete(row.id);
    notifyClaimed(sessionId, row.id);
  }
  notifyQueueChanged(sessionId);
  startWatcher(sessionId, queue);
  console.log(`[ClaudeCliTerminalQueue] pulled ${rows.length} queued prompt(s) back into the CLI input for editing in ${sessionId}`);
  return { pulled: true };
}

function notifyQueueChanged(sessionId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('ai:queuedPromptsReceived', { sessionId, promptCount: 0 });
  }
  const store = getQueuedPromptsStore();
  void publishQueuedPromptsToSync(
    { listPending: (s) => store.listPending(s), getSyncProvider, logWarn: (m) => console.warn(m) },
    sessionId,
  );
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function inputIsFree(sessionId: string): boolean {
  // No box (a dialog took over) also counts: never press Enter into a dialog.
  const box = readCliInputBox(getTerminalSessionManager().getScreenLines(sessionId));
  return !box || !box.text || CLI_QUEUED_HINT.test(box.text);
}

/**
 * Type every pending row into a busy CLI, oldest first. Stops at the first row
 * that has to wait (a slash command keeps the idle path, or the screen is not
 * free), so the CLI receives rows in the order they were sent.
 */
export async function forwardPendingIntoClaudeCli(sessionId: string): Promise<void> {
  const queue = sessions.get(sessionId);
  if (!queue || typingInFlight.has(sessionId)) return;
  const manager = getTerminalSessionManager();
  if (!manager.isTerminalActive(sessionId)) return;
  if (claudeCliInterruptGate.isInFlight(sessionId)) return;

  typingInFlight.add(sessionId);
  let typedAny = false;
  try {
    const store = getQueuedPromptsStore();
    const pending = await store.listPending(sessionId);
    heldByScreen.delete(sessionId);
    for (const row of pending) {
      if (readCliTerminalQueueMarker(row.documentContext)) continue;
      if (mustWaitForIdle(row.prompt) && !(row.attachments?.length)) break;
      if ((await manager.getClaudeCliLiveTurnState(sessionId)) !== 'running') break;
      if (!canTypeIntoCliQueue(manager.getScreenLines(sessionId))) {
        heldByScreen.add(sessionId);
        break;
      }

      const jsonlOffset = fileSize(queue.jsonlPath);
      const typedText = await typeIntoClaudeCliQueue(
        {
          sessionId,
          workspacePath: queue.workspacePath,
          prompt: row.prompt,
          attachments: row.attachments as ChatAttachment[] | undefined,
          documentContext: row.documentContext as any,
        },
        {
          writeToTerminal: (id, data) => {
            claudeCliSubmitLatch.mark(id, data.length);
            manager.writeToTerminal(id, data);
          },
          delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          isInputEmpty: (id) => inputIsFree(id),
        },
      );
      if (!typedText) continue;

      const marker: CliTerminalQueueMarker = { typedAt: Date.now(), typedText, jsonlPath: queue.jsonlPath, jsonlOffset };
      await store.setCliTerminalQueueMarker(row.id, marker as unknown as Record<string, unknown>);
      queue.rows.set(row.id, {
        id: row.id,
        prompt: row.prompt,
        attachments: row.attachments as ChatAttachment[] | undefined,
        promptProvenance: row.documentContext?.promptProvenance,
        marker,
      });
      if (queue.readPosition === null || jsonlOffset < queue.readPosition) queue.readPosition = jsonlOffset;
      typedAny = true;
      console.log(`[ClaudeCliTerminalQueue] typed ${row.id} into the busy CLI for ${sessionId}`);
    }
  } catch (error) {
    console.warn('[ClaudeCliTerminalQueue] forward failed:', error);
  } finally {
    typingInFlight.delete(sessionId);
  }
  if (typedAny) {
    notifyQueueChanged(sessionId);
    startWatcher(sessionId, queue);
  }
}

/** Throttled shadow-screen callback: forward held rows the moment the dialog is gone. */
export function noteClaudeCliTerminalQueueScreen(sessionId: string, lines: readonly string[]): void {
  if (heldByScreen.has(sessionId) && canTypeIntoCliQueue(lines)) {
    void forwardPendingIntoClaudeCli(sessionId);
  }
}

/**
 * Send now: the CLI's Ctrl+Enter runs what it holds right away. Rows not yet
 * typed are typed first when the screen allows. Never Ctrl+C.
 */
export async function sendClaudeCliQueuedNow(sessionId: string): Promise<{ sent: boolean }> {
  const manager = getTerminalSessionManager();
  if (!manager.isTerminalActive(sessionId)) return { sent: false };
  const live = await manager.getClaudeCliLiveTurnState(sessionId);
  if (live !== 'running') {
    const queue = sessions.get(sessionId);
    if (queue) return { sent: await flushNextClaudeCliQueuedPromptForSession(sessionId, queue.workspacePath) };
    return { sent: false };
  }
  await forwardPendingIntoClaudeCli(sessionId);
  const queue = sessions.get(sessionId);
  if (!queue || queue.rows.size === 0) {
    console.log(`[ClaudeCliTerminalQueue] send now: nothing held in the CLI for ${sessionId}`);
    return { sent: false };
  }
  if (!readCliInputBox(manager.getScreenLines(sessionId))) {
    console.log(`[ClaudeCliTerminalQueue] send now: no input box on screen for ${sessionId} (a dialog is open)`);
    return { sent: false };
  }
  manager.writeToTerminal(sessionId, CLI_SEND_NOW_KEY);
  console.log(`[ClaudeCliTerminalQueue] send now: pressed Ctrl+Enter in ${sessionId} (${queue.rows.size} held)`);
  return { sent: true };
}

function startWatcher(sessionId: string, queue: SessionQueue): void {
  if (queue.timer) return;
  queue.idleSince = null;
  queue.timer = setInterval(() => void watchTick(sessionId), WATCH_INTERVAL_MS);
  queue.timer.unref?.();
}

function stopWatcher(queue: SessionQueue): void {
  if (queue.timer) clearInterval(queue.timer);
  queue.timer = null;
}

function readNewEntries(queue: SessionQueue): unknown[] {
  if (queue.readPosition === null) return [];
  let fd: number | null = null;
  try {
    const size = fs.statSync(queue.jsonlPath).size;
    if (size <= queue.readPosition) return [];
    fd = fs.openSync(queue.jsonlPath, 'r');
    const buffer = Buffer.alloc(size - queue.readPosition);
    fs.readSync(fd, buffer, 0, buffer.length, queue.readPosition);
    const { entries, consumedBytes } = splitJsonlChunk(buffer.toString('utf8'));
    queue.readPosition += consumedBytes;
    return entries;
  } catch {
    return [];
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

const tickInFlight = new Set<string>();

async function watchTick(sessionId: string): Promise<void> {
  const queue = sessions.get(sessionId);
  if (!queue) return;
  if (queue.rows.size === 0 && queue.editing.length === 0) {
    stopWatcher(queue);
    queue.readPosition = null;
    return;
  }
  if (typingInFlight.has(sessionId) || tickInFlight.has(sessionId)) return;
  tickInFlight.add(sessionId);
  try {
    const manager = getTerminalSessionManager();
    if (!manager.isTerminalActive(sessionId)) {
      await releaseClaudeCliTerminalQueue(sessionId);
      return;
    }
    const store = getQueuedPromptsStore();
    const rows = [...queue.rows.values()];
    const { queued, consumed, unmatchedConsumed } = matchCliQueueEntries(
      readNewEntries(queue),
      rows.map((r) => ({ id: r.id, typedText: r.marker.typedText, typedAt: r.marker.typedAt })),
    );

    let changed = false;
    const showsQueued = cliShowsQueuedMessages(manager.getScreenLines(sessionId));
    for (const row of rows) {
      if (consumed.includes(row.id) || row.marker.queuedAt) continue;
      if (queued.includes(row.id) || showsQueued) {
        row.marker = { ...row.marker, queuedAt: Date.now() };
        await store.setCliTerminalQueueMarker(row.id, row.marker as unknown as Record<string, unknown>);
        changed = true;
      }
    }

    for (const id of consumed) {
      const row = queue.rows.get(id);
      if (!row) continue;
      queue.rows.delete(id);
      await store.complete(id);
      // The transcript row is written now, when the CLI took the prompt.
      await logClaudeCliUserPrompt({
        sessionId,
        workspacePath: queue.workspacePath,
        prompt: row.prompt,
        attachments: row.attachments,
        promptProvenance: row.promptProvenance,
      });
      notifyClaimed(sessionId, id);
      changed = true;
      console.log(`[ClaudeCliTerminalQueue] the CLI took ${id} for ${sessionId}`);
    }

    if (queue.editing.length > 0 && unmatchedConsumed.length > 0) {
      // The edited prompt: log it as the user's message, in place of the originals.
      const original = queue.editing[0];
      queue.editing = [];
      await logClaudeCliUserPrompt({
        sessionId,
        workspacePath: queue.workspacePath,
        prompt: unmatchedConsumed[0],
        promptProvenance: original.promptProvenance,
      });
      console.log(`[ClaudeCliTerminalQueue] the CLI took the edited prompt for ${sessionId}`);
    }

    const live = await manager.getClaudeCliLiveTurnState(sessionId);
    if (live === 'idle') {
      queue.idleSince ??= Date.now();
      if (Date.now() - queue.idleSince >= STALE_IDLE_MS && queue.editing.length > 0) {
        // Idle with the edit never sent: it stays in the terminal's input, not ours.
        queue.editing = [];
      }
      if (Date.now() - queue.idleSince >= STALE_IDLE_MS && queue.rows.size > 0) {
        // Idle this long, the CLI is not holding these: they were pulled back
        // into the terminal's input by hand. They are the terminal's now.
        for (const id of [...queue.rows.keys()]) {
          queue.rows.delete(id);
          await store.complete(id);
          notifyClaimed(sessionId, id);
          console.log(`[ClaudeCliTerminalQueue] released ${id}: the CLI no longer holds it`);
        }
        changed = true;
      }
    } else {
      queue.idleSince = null;
    }

    if (changed) notifyQueueChanged(sessionId);
    if (queue.rows.size === 0 && queue.editing.length === 0) {
      stopWatcher(queue);
      queue.readPosition = null;
      // Rows held behind the ones the CLI just took drain on the idle path.
      if (live === 'idle') void flushNextClaudeCliQueuedPromptForSession(sessionId, queue.workspacePath);
      else void forwardPendingIntoClaudeCli(sessionId);
    }
  } catch (error) {
    console.warn('[ClaudeCliTerminalQueue] watch tick failed:', error);
  } finally {
    tickInFlight.delete(sessionId);
  }
}

function notifyClaimed(sessionId: string, promptId: string): void {
  publishQueuedPromptClaim({ sessionId, promptId });
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('ai:promptClaimed', { sessionId, promptId });
  }
}
