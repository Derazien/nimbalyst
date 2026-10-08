/**
 * Keeps each Claude CLI session's live permission mode current.
 *
 * Screen text arrives from the renderer's terminal emulator (the only model of the
 * screen; main sees raw PTY bytes), pushed through `terminal:update-render-state`.
 * Detection is throttled per session, and a changed reading is written to session
 * metadata (`cliPermissionMode`, merged, never replacing other keys) plus the
 * session `mode` column so the existing plan/agent state follows. Persistence and
 * timers are injected, so this has no electron dependency.
 */

import {
  parseClaudeCliPermissionMode,
  type ClaudeCliPermissionMode,
} from '../../../shared/claudeCliPermissionMode';
import { detectClaudeCliPermissionMode } from './claudeCliModeDetector';

export const CLAUDE_CLI_MODE_DETECT_THROTTLE_MS = 250;

export interface ClaudeCliModePersistPatch {
  /** Present when the live mode changed or was seeded from the launch flags. */
  cliPermissionMode?: ClaudeCliPermissionMode;
  /** Whether Shift+Tab can reach bypass in this CLI process. */
  cliBypassAvailable?: boolean;
}

export interface ClaudeCliModeTrackerDeps {
  persist: (sessionId: string, workspacePath: string, patch: ClaudeCliModePersistPatch) => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  throttleMs?: number;
}

/**
 * The mode a freshly spawned CLI starts in, read off its launch args. Null when it
 * is not knowable from the args alone (a resumed session restores its own mode).
 */
export function startingModeFromArgs(args: readonly string[]): ClaudeCliPermissionMode | null {
  if (args.includes('--resume') || args.includes('--continue')) return null;
  const flagAt = args.indexOf('--permission-mode');
  if (flagAt >= 0) {
    const value = parseClaudeCliPermissionMode(args[flagAt + 1]);
    if (value) return value;
  }
  if (args.includes('--dangerously-skip-permissions')) return 'bypassPermissions';
  return 'default';
}

/** Whether the launch flags put bypass in the Shift+Tab cycle. */
export function bypassAvailableFromArgs(args: readonly string[]): boolean {
  return (
    args.includes('--dangerously-skip-permissions') ||
    args.includes('--allow-dangerously-skip-permissions')
  );
}

interface SessionEntry {
  workspacePath: string;
  lastMode: ClaudeCliPermissionMode | null;
  pendingLines: readonly string[] | null;
  timerPending: boolean;
}

export class ClaudeCliModeTracker {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(private readonly deps: ClaudeCliModeTrackerDeps) {}

  private entry(sessionId: string, workspacePath: string): SessionEntry {
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = { workspacePath, lastMode: null, pendingLines: null, timerPending: false };
      this.sessions.set(sessionId, entry);
    }
    entry.workspacePath = workspacePath;
    return entry;
  }

  /** Last mode detected (or seeded) for the session, null if unknown. */
  getMode(sessionId: string): ClaudeCliPermissionMode | null {
    return this.sessions.get(sessionId)?.lastMode ?? null;
  }

  /** Record what the launch flags imply, before the first screen reading exists. */
  seed(
    sessionId: string,
    workspacePath: string,
    launch: { mode: ClaudeCliPermissionMode | null; bypassAvailable: boolean },
  ): void {
    const entry = this.entry(sessionId, workspacePath);
    entry.lastMode = launch.mode;
    void this.persist(sessionId, workspacePath, {
      ...(launch.mode ? { cliPermissionMode: launch.mode } : {}),
      cliBypassAvailable: launch.bypassAvailable,
    });
  }

  /** Feed the latest visible screen lines; detection runs at most once per throttle window. */
  noteScreen(sessionId: string, workspacePath: string, lines: readonly string[]): void {
    const entry = this.entry(sessionId, workspacePath);
    entry.pendingLines = lines;
    if (entry.timerPending) return;
    entry.timerPending = true;
    const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    setTimer(() => this.flush(sessionId), this.deps.throttleMs ?? CLAUDE_CLI_MODE_DETECT_THROTTLE_MS);
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private flush(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.timerPending = false;
    const lines = entry.pendingLines;
    entry.pendingLines = null;
    const detected = detectClaudeCliPermissionMode(lines);
    if (detected === null || detected === entry.lastMode) return;
    entry.lastMode = detected;
    void this.persist(sessionId, entry.workspacePath, { cliPermissionMode: detected });
  }

  private async persist(
    sessionId: string,
    workspacePath: string,
    patch: ClaudeCliModePersistPatch,
  ): Promise<void> {
    try {
      await this.deps.persist(sessionId, workspacePath, patch);
    } catch (err) {
      console.warn('[ClaudeCliModeTracker] failed to persist permission mode:', err);
    }
  }
}
