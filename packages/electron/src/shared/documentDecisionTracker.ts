export interface DocumentDecisionTrackerInput {
  workspacePath: string;
  orgId: string;
  teamProjectId: string;
  documentId: string;
  blockIds: string[];
  title: string;
}

export type DocumentDecisionTrackerResult =
  | { status: 'linked'; itemId: string; issueKey: string }
  | { status: 'skipped'; reason: string };
