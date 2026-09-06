// @vitest-environment node

/**
 * What send does that no reader can see: which subjects get published, in what
 * order relative to creating the request, and what happens to the results tab
 * when the server refuses.
 *
 * The draft-side gate (an unshared subject blocks send until the author
 * confirms the exact list) is covered in the runtime's feedbackComposeDraft and
 * compose-widget tests. This file starts from a real draft and drives the real
 * payload through the host, so the two halves meet on the same shape.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ResourceRef } from '@nimbalyst/collab-protocol';

import type { FeedbackComposeSendPayload, FeedbackRequestSendResult } from '@nimbalyst/runtime/ui/AgentTranscript/components/CustomToolWidgets/InteractiveWidgetHost';
import {
  confirmPublish,
  createEmptyFeedbackComposeDraft,
  feedbackComposeSendPayload,
  feedbackComposeSubmitPlan,
  type FeedbackComposeDraft,
} from '@nimbalyst/runtime/ui/AgentTranscript/components/CustomToolWidgets/feedback/feedbackComposeDraft';

import {
  createFeedbackComposeHost,
  type FeedbackPublishOutcome,
  type FeedbackPublishPlan,
} from '../createFeedbackComposeHost';

const ORG_ID = 'org-1';

function draftWithSubjects(
  subjects: FeedbackComposeDraft['subjects'],
): FeedbackComposeDraft {
  return {
    ...createEmptyFeedbackComposeDraft('draft-1', ORG_ID),
    subjects,
    asks: [
      {
        type: 'confirm',
        id: 'ask-ship',
        label: 'Ship it?',
        description: 'Does this direction work?',
      },
    ],
    recipients: [{ userId: 'u-karl', name: 'Karl Reyes' }],
    assignments: [{ askId: 'ask-ship', target: { kind: 'user', userId: 'u-karl' } }],
  };
}

function trackerSubject(sourceId: string, shared: boolean) {
  return {
    ref: { orgId: ORG_ID, kind: 'tracker' as const, sourceId },
    label: sourceId,
    shared,
  };
}

function readyPayload(draft: FeedbackComposeDraft) {
  const plan = feedbackComposeSubmitPlan(draft);
  if (plan.kind !== 'ready') throw new Error(`expected a ready plan, got ${plan.kind}`);
  return feedbackComposeSendPayload(draft, plan.publishSubjectRefs);
}

type SendMock = ReturnType<typeof vi.fn<(payload: FeedbackComposeSendPayload) => Promise<FeedbackRequestSendResult>>>;
type PrepareMock = ReturnType<typeof vi.fn<(ref: ResourceRef) => Promise<FeedbackPublishPlan>>>;

/** A subject the author has already answered for; publishing it succeeds. */
function readyPlan(outcome: FeedbackPublishOutcome = { success: true }): FeedbackPublishPlan {
  return { status: 'ready', run: async () => outcome };
}

function harness(overrides: { sendDocument?: SendMock; prepareSubject?: PrepareMock } = {}) {
  const sendDocument: SendMock = overrides.sendDocument
    ?? vi.fn<(payload: FeedbackComposeSendPayload) => Promise<FeedbackRequestSendResult>>()
      .mockResolvedValue({ success: true, requestId: 'dcn-generated', shareUrl: 'https://console.nimbalyst.com/org/org-1/project/p-1/document/doc-1?blockId=dcn-generated' });
  // Records what actually reached the team, so a test can tell "prepared" from
  // "published" -- the whole point of the two passes.
  const published: string[] = [];
  const prepareSubject: PrepareMock = overrides.prepareSubject
    ?? vi.fn<(ref: ResourceRef) => Promise<FeedbackPublishPlan>>(async (ref) => ({
      status: 'ready',
      run: async () => {
        published.push(ref.sourceId);
        return { success: true };
      },
    }));
  const host = createFeedbackComposeHost({
    workspacePath: '/tmp/workspace',
    sessionId: 'session-7',
    sendDocument,
    prepareSubject,
    resolveDestination: async () => ({ folderId: null, folderPath: '' }),
    persistLastSharedFolder: () => {},
  });
  return { host, sendDocument, prepareSubject, published };
}

describe('createFeedbackComposeHost', () => {
  it('publishes only the confirmed subject, then creates the request and opens its results', async () => {
    const draft = confirmPublish(
      draftWithSubjects([trackerSubject('item-shared', true), trackerSubject('item-unshared', false)]),
    );
    const { host, sendDocument, prepareSubject, published } = harness();

    const result = await host.send(readyPayload(draft));

    // The pasteable link comes back with the send: a recipient without the
    // desktop app is reached by it or by nothing, so the confirmation must not
    // have to go looking for it.
    expect(result).toEqual({
      success: true,
      requestId: 'dcn-generated',
      shareUrl: 'https://console.nimbalyst.com/org/org-1/project/p-1/document/doc-1?blockId=dcn-generated',
    });
    // The already-shared subject is not republished, and nothing outside the
    // author's confirmation is touched.
    expect(prepareSubject).toHaveBeenCalledTimes(1);
    expect(prepareSubject.mock.calls[0][0].sourceId).toBe('item-unshared');
    expect(published).toEqual(['item-unshared']);

    const request = sendDocument.mock.calls[0][0];
    // Both subjects travel with the request; the author is the drafting
    // session, with the org-scoped member id left for main to stamp.
    expect(request.subjects.map((subject) => subject.ref.sourceId)).toEqual([
      'item-shared',
      'item-unshared',
    ]);
  });

  it('sends the published document ref when publishing a file rewrote it', async () => {
    const draft = confirmPublish(draftWithSubjects([
      {
        ref: { orgId: ORG_ID, kind: 'file', sourceId: 'mockups/direction-a.mockup.html' },
        label: 'direction-a.mockup.html',
        shared: false,
      },
    ]));
    const published: ResourceRef = { orgId: ORG_ID, kind: 'document', sourceId: 'doc-42' };
    const prepareSubject = vi.fn<(ref: ResourceRef) => Promise<FeedbackPublishPlan>>()
      .mockResolvedValue(readyPlan({ success: true, ref: published }));
    const { host, sendDocument } = harness({ prepareSubject });

    const result = await host.send(readyPayload(draft));

    expect(result.success).toBe(true);
    // A path on the author's disk means nothing to the recipient, so the
    // request must carry what the publish produced -- and the author's label
    // has to survive that swap, because the published ref is an opaque
    // document id the recipient cannot render.
    const request = sendDocument.mock.calls[0][0];
    expect(request.subjects).toEqual([
      { ref: published, label: 'direction-a.mockup.html' },
    ]);
  });

  it('refuses a publish ref that is not one of the request subjects, before publishing anything', async () => {
    const draft = confirmPublish(draftWithSubjects([trackerSubject('item-unshared', false)]));
    const payload = readyPayload(draft);
    const tampered = {
      ...payload,
      publishSubjectRefs: [
        ...payload.publishSubjectRefs,
        { orgId: ORG_ID, kind: 'tracker' as const, sourceId: 'never-shown' },
      ],
    };
    const { host, sendDocument, prepareSubject } = harness();

    const result = await host.send(tampered);

    expect(result.success).toBe(false);
    expect(result.error).toContain('never-shown');
    expect(prepareSubject).not.toHaveBeenCalled();
    expect(sendDocument).not.toHaveBeenCalled();
  });

  it('does not open the results tab when the request could not be created', async () => {
    const draft = draftWithSubjects([trackerSubject('item-shared', true)]);
    const sendDocument = vi.fn().mockRejectedValue(new Error('room refused the request'));
    const { host } = harness({ sendDocument });

    const result = await host.send(readyPayload(draft));

    expect(result).toEqual({ success: false, error: 'room refused the request' });
  });

  it('publishes nothing when the author cancels the share of a later subject, and sends on the retry', async () => {
    const fileSubject = (name: string) => ({
      ref: { orgId: ORG_ID, kind: 'file' as const, sourceId: `mockups/${name}.mockup.html` },
      label: `${name}.mockup.html`,
      shared: false,
    });
    const draft = confirmPublish(draftWithSubjects([fileSubject('a'), fileSubject('b')]));
    const payload = readyPayload(draft);

    // The author names the first mockup, then closes the dialog on the second.
    const cancelled = vi.fn<(ref: ResourceRef) => Promise<FeedbackPublishPlan>>(async (ref) =>
      ref.sourceId.endsWith('b.mockup.html')
        ? { status: 'blocked', error: 'Sharing b.mockup.html was cancelled, so nothing was published.' }
        : readyPlan({ success: true, ref: { orgId: ORG_ID, kind: 'document', sourceId: 'doc-a' } }));
    const { host, sendDocument, published } = harness({ prepareSubject: cancelled });

    const abandoned = await host.send(payload);

    expect(abandoned.success).toBe(false);
    expect(abandoned.error).toContain('cancelled');
    // The first mockup was answered for but never shared: an abandoned send
    // leaves no half-published subjects for the author to clean up.
    expect(published).toEqual([]);
    expect(sendDocument).not.toHaveBeenCalled();

    // Nothing about the draft was consumed by the failed attempt: the same
    // payload -- asks, recipients, and the confirmed publish set -- still sends.
    const retry = harness();
    const result = await retry.host.send(payload);

    expect(result).toMatchObject({ success: true, requestId: 'dcn-generated' });
    const request = retry.sendDocument.mock.calls[0][0];
    expect(request.asks.map((ask) => ask.id)).toEqual(['ask-ship']);
    expect(request.recipients.map((person) => person.userId)).toEqual(['u-karl']);
    expect(retry.published).toEqual([
      'mockups/a.mockup.html',
      'mockups/b.mockup.html',
    ]);
  });

  it('reports the failed publish and creates nothing when a subject cannot be published', async () => {
    const draft = confirmPublish(draftWithSubjects([trackerSubject('item-unshared', false)]));
    const prepareSubject = vi.fn()
      .mockResolvedValue(readyPlan({ success: false, error: 'tracker is local-only' }));
    const { host, sendDocument } = harness({ prepareSubject });

    const result = await host.send(readyPayload(draft));

    expect(result).toEqual({ success: false, error: 'tracker is local-only' });
    expect(sendDocument).not.toHaveBeenCalled();
  });
});

describe('createFeedbackComposeHost — publish destination', () => {
  function fileSubject(sourceId: string, shared: boolean) {
    return {
      ref: { orgId: ORG_ID, kind: 'file' as const, sourceId },
      label: sourceId,
      shared,
    };
  }

  function destinationHarness(overrides: {
    prepareSubject?: PrepareMock;
    resolved?: { folderId: string | null; folderPath: string; pendingFolder?: { name: string; parentFolderId: string | null } };
  } = {}) {
    const resolveDestination = vi.fn().mockResolvedValue(
      overrides.resolved ?? {
        folderId: null,
        folderPath: '',
        pendingFolder: { name: 'Feedback requests', parentFolderId: null },
      },
    );
    const createPendingFolder = vi.fn().mockResolvedValue({
      folderId: 'f-created',
      folderPath: 'Feedback requests',
    });
    const persistLastSharedFolder = vi.fn();
    const runsWith: Array<unknown> = [];
    const prepareSubject: PrepareMock = overrides.prepareSubject
      ?? vi.fn(async () => ({
        status: 'ready' as const,
        run: async (destination?: unknown) => {
          runsWith.push(destination);
          return { success: true as const };
        },
      }));
    const host = createFeedbackComposeHost({
      workspacePath: '/tmp/workspace',
      sessionId: 'session-7',
      sendDocument: vi.fn().mockResolvedValue({ success: true }),
      prepareSubject,
          resolveDestination,
      createPendingFolder,
      persistLastSharedFolder,
    });
    return { host, resolveDestination, createPendingFolder, persistLastSharedFolder, runsWith, prepareSubject };
  }

  it('creates the named folder between the passes and publishes into it', async () => {
    const h = destinationHarness();
    const draft = confirmPublish(draftWithSubjects([fileSubject('a.mockup.html', false)]));

    const result = await h.host.send(readyPayload(draft));

    expect(result.success).toBe(true);
    expect(h.createPendingFolder).toHaveBeenCalledTimes(1);
    expect(h.runsWith).toEqual([{ folderId: 'f-created', folderPath: 'Feedback requests' }]);
    // Recorded once for the request, not once per file.
    expect(h.persistLastSharedFolder).toHaveBeenCalledTimes(1);
    expect(h.persistLastSharedFolder).toHaveBeenCalledWith({
      folderId: 'f-created',
      folderPath: 'Feedback requests',
    });
  });

  it('creates nothing when a later subject blocks the send', async () => {
    // The author walks away from the second file's dialog. The first file's
    // folder must not survive that as an empty folder on the team.
    const prepareSubject = vi.fn()
      .mockResolvedValueOnce({ status: 'ready', run: async () => ({ success: true }) })
      .mockResolvedValueOnce({ status: 'blocked', error: 'Sharing b was cancelled.' }) as PrepareMock;
    const h = destinationHarness({ prepareSubject });
    const draft = confirmPublish(draftWithSubjects([
      fileSubject('a.mockup.html', false),
      fileSubject('b.mockup.html', false),
    ]));

    const result = await h.host.send(readyPayload(draft));

    expect(result).toEqual({ success: false, error: 'Sharing b was cancelled.' });
    expect(h.createPendingFolder).not.toHaveBeenCalled();
    expect(h.persistLastSharedFolder).not.toHaveBeenCalled();
  });

  it('does not resolve a folder for a request that only publishes trackers', async () => {
    const h = destinationHarness();
    const draft = confirmPublish(draftWithSubjects([trackerSubject('item-9', false)]));

    await h.host.send(readyPayload(draft));

    // A tracker has no folder; resolving one could create a folder for nothing.
    expect(h.resolveDestination).not.toHaveBeenCalled();
    expect(h.createPendingFolder).not.toHaveBeenCalled();
  });

  it('skips folder creation when the destination already exists', async () => {
    const h = destinationHarness({
      resolved: { folderId: 'f-existing', folderPath: 'Feedback requests' },
    });
    const draft = confirmPublish(draftWithSubjects([fileSubject('a.mockup.html', false)]));

    await h.host.send(readyPayload(draft));

    expect(h.createPendingFolder).not.toHaveBeenCalled();
    expect(h.runsWith).toEqual([{ folderId: 'f-existing', folderPath: 'Feedback requests' }]);
  });
});

it('sends approved drafts through document decisions without creating a legacy feedback room', async () => {
  const sendDocument = vi.fn().mockResolvedValue({ success: true, requestId: 'dcn-draft-1', shareUrl: 'https://console.nimbalyst.com/org/org-1/project/p-1/document/doc-1?blockId=dcn-draft-1' });
  const host = createFeedbackComposeHost({ workspacePath: '/tmp/workspace', sessionId: 'session-7', sendDocument });
  const payload = readyPayload(draftWithSubjects([]));
  const result = await host.send(payload);
  expect(sendDocument).toHaveBeenCalledWith(payload, undefined);
  expect(result.shareUrl).toContain('/document/doc-1?blockId=');
});
