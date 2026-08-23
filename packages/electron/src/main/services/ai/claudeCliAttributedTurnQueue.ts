/**
 * Serial, order-preserving persistence of observed `claude-code-cli` turns.
 *
 * ## Why a queue at all
 *
 * Attributing a turn to its sub-agent means reading the CLI's sidecar, which can
 * lag the response by a few milliseconds, so the wait is variable per turn. The
 * transcript is read back `ORDER BY id ASC`, and ids come from insert order, so
 * anything that lets a slow turn finish after a fast one silently reorders the
 * user's transcript. A per-session serial queue makes insert order equal
 * observation order no matter how long any single attribution takes.
 *
 * This also tightens what was there before: persistence used to be fire-and-forget
 * (`void persistAssistantTurn(...)`) with awaits inside, so two turns observed
 * close together could already race.
 *
 * ## What "unattributed" means
 *
 * Undefined attribution means "we do not know", not "this is the lead's". Unknown
 * turns are persisted visible, which is what the app does with every other kind of
 * output, and their message ids are remembered as lead ids so a fork cannot later
 * claim them. Hiding on a guess is exactly what the retired in-flight flag did.
 */

export interface ObservedTurn<TMessage> {
  /** Anthropic message id (`msg_…`), the join key against the sidecars. */
  messageId: string;
  message: TMessage;
}

export interface AttributedTurnQueueDeps<TMessage> {
  /**
   * Resolve the spawning tool_use id for this turn, or undefined when it is the
   * lead's or not attributable. Only called when `shouldAttribute` says so.
   */
  resolveParentToolUseId(turn: ObservedTurn<TMessage>): Promise<string | undefined>;
  /** Persist one turn. Awaited, so the next turn cannot overtake it. */
  persist(turn: ObservedTurn<TMessage>, parentToolUseId: string | undefined): Promise<void>;
  /**
   * Whether attribution is worth attempting at all. False for a session that has
   * never spawned a sub-agent, which skips the sidecar read entirely.
   */
  shouldAttribute(): boolean;
  /** Called after each turn is persisted, with what it resolved to. */
  onPersisted?(turn: ObservedTurn<TMessage>, parentToolUseId: string | undefined): void;
  /** Reported rather than thrown: one bad turn must not stall the queue. */
  onError?(error: unknown, turn: ObservedTurn<TMessage>): void;
}

export interface AttributedTurnQueue<TMessage> {
  /** Enqueue a turn. Returns immediately; ordering is by call order. */
  enqueue(turn: ObservedTurn<TMessage>): void;
  /** Resolves when everything enqueued so far has been persisted (tests). */
  drain(): Promise<void>;
  /** Message ids persisted without attribution, i.e. the lead's. */
  leadMessageIds(): ReadonlySet<string>;
}

export function createAttributedTurnQueue<TMessage>(
  deps: AttributedTurnQueueDeps<TMessage>,
): AttributedTurnQueue<TMessage> {
  const pending: Array<ObservedTurn<TMessage>> = [];
  const leadIds = new Set<string>();
  let running: Promise<void> | null = null;

  async function runOne(turn: ObservedTurn<TMessage>): Promise<void> {
    let parentToolUseId: string | undefined;
    try {
      if (deps.shouldAttribute()) {
        parentToolUseId = await deps.resolveParentToolUseId(turn);
      }
    } catch (error) {
      // Attribution is best-effort. A failure degrades the turn to unattributed,
      // which shows it at the top level, rather than losing it.
      deps.onError?.(error, turn);
      parentToolUseId = undefined;
    }

    if (!parentToolUseId && turn.messageId) leadIds.add(turn.messageId);

    try {
      await deps.persist(turn, parentToolUseId);
      deps.onPersisted?.(turn, parentToolUseId);
    } catch (error) {
      deps.onError?.(error, turn);
    }
  }

  async function pump(): Promise<void> {
    while (pending.length > 0) {
      const turn = pending.shift()!;
      await runOne(turn);
    }
    running = null;
  }

  return {
    enqueue(turn) {
      pending.push(turn);
      if (!running) running = pump();
    },
    async drain() {
      while (running) await running;
    },
    leadMessageIds: () => leadIds,
  };
}
