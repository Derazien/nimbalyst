/**
 * Makes the vote repository reachable from inside a `DecisionNode`'s decorator.
 *
 * A Lexical decorator cannot take props from the host -- it is constructed by
 * the node -- so the config has to arrive through context. This is the one
 * place that owns the repository's lifetime: created when a Y.Doc appears,
 * destroyed when it goes away or the editor unmounts.
 *
 * The provider is always mounted, including with no config at all. A block in a
 * plain local file still renders and is still answerable; it simply has nowhere
 * to put a vote, and `useDecisionVotes` reports that rather than pretending.
 */

import React, {
  createContext,
  useContext,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  isValidDecisionAnswer,
  isValidStoredDecisionAnswer,
  type DecisionBlockSource,
  type DecisionRecommendation,
  type DecisionVote,
  type DocumentDecisionDeliveryState,
  type DocumentDecisionAuthority,
} from "@nimbalyst/collab-protocol";

import {
  YDocDecisionRepository,
  emptyDecisionSnapshot,
  type DecisionRepositorySnapshot,
  type DecisionSealClaim,
} from "./YDocDecisionRepository";
import type { DecisionMember, DecisionsConfig } from "./types";

interface DecisionsContextValue {
  repository: YDocDecisionRepository | null;
  config: DecisionsConfig | null;
  deliveryStates: DocumentDecisionDeliveryState[];
  deliveryError: string;
  deliveryReady: boolean;
  setDeliveryStates: (
    states: DocumentDecisionDeliveryState[],
    authority?: DocumentDecisionAuthority
  ) => void;
}

const DecisionsContext = createContext<DecisionsContextValue>({
  repository: null,
  config: null,
  deliveryStates: [],
  deliveryError: "",
  deliveryReady: false,
  setDeliveryStates: () => {},
});

export const DecisionsProvider: React.FC<{
  config?: DecisionsConfig;
  children: React.ReactNode;
}> = ({ config, children }) => {
  const [repository, setRepository] = useState<YDocDecisionRepository | null>(
    null
  );

  useEffect(() => {
    const doc = config?.getYDoc() ?? null;
    if (!doc) {
      setRepository(null);
      return;
    }
    const created = new YDocDecisionRepository(doc);
    setRepository(created);
    return () => {
      created.destroy();
      setRepository(null);
    };
  }, [config]);

  const currentConfig = useRef(config);
  currentConfig.current = config;
  const [delivery, setDelivery] = useState<{
    owner: DecisionsConfig | undefined;
    states: DocumentDecisionDeliveryState[];
    ready: boolean;
    error: string;
  }>({ owner: config, states: [], ready: false, error: "" });
  const setDeliveryStates = useCallback(
    (
      states: DocumentDecisionDeliveryState[],
      authority?: DocumentDecisionAuthority
    ) => {
      const ready =
        authority?.loaded === true && authority.privacyVersion === 1;
      if (currentConfig.current === config)
        setDelivery({
          owner: config,
          states: ready ? states : [],
          ready,
          error: ready
            ? ""
            : "Private answer status is unavailable. Reconnect to refresh it.",
        });
    },
    [config]
  );
  useEffect(() => {
    setDelivery({ owner: config, states: [], ready: false, error: "" });
    let active = true;
    let received = false;
    const unsubscribe = config?.onDecisionState?.((states, authority) => {
      received = true;
      if (active) setDeliveryStates(states, authority);
    });
    if (config?.requestDecision && (config.isHydrated?.() ?? true)) {
      config
        .requestDecision({ operation: "list" })
        .then((result) => {
          if (active && !received) setDeliveryStates(result.decisions, result);
        })
        .catch((cause: unknown) => {
          if (active && !received)
            setDelivery({
              owner: config,
              states: [],
              ready: false,
              error:
                cause instanceof Error
                  ? cause.message
                  : "Delivery status is unavailable.",
            });
        });
    }
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [config, setDeliveryStates]);
  const deliveryStates = delivery.owner === config ? delivery.states : [];
  const deliveryError = delivery.owner === config ? delivery.error : "";
  const deliveryReady = delivery.owner === config && delivery.ready;
  const value = useMemo<DecisionsContextValue>(
    () => ({
      repository,
      config: config ?? null,
      deliveryStates,
      deliveryError,
      deliveryReady,
      setDeliveryStates,
    }),
    [
      repository,
      config,
      deliveryStates,
      deliveryError,
      deliveryReady,
      setDeliveryStates,
    ]
  );

  return (
    <DecisionsContext.Provider value={value}>
      {children}
    </DecisionsContext.Provider>
  );
};

export interface DecisionVotingState {
  votes: readonly DecisionVote[];
  recommendations: readonly DecisionRecommendation[];
  sealClaim: DecisionSealClaim | undefined;
  /** The current viewer's own vote, when they have cast one. */
  myVote: DecisionVote | undefined;
  viewer: { id: string; name: string } | null;
  members: readonly DecisionMember[];
  /**
   * False when there is no room to vote in. The block stays usable -- a solo
   * reader can still pick and seal -- but nothing is recorded for anyone else.
   */
  canRecordVotes: boolean;
  canVote: boolean;
  canEdit: boolean;
  canSeal: boolean;
  privateMode: boolean;
  canSeeAll: boolean;
  pending: boolean;
  refreshing: boolean;
  error: string;
  unavailableReason: string;
  /** No-ops on an answer that is malformed for this ask, or on a sealed block. */
  castVote: (answer: DecisionVote["answer"], note?: string) => Promise<boolean>;
  retractVote: () => Promise<boolean>;
  claimSeal: (claim: DecisionSealClaim) => void;
  /** Absent when the host cannot render embeds (web console, mobile editor). */
  renderArtifact: DecisionsConfig["renderArtifact"];
}

const NO_VOTES: readonly DecisionVote[] = Object.freeze([]);
const NO_RECOMMENDATIONS: readonly DecisionRecommendation[] = Object.freeze([]);
const NO_MEMBERS: readonly DecisionMember[] = Object.freeze([]);

export function useDecisionVotes(
  source: DecisionBlockSource
): DecisionVotingState {
  const {
    repository,
    config,
    deliveryStates,
    deliveryReady,
    deliveryError,
    setDeliveryStates,
  } = useContext(DecisionsContext);
  const blockId = source.id;
  const snapshot = useSyncExternalStore<DecisionRepositorySnapshot>(
    (listener) => repository?.subscribe(listener) ?? (() => undefined),
    () => repository?.getSnapshot() ?? emptyDecisionSnapshot(),
    () => repository?.getSnapshot() ?? emptyDecisionSnapshot()
  );
  const state = deliveryStates.find((entry) => entry.blockId === blockId);
  const privateResponses = state?.privateResponses;
  // Once observed, server privacy cannot be undone by a mutable fence or a
  // temporarily empty transport cache. Reset only when the host/block changes.
  const privacy = useRef({ config, blockId, pinned: false });
  if (privacy.current.config !== config || privacy.current.blockId !== blockId)
    privacy.current = { config, blockId, pinned: false };
  if (
    privateResponses ||
    deliveryStates.some((entry) =>
      entry.privateGroupBlockIds?.includes(blockId)
    )
  )
    privacy.current.pinned = true;
  const isSolo =
    config === null ||
    (!config.getYDoc() && !config.isHydrated && !config.requestDecision);
  const privateMode =
    !isSolo &&
    (source.visibility === "hiddenUntilAnswered" || privacy.current.pinned);
  const ready = isSolo || deliveryReady;
  const viewer =
    config?.currentUser ??
    (config === null ? { id: "local", name: "You" } : null);
  const rawVotes = snapshot.votesByBlock[blockId] ?? NO_VOTES;
  const storedVotes = !ready
    ? NO_VOTES
    : privateMode
    ? privateResponses?.votes ?? NO_VOTES
    : rawVotes;
  const votes = useMemo(
    () =>
      storedVotes.filter((vote) =>
        isValidStoredDecisionAnswer(source, vote.answer)
      ),
    [source, storedVotes]
  );
  const myVote = privateMode
    ? ready
      ? privateResponses?.myVote
      : undefined
    : votes.find((vote) => vote.voterId === viewer?.id);
  const canSeeAll = privateMode
    ? ready && (privateResponses?.canSeeAll ?? false)
    : ready;
  const canEdit =
    (isSolo || repository !== null) &&
    (config?.canVote?.() ?? true) &&
    (config?.isHydrated?.() ?? true);
  const [mutation, setMutation] = useState({
    owner: config,
    blockId,
    pending: false,
    refreshing: false,
    error: "",
  });
  const inFlight = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    setMutation({
      owner: config,
      blockId,
      pending: false,
      refreshing: false,
      error: "",
    });
    return () => {
      generation.current++;
    };
  }, [config, blockId]);
  const currentMutation =
    mutation.owner === config && mutation.blockId === blockId;
  const pending = currentMutation && mutation.pending;
  const privateAvailable =
    !!privateResponses && !!config?.requestDecision && deliveryReady;
  const canVote =
    canEdit &&
    ready &&
    !pending &&
    !source.sealed &&
    !state?.sealed &&
    (!privateMode ||
      (privateAvailable &&
        !!viewer &&
        state?.recipientIds.includes(viewer.id) === true));
  const canSeal =
    canEdit &&
    ready &&
    !pending &&
    (!privateMode || (privateAvailable && canSeeAll));
  const unavailableReason = !privateMode
    ? ready
      ? ""
      : deliveryError || "Loading answer status…"
    : !(config?.isHydrated?.() ?? true)
    ? "Loading private answer status…"
    : !config?.requestDecision
    ? "Send this question before collecting private answers. Private answer delivery is unavailable in this connection."
    : !deliveryReady
    ? deliveryError || "Loading private answer status…"
    : !privateResponses
    ? privacy.current.pinned
      ? "Private answer status is unavailable. Reconnect to refresh it."
      : "Send this question before collecting private answers."
    : "";

  const mutatePrivate = async (
    command: "answer" | "retract",
    answer?: DecisionVote["answer"],
    note?: string
  ): Promise<boolean> => {
    if (
      !canVote ||
      !privateResponses ||
      !config?.requestDecision ||
      inFlight.current
    )
      return false;
    inFlight.current = true;
    const current = generation.current;
    setMutation({
      owner: config,
      blockId,
      pending: true,
      refreshing: false,
      error: "",
    });
    try {
      const result = await config.requestDecision(
        command === "answer"
          ? {
              operation: "answer",
              blockId,
              answer: answer!,
              ...(note !== undefined ? { note } : {}),
              expectedVersion: privateResponses.responseVersion,
            }
          : {
              operation: "retract",
              blockId,
              expectedVersion: privateResponses.responseVersion,
            }
      );
      if (current !== generation.current) return false;
      // Subscriptions already applied the response synchronously. Its promise
      // may resume after a newer invalidation; never reinstall that snapshot.
      if (!config.onDecisionState) setDeliveryStates(result.decisions, result);
      setMutation({
        owner: config,
        blockId,
        pending: false,
        refreshing: false,
        error: "",
      });
      return true;
    } catch (cause) {
      if (current !== generation.current) return false;
      if (!config.onDecisionState) setDeliveryStates([]);
      let error =
        cause instanceof Error
          ? cause.message
          : "Your answer could not be saved. Try again.";
      // A timeout may have committed, and a conflict means our version is old.
      // Refresh once, never replay the user's mutation automatically.
      setMutation({
        owner: config,
        blockId,
        pending: true,
        refreshing: true,
        error,
      });
      try {
        const refreshed = await config.requestDecision({ operation: "list" });
        if (current !== generation.current) return false;
        if (!config.onDecisionState)
          setDeliveryStates(refreshed.decisions, refreshed);
      } catch {
        if (current !== generation.current) return false;
        if (!config.onDecisionState) setDeliveryStates([]);
        error +=
          " Answer status could not be refreshed. Reconnect before retrying.";
      }
      setMutation({
        owner: config,
        blockId,
        pending: false,
        refreshing: false,
        error,
      });
      return false;
    } finally {
      if (current === generation.current) inFlight.current = false;
    }
  };
  return {
    votes,
    myVote,
    viewer,
    privateMode,
    canSeeAll,
    canVote,
    canEdit,
    canSeal,
    pending,
    refreshing: currentMutation && mutation.refreshing,
    unavailableReason,
    error: currentMutation ? mutation.error : "",
    recommendations: !ready
      ? NO_RECOMMENDATIONS
      : snapshot.recommendationsByBlock[blockId] ?? NO_RECOMMENDATIONS,
    sealClaim:
      ready && (!privateMode || privateAvailable)
        ? snapshot.sealClaimsByBlock[blockId]
        : undefined,
    members: privateMode
      ? votes.map((vote) => ({ id: vote.voterId, name: "Anonymous" }))
      : config?.getMembers?.() ?? NO_MEMBERS,
    // A connected document awaiting hydration must never take the solo seal path.
    canRecordVotes: !isSolo,
    castVote: async (answer, note) => {
      if (!canVote || !isValidDecisionAnswer(source, answer)) return false;
      if (privateMode) return mutatePrivate("answer", answer, note);
      if (!repository || !viewer) return false;
      repository.castVote(blockId, {
        voterId: viewer.id,
        voterName: viewer.name,
        answer,
        at: Date.now(),
        ...(note !== undefined ? { note } : {}),
      });
      return true;
    },
    retractVote: async () => {
      if (!canVote) return false;
      if (privateMode) return mutatePrivate("retract");
      if (!repository || !viewer) return false;
      repository.retractVote(blockId, viewer.id);
      return true;
    },
    claimSeal: (claim) => {
      if (!canSeal) return;
      if (privateMode) {
        const { resolvedFrom: _privateAuthor, ...publicClaim } = claim;
        repository?.claimSeal(blockId, publicClaim);
      } else repository?.claimSeal(blockId, claim);
    },
    renderArtifact: config?.renderArtifact,
  };
}

/** Shared host operations used by authoring and delivery controls. */
export function useDecisionConfiguration(): DecisionsConfig | null {
  return useContext(DecisionsContext).config;
}

export function useDecisionDeliveries(): Pick<
  DecisionsContextValue,
  "deliveryStates" | "deliveryError" | "setDeliveryStates"
> {
  return useContext(DecisionsContext);
}
