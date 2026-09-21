/**
 * What Nimbalyst knows about one running `kimi` terminal session: its kimi
 * session id, its turn state, and the transcript rows its event log produces.
 *
 * Signals, all verified against kimi 0.43.1:
 * - Before the first prompt there is no kimi session and no event log, so
 *   "ready and idle" comes from the terminal output: the status line
 *   (`context: N% ...`) is drawn only once the prompt box is up, never on the
 *   "Trust this folder?" picker that the first launch in a folder shows.
 * - After the first prompt kimi appends a row to session_index.jsonl; the
 *   runtime claims the first unclaimed row for its folder added since launch.
 * - From then on the session's wire.jsonl drives everything, through
 *   `KimiCliWireTranslator`.
 *
 * No electron, no PTY: the launcher feeds it terminal output and wires its
 * callbacks, so it tests against plain files.
 */

import type { ClaudeTurnState } from './claudeCliPidState';
import {
  JsonlFollower,
  findNewKimiSession,
  kimiSessionIndexMark,
  kimiWirePath,
} from './kimiCliSessionFiles';
import { KimiCliWireTranslator, type KimiTurnEndReason, type KimiWireAction } from './kimiCliWireTranslator';

export type KimiCliRow = Extract<KimiWireAction, { kind: 'row' }>;

export interface KimiCliSessionRuntimeOptions {
  /** The folder kimi was launched in. */
  workDir: string;
  indexPath: string;
  /** A kimi session this launch resumes (`-S <id>`), already resolved on disk. */
  resume?: { kimiSessionId: string; sessionDir: string };
  /** The `-m` value kimi was started with, if any. */
  launchModel?: string;
  /** Is this kimi session already another Nimbalyst session's? */
  isClaimed: (kimiSessionId: string) => boolean;
  onKimiSessionId: (kimiSessionId: string) => void;
  onTurnState: (state: ClaudeTurnState, endReason?: KimiTurnEndReason) => void;
  onRow: (row: KimiCliRow) => void;
  /** kimi is showing something only the person at the terminal can answer. */
  onNeedsAttention?: (why: 'trust') => void;
}

const ANSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const READY = /context:\s*\d+%/;
const TRUST = /Trust this folder\?/;
const OUTPUT_TAIL = 2000;
// kimi 2.0.2: the status line reads `K3-256k thinking: high`, and the `/effort`
// picker draws `Low  [ High ]  Max` under its title until the prompt box
// (`│ >`) or "Thinking set to ..." replaces it.
const THINKING = /thinking:\s*([a-z]+)/g;
const EFFORT_PICKER = 'Select thinking effort';
const EFFORT_PICKER_CLOSED = /Thinking set to|[│|]\s*>\s/;

function lastIndexOf(text: string, pattern: RegExp): number {
  const global = new RegExp(pattern.source, 'g');
  let last = -1;
  for (let m = global.exec(text); m; m = global.exec(text)) last = m.index;
  return last;
}

export class KimiCliSessionRuntime {
  private readonly translator = new KimiCliWireTranslator();
  private follower: JsonlFollower | null = null;
  private indexMark = 0;
  private sessionId: string | null = null;
  private turnState: ClaudeTurnState | null = null;
  private outputTail = '';
  /** Kept apart from `outputTail`, which every turn-state change clears. */
  private screenTail = '';
  private trustShown = false;
  private timer: NodeJS.Timeout | null = null;
  private model: string | null;
  private thinking: string | null = null;

  constructor(private readonly options: KimiCliSessionRuntimeOptions) {
    this.model = options.launchModel ?? null;
  }

  get kimiSessionId(): string | null {
    return this.sessionId;
  }

  getTurnState(): ClaudeTurnState | null {
    return this.turnState;
  }

  /** The model the event log last reported (`kimi-code/<alias>`), or the launch model until then. */
  getModel(): string | null {
    return this.model;
  }

  /**
   * The thinking effort kimi last showed on its status line or wrote to the
   * event log. The status line matters: before the first prompt there is no
   * session and no log, and that is when a launch applies the effort.
   */
  getThinkingEffort(): string | null {
    return this.thinking;
  }

  /** The levels in kimi's `/effort` picker, left to right, while it is on screen. */
  getEffortPickerLevels(): string[] | null {
    const at = this.screenTail.lastIndexOf(EFFORT_PICKER);
    if (at === -1) return null;
    const after = this.screenTail.slice(at + EFFORT_PICKER.length);
    if (EFFORT_PICKER_CLOSED.test(after)) return null;
    const line = after.split(/\r?\n/).filter((text) => /\[\s*[A-Za-z]+\s*\]/.test(text)).pop();
    if (!line) return null;
    return line.replace(/[[\]]/g, ' ').trim().split(/\s+/).map((level) => level.toLowerCase());
  }

  start(pollMs = 200): void {
    const { resume } = this.options;
    if (resume) {
      this.sessionId = resume.kimiSessionId;
      this.follow(resume.sessionDir, true);
    } else {
      this.indexMark = kimiSessionIndexMark(this.options.indexPath);
    }
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.follower?.stop();
  }

  /** One tick: discover the session if still unknown, then read new events. */
  poll(): void {
    if (!this.sessionId) {
      const found = findNewKimiSession({
        indexPath: this.options.indexPath,
        sinceOffset: this.indexMark,
        workDir: this.options.workDir,
        isClaimed: this.options.isClaimed,
      });
      if (!found) return;
      this.sessionId = found.sessionId;
      this.options.onKimiSessionId(found.sessionId);
      this.follow(found.sessionDir, false);
    }
    this.follower?.poll();
  }

  /** Raw PTY output, for the states the event log cannot report. */
  noteTerminalOutput(chunk: string): void {
    const text = chunk.replace(ANSI, '');
    this.outputTail = (this.outputTail + text).slice(-OUTPUT_TAIL);
    // Only what this chunk completed: an older status line still in the tail
    // must not overwrite a newer value the event log reported.
    const carry = this.screenTail.slice(-40);
    for (const match of (carry + text).matchAll(THINKING)) {
      if ((match.index ?? 0) + match[0].length > carry.length) this.thinking = match[1];
    }
    this.screenTail = (this.screenTail + text).slice(-OUTPUT_TAIL);
    // The picker's text can still be in the tail when the prompt box replaces
    // it, so whichever was drawn last decides.
    if (lastIndexOf(this.outputTail, TRUST) > lastIndexOf(this.outputTail, READY)) {
      if (!this.trustShown) {
        this.trustShown = true;
        this.options.onNeedsAttention?.('trust');
      }
      return;
    }
    if (this.turnState === null && READY.test(this.outputTail)) {
      this.setTurnState('idle');
    }
  }

  private follow(sessionDir: string, startAtEnd: boolean): void {
    this.follower = new JsonlFollower(
      kimiWirePath(sessionDir),
      (line) => {
        for (const action of this.translator.translateLine(line)) {
          if (action.kind === 'turn-state') this.setTurnState(action.state, action.endReason);
          else if (action.kind === 'model') this.model = action.alias;
          else if (action.kind === 'thinking') this.thinking = action.effort;
          else this.options.onRow(action);
        }
      },
      { startAtEnd },
    );
  }

  private setTurnState(state: ClaudeTurnState, endReason?: KimiTurnEndReason): void {
    this.turnState = state;
    // The trust picker is gone once kimi is idle or working.
    this.trustShown = false;
    this.outputTail = '';
    this.options.onTurnState(state, endReason);
  }
}
