import type { DecisionVote } from "./decisionBlock.js";
import type { FeedbackAnswer } from "./feedbackRequest.js";

/** Delivery metadata is server-authored; the document remains the decision record. */
export interface DocumentDecisionDeliveryState {
  blockId: string;
  recipientIds: string[];
  sentAt: number;
  sentBy: string;
  quorum: number;
  answeredIds: string[];
  /** Private projections expose progress without respondent identities. */
  answeredCount?: number;
  sealed: boolean;
  sessionId?: string;
  lastNudgedAt?: number;
  /** Immutable private group membership, including siblings not yet sent. */
  privateGroupBlockIds?: string[];
  /** Viewer-specific projection; private answers never enter shared Yjs state. */
  privateResponses?: {
    votes: DecisionVote[];
    myVote?: DecisionVote;
    canSeeAll: boolean;
    responseVersion: number;
  };
}

export type DocumentDecisionCommand =
  | { operation: "list" }
  | {
      operation: "send";
      blockId: string;
      recipientIds: string[];
      quorum?: number;
      sessionId?: string;
    }
  | { operation: "nudge"; blockId: string }
  | {
      operation: "answer";
      blockId: string;
      answer: FeedbackAnswer;
      note?: string;
      expectedVersion: number;
    }
  | { operation: "retract"; blockId: string; expectedVersion: number };

export interface DocDecisionCommandMessage {
  type: "docDecisionCommand";
  requestId: string;
  command: DocumentDecisionCommand;
}

/** Client cache authority; an empty authorized list differs from unknown state. */
export interface DocumentDecisionAuthority {
  privacyVersion?: 1;
  loaded: boolean;
}

export interface DocumentDecisionResult extends DocumentDecisionAuthority {
  decisions: DocumentDecisionDeliveryState[];
}

export interface DocDecisionStateMessage {
  type: "docDecisionState";
  /** Present only on successful, authorized privacy-aware server responses. */
  privacyVersion?: 1;
  requestId?: string;
  decisions: DocumentDecisionDeliveryState[];
  error?: string;
}

/** Contains no response data. Each connection must fetch its authorized view. */
export interface DocDecisionChangedMessage {
  type: "docDecisionChanged";
}
