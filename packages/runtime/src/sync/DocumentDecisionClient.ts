import type {
  DocDecisionStateMessage,
  DocumentDecisionCommand,
  DocumentDecisionDeliveryState,
  DocumentDecisionAuthority,
  DocumentDecisionResult,
  DocClientMessage,
} from "@nimbalyst/collab-protocol";

class StaleDecisionReadError extends Error {
  constructor() {
    super("Feedback status changed while loading. Refresh again.");
  }
}

/** Correlated, viewer-scoped projections; mutation acknowledgements are never replayed. */
export class DocumentDecisionClient {
  private listing: Promise<DocumentDecisionResult> | undefined;
  private retryWait:
    | { timer: ReturnType<typeof setTimeout>; reject: (error: Error) => void }
    | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshing = false;
  private mutations = 0;
  private refreshAgain = false;
  private epoch = 0;
  private connection = 0;
  private sequence = 0;
  private applied = 0;
  private state: DocumentDecisionDeliveryState[] = [];
  private authority: DocumentDecisionAuthority = { loaded: false };
  private listeners = new Set<
    (
      state: DocumentDecisionDeliveryState[],
      authority: DocumentDecisionAuthority
    ) => void
  >();
  private pending = new Map<
    string,
    {
      resolve: (value: DocumentDecisionResult) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      epoch: number;
      sequence: number;
      operation: DocumentDecisionCommand["operation"];
    }
  >();

  constructor(
    private readonly send: (message: DocClientMessage) => void,
    private readonly ready: () => boolean,
    private readonly flush: () => Promise<boolean>
  ) {}

  getState = (): DocumentDecisionDeliveryState[] => this.state;
  subscribe = (
    listener: (
      state: DocumentDecisionDeliveryState[],
      authority: DocumentDecisionAuthority
    ) => void
  ): (() => void) => {
    this.listeners.add(listener);
    listener(this.state, this.authority);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(): void {
    for (const listener of this.listeners) listener(this.state, this.authority);
  }
  private clear(): void {
    this.epoch++;
    this.state = [];
    this.authority = { loaded: false };
    this.publish();
  }
  hasPendingMutations = (): boolean => this.mutations > 0;

  request(command: DocumentDecisionCommand): Promise<DocumentDecisionResult> {
    if (command.operation === "list") {
      if (this.listing) return this.listing;
      const connection = this.connection;
      const listing = this.requestFreshList()
        .catch((error) => {
          if (connection === this.connection) {
            this.refreshAgain = false;
            if (this.refreshTimer) clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
          }
          throw error;
        })
        .finally(() => {
          if (this.listing === listing) this.listing = undefined;
        });
      this.listing = listing;
      return listing;
    }
    this.mutations++;
    return this.requestCommand(command).finally(() => {
      this.mutations--;
    });
  }

  private async requestFreshList(): Promise<DocumentDecisionResult> {
    const connection = this.connection;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (connection !== this.connection)
        throw new Error("Document disconnected while refreshing feedback.");
      if (attempt > 0) {
        const epoch = this.epoch;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.retryWait = undefined;
            resolve();
          }, 10);
          this.retryWait = { timer, reject };
        });
        if (connection !== this.connection)
          throw new Error("Document disconnected while refreshing feedback.");
        // A new invalidation during the pause needs its own quiet interval.
        if (epoch !== this.epoch) continue;
      }
      this.refreshAgain = false;
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
      const epoch = this.epoch;
      try {
        const request = this.requestCommand({ operation: "list" });
        const sequence = this.sequence;
        const result = await request;
        if (connection !== this.connection)
          throw new Error("Document disconnected while refreshing feedback.");
        if (!result.loaded) {
          this.refreshAgain = false;
          if (this.refreshTimer) clearTimeout(this.refreshTimer);
          this.refreshTimer = undefined;
          return result;
        }
        // Also cover invalidation after receive but before this continuation.
        if (epoch !== this.epoch || sequence < this.applied)
          throw new StaleDecisionReadError();
        return result;
      } catch (error) {
        if (!(error instanceof StaleDecisionReadError)) throw error;
      }
    }
    throw new StaleDecisionReadError();
  }

  private async requestCommand(
    command: DocumentDecisionCommand
  ): Promise<DocumentDecisionResult> {
    const connection = this.connection;
    try {
      if (!this.ready())
        throw new Error(
          "Wait for this document to connect before sending feedback."
        );
      if (command.operation !== "list" && !(await this.flush()))
        throw new Error(
          "The document has not been saved to the server. Retry after it reconnects."
        );
      if (connection !== this.connection || !this.ready())
        throw new Error("Document disconnected before the request was sent.");
    } catch (error) {
      if (connection === this.connection) this.clear();
      throw error;
    }
    const requestId = crypto.randomUUID();
    const epoch = this.epoch;
    const sequence = ++this.sequence;
    return new Promise((resolve, reject) => {
      const fail = (error: Error) => {
        this.pending.delete(requestId);
        if (epoch === this.epoch && sequence >= this.applied) this.clear();
        reject(error);
      };
      const timer = setTimeout(
        () =>
          fail(
            new Error(
              "Feedback delivery could not be confirmed. Reconnect and retry; the same block will not be sent twice."
            )
          ),
        15000
      );
      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        epoch,
        sequence,
        operation: command.operation,
      });
      try {
        this.send({ type: "docDecisionCommand", requestId, command });
      } catch (error) {
        clearTimeout(timer);
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  receive(message: DocDecisionStateMessage): void {
    const pending = message.requestId
      ? this.pending.get(message.requestId)
      : undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId!);
    if (pending.epoch !== this.epoch || pending.sequence < this.applied) {
      // A successful write may have committed. Acknowledge it without installing
      // its obsolete projection; never replay the mutation to recover a view.
      if (message.error) pending.reject(new Error(message.error));
      else if (pending.operation === "list" && message.privacyVersion === 1)
        pending.reject(new StaleDecisionReadError());
      else pending.resolve({ decisions: [], loaded: false });
      return;
    }
    this.applied = pending.sequence;
    if (message.error) {
      this.clear();
      pending.reject(new Error(message.error));
      return;
    }
    const supported = message.privacyVersion === 1;
    const loaded =
      supported && (pending.operation === "list" || this.authority.loaded);
    this.authority = {
      loaded,
      ...(supported ? { privacyVersion: 1 as const } : {}),
    };
    this.state = loaded ? message.decisions : [];
    this.publish();
    pending.resolve({ decisions: this.state, ...this.authority });
  }

  refreshSubscribers(): void {
    if (this.listeners.size) this.invalidate();
  }

  /** Clear synchronously; fetch only each connection's authorized projection. */
  invalidate(): void {
    this.clear();
    this.refreshAgain = true;
    this.scheduleRefresh();
  }
  private scheduleRefresh(): void {
    if (this.refreshTimer || this.refreshing || !this.ready()) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refreshAgain = false;
      this.refreshing = true;
      const connection = this.connection;
      void this.request({ operation: "list" })
        .catch(() => {
          // Terminal failures (including retry exhaustion) do not start another
          // retry budget. A future invalidation or explicit list can try again.
          if (connection === this.connection) this.refreshAgain = false;
        })
        .finally(() => {
          if (connection !== this.connection) return;
          this.refreshing = false;
          if (this.refreshAgain) this.scheduleRefresh();
        });
    }, 10);
  }

  disconnect(): void {
    this.connection++;
    this.listing = undefined;
    if (this.retryWait) {
      clearTimeout(this.retryWait.timer);
      this.retryWait.reject(
        new Error("Document disconnected while refreshing feedback.")
      );
      this.retryWait = undefined;
    }
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.refreshing = false;
    this.refreshAgain = false;
    this.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error(
          "Document disconnected before feedback delivery was confirmed."
        )
      );
    }
    this.pending.clear();
  }
}
