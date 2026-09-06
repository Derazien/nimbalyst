/** Human approval publishes the named subjects, then addresses decision blocks in a shared document. Legacy requests retain their read/respond path. */

import type { ResourceRef } from '@nimbalyst/collab-protocol';
import type {
  FeedbackComposeDestination,
  FeedbackComposeSendPayload,
  FeedbackRequestSendResult,
} from '@nimbalyst/runtime/ui/AgentTranscript/components/CustomToolWidgets/InteractiveWidgetHost';

import {
  isPublishableSubjectKind,
  prepareFeedbackSubjectPublish,
  unpublishableSubjectMessage,
  type FeedbackPublishOutcome,
  type FeedbackPublishPlan,
} from './publishFeedbackSubject';
import {
  createPendingFeedbackFolder,
  resolveFeedbackDestination,
  type ResolvedFeedbackDestination,
} from './feedbackDestinationFolder';
import { resolveDesktopCollabScope } from '../../store/atoms/collabDocuments';

export type { FeedbackPublishOutcome, FeedbackPublishPlan };

export interface FeedbackComposeHostConfig {
  workspacePath: string;
  /** The drafting session; it becomes the request's author and its wake target. */
  sessionId: string;
  sessionName?: string;
  prepareSubject?: (
    ref: ResourceRef,
    destination?: ResolvedFeedbackDestination,
  ) => Promise<FeedbackPublishPlan>;
  /** Canonical document send; injectable for the approval/publish ordering tests. */
  sendDocument?: (payload: FeedbackComposeSendPayload, destination?: ResolvedFeedbackDestination) => Promise<FeedbackRequestSendResult>;
  /** Turns the draft's destination into a folder id. Creates nothing. */
  resolveDestination?: (
    destination: FeedbackComposeDestination | undefined,
  ) => Promise<ResolvedFeedbackDestination>;
  /** Creates the folder the author named, once, right before publishing. */
  createPendingFolder?: (
    destination: ResolvedFeedbackDestination,
  ) => Promise<ResolvedFeedbackDestination>;
  /** Records the request's destination as the workspace default, once. */
  persistLastSharedFolder?: (destination: ResolvedFeedbackDestination) => void;
}

export interface FeedbackComposeHost {
  send(payload: FeedbackComposeSendPayload): Promise<FeedbackRequestSendResult>;
  cancel(draftId: string): Promise<void>;
}

function refKey(ref: ResourceRef): string {
  return `${ref.kind}:${ref.sourceId}`;
}

export function createFeedbackComposeHost(
  config: FeedbackComposeHostConfig,
): FeedbackComposeHost {
  const prepareSubject = config.prepareSubject
    ?? ((ref: ResourceRef, destination?: ResolvedFeedbackDestination) =>
      prepareFeedbackSubjectPublish(ref, {
        workspacePath: config.workspacePath,
        ...(destination
          ? { destination: { folderId: destination.folderId, folderPath: destination.folderPath } }
          : {}),
      }));
  const sendDocument = config.sendDocument ?? (async (payload: FeedbackComposeSendPayload, destination?: ResolvedFeedbackDestination) => {
    const { sendDocumentFeedback } = await import('./DocumentFeedbackComposeHost');
    return sendDocumentFeedback(config, payload, destination);
  });

  const withScope = async <T,>(
    run: (scope: Awaited<ReturnType<typeof resolveDesktopCollabScope>>['scope'] & {}) => Promise<T>,
    fallback: T,
  ): Promise<T> => {
    const { scope } = await resolveDesktopCollabScope(config.workspacePath);
    return scope ? run(scope) : fallback;
  };

  const resolveDestination = config.resolveDestination
    ?? ((destination: FeedbackComposeDestination | undefined) =>
      withScope(
        (scope) => resolveFeedbackDestination(scope, destination),
        // No scope means no team folders to place anything in; the per-subject
        // dialog still runs and the author places it themselves.
        { folderId: null, folderPath: '' } as ResolvedFeedbackDestination,
      ));

  const createPendingFolder = config.createPendingFolder
    ?? ((destination: ResolvedFeedbackDestination) =>
      withScope(
        (scope) => createPendingFeedbackFolder(scope, destination),
        { folderId: destination.folderId, folderPath: destination.folderPath },
      ));

  const persistLastSharedFolder = config.persistLastSharedFolder
    ?? ((destination: ResolvedFeedbackDestination) => {
      if (!config.workspacePath || !window.electronAPI?.invoke) return;
      // Direct rather than through `invoke`: this channel is workspace-scoped
      // and takes the path as its own argument, which that alias cannot express.
      window.electronAPI
        .invoke('workspace:update-state', config.workspacePath, {
          collabTree: {
            lastSharedFolderId: destination.folderId,
            lastSharedFolder: destination.folderPath,
          },
        })
        .catch((error: unknown) => {
          console.warn('[createFeedbackComposeHost] Could not persist the destination:', error);
        });
    });

  return {
    async send(payload: FeedbackComposeSendPayload): Promise<FeedbackRequestSendResult> {
      if (!payload.orgId) {
        return { success: false, error: 'This workspace has no team to send the request to.' };
      }
      if (!config.workspacePath) {
        return { success: false, error: 'This session has no workspace to send from.' };
      }

      const subjectKeys = new Set(payload.subjects.map((subject) => refKey(subject.ref)));
      const stray = payload.publishSubjectRefs.find((ref) => !subjectKeys.has(refKey(ref)));
      if (stray) {
        return {
          success: false,
          error: `${stray.sourceId} is not one of this request's subjects, so it was not published.`,
        };
      }

      const unpublishable = payload.publishSubjectRefs.filter(
        (ref) => !isPublishableSubjectKind(ref.kind),
      );
      if (unpublishable.length > 0) {
        return {
          success: false,
          error: [...new Set(unpublishable.map(unpublishableSubjectMessage))].join(' '),
        };
      }

      // Look the destination up before asking anything, so a file with nothing
      // else to ask can publish without a dialog. Lookup only -- a folder the
      // author named is not created until the send is definitely going ahead.
      // Only files land in a folder. A tracker is published by flipping its own
      // visibility bit, so a tracker-only request must not resolve a
      // destination -- and must certainly not create one for nothing.
      let destination: ResolvedFeedbackDestination | undefined;
      if (payload.publishSubjectRefs.some((ref) => ref.kind === 'file')) {
        try {
          destination = await resolveDestination(payload.destination);
        } catch (error) {
          console.warn('[createFeedbackComposeHost] Could not resolve the destination:', error);
        }
      }

      // Pass one: everything the author has to answer, before anything is
      // created. Preparing a file may still open the share dialog when it
      // embeds other documents, so a cancel here costs the author nothing but
      // the dialog they just closed.
      const plans: Array<{ ref: ResourceRef; plan: FeedbackPublishPlan }> = [];
      for (const ref of payload.publishSubjectRefs) {
        let plan: FeedbackPublishPlan;
        try {
          plan = await prepareSubject(ref, destination);
        } catch (error) {
          plan = {
            status: 'blocked',
            error: error instanceof Error ? error.message : `${ref.sourceId} could not be published.`,
          };
        }
        if (plan.status !== 'ready') return { success: false, error: plan.error };
        plans.push({ ref, plan });
      }

      // Every question is answered and the send is going ahead, so the folder
      // the author named can exist now. Before this line an abandoned send
      // leaves the team with nothing, which is the point of deferring it.
      if (destination?.pendingFolder && plans.length > 0) {
        const folderName = destination.pendingFolder.name;
        try {
          destination = await createPendingFolder(destination);
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error
              ? error.message
              : `The ${folderName} folder could not be created.`,
          };
        }
      }

      // Pass two: publish. A file turns into a shared document, so the ref the
      // request carries is the published one -- a recipient cannot resolve a
      // path on the author's disk.
      const publishedRefs = new Map<string, ResourceRef>();
      for (const { ref, plan } of plans) {
        if (plan.status !== 'ready') continue;
        let outcome: FeedbackPublishOutcome;
        try {
          outcome = await plan.run(destination);
        } catch (error) {
          outcome = {
            success: false,
            error: error instanceof Error ? error.message : `${ref.sourceId} could not be published.`,
          };
        }
        // A later failure leaves the earlier publishes standing. That is on
        // purpose: they are what the author asked for, publishing is
        // idempotent, and re-sending reuses them instead of duplicating them.
        if (!outcome.success) return { success: false, error: outcome.error };
        if (outcome.ref) publishedRefs.set(refKey(ref), outcome.ref);
      }
      // Once for the request, not once per file. Reaching here means every plan
      // ran without failing, since any failure returns above.
      if (destination && plans.length > 0) persistLastSharedFolder(destination);
      // The published ref replaces the local one; the author's label rides
      // through untouched, because it is the only thing a recipient who never
      // synced the project can read.
      const republish = <T extends { ref: ResourceRef }>(artifact: T): T => {
        const published = publishedRefs.get(refKey(artifact.ref));
        return published ? { ...artifact, ref: published } : artifact;
      };
      const subjects = payload.subjects.map(republish);
      // Option-bound artifacts carry their own copy of the ref, so a rewrite
      // that stopped at `subjects` would leave every option card pointing at a
      // path on the author's disk.
      const asks = payload.asks.map((ask) =>
        'artifacts' in ask && ask.artifacts?.length
          ? { ...ask, artifacts: ask.artifacts.map(republish) }
          : ask);

      try {
        return await sendDocument({ ...payload, subjects, asks }, destination);
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'The question could not be sent.' };
      }
    },

    /**
     * Nothing to undo: `RequestFeedback` is non-blocking and already returned
     * its draft, and no server object exists until send. The widget discards
     * its own draft; this exists so the widget's cancel path is a decision
     * rather than a missing method.
     */
    async cancel(_draftId: string): Promise<void> {},
  };
}
