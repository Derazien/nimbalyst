import React from 'react';
import { act, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { asTeamJwt, asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import { collabCommentControllerRegistry } from '@nimbalyst/runtime/editor/commenting/CollabCommentControllerRegistry';
import { withHeadlessLexicalBridge } from '@nimbalyst/runtime/sync/withHeadlessLexicalBridge';
import { HeadlessBodyNodes } from '@nimbalyst/runtime/editor/nodes/headlessBodyNodes';
import { $getRoot } from 'lexical';
import { uint8ArrayToBase64, base64ToUint8Array } from '@nimbalyst/runtime/sync/documentSyncBase64';
import { $createEmbeddedFileNode } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/EmbeddedFileNode';
import { MarkdownCollabContentAdapter } from '@nimbalyst/runtime/sync/MarkdownCollabContentAdapter';
import { decisionMembersFromComments, mountCollabEditor } from '../mount';
import { CollabPresenceSurface } from '../presence';
import {
  asTeamDocumentId,
  asTeamOrgId,
  asTeamProjectId,
  type CollabEditorCommentsOptions,
  type CollabEditorHandle,
} from '../types';

const mountedHandles: CollabEditorHandle[] = [];

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 20; index++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let index = 0; index < 20; index++) await Promise.resolve();
  });
}

afterEach(() => {
  for (const handle of mountedHandles.splice(0)) handle.destroy();
  document.body.replaceChildren();
});

describe('in-memory collaborative editor harness', () => {
  it('renders persisted subject embeds through each mount’s authorized preview without crossing scopes', async () => {
    const mounts = ['one', 'two'].map((scope) => {
      const yDocument = new Y.Doc();
      withHeadlessLexicalBridge(yDocument, { nodes: HeadlessBodyNodes }, ({ editor }) => {
        editor.update(() => $getRoot().append($createEmbeddedFileNode({
          src: `nimbalyst://doc/preview-${scope}?orgId=org-${scope}`,
          label: `Preview ${scope}`, attrs: { embedType: '.mockup.html' },
        })), { discrete: true });
      });
      const element = document.createElement('div'); document.body.append(element);
      const render = vi.fn((_key: string, artifact: string) => <div data-testid="live-subject-preview">{scope}: {artifact}</div>);
      const handle = mountCollabEditor({ element, source: { kind: 'in-memory', document: yDocument }, user: { memberId: asTeamMemberId(scope), name: scope }, renderDecisionArtifact: render });
      mountedHandles.push(handle);
      return { element, handle, render, scope };
    });
    await settle();
    for (const { element, scope } of mounts) {
      await waitFor(() => expect(element.querySelector('[data-testid="live-subject-preview"]')?.textContent).toBe(`${scope}: collab://org:org-${scope}:doc:preview-${scope}`));
      expect(element.querySelector('[data-testid="embed-frame-placeholder"]')).toBeNull();
    }
    await act(async () => mounts[0]!.handle.destroy());
    await act(async () => mounts[1]!.handle.setReadOnly(true));
    await settle();
    expect(mounts[1]!.element.querySelector('[data-testid="live-subject-preview"]')?.textContent).toContain('two: collab://org:org-two:doc:preview-two');
    expect(mounts[0]!.render.mock.calls.every(([, artifact]) => artifact.includes('org-one'))).toBe(true);
    expect(mounts[1]!.render.mock.calls.every(([, artifact]) => artifact.includes('org-two'))).toBe(true);
  });

  it.each([
    { src: '/private/preview.mockup.html', capable: true },
    { src: 'nimbalyst://doc/preview?orgId=org-one', capable: false },
  ])('keeps embedded subjects unavailable without a shared target and host capability: $src', async ({ src, capable }) => {
    const yDocument = new Y.Doc();
    withHeadlessLexicalBridge(yDocument, { nodes: HeadlessBodyNodes }, ({ editor }) => editor.update(() => {
      $getRoot().append($createEmbeddedFileNode({ src, label: 'Preview', attrs: { embedType: '.mockup.html' } }));
    }, { discrete: true }));
    const element = document.createElement('div'); document.body.append(element);
    const render = vi.fn(() => <div>Must not render</div>);
    const handle = mountCollabEditor({ element, source: { kind: 'in-memory', document: yDocument }, user: { memberId: asTeamMemberId('member'), name: 'Member' }, ...(capable ? { renderDecisionArtifact: render } : {}) });
    mountedHandles.push(handle);
    await settle();
    await waitFor(() => expect(element.querySelector('.collab-bundle-document-embed-unavailable')).not.toBeNull());
    expect(render).not.toHaveBeenCalled();
  });

  it('uses the roster team member id rather than personal org identity for decision addressing', () => {
    expect(decisionMembersFromComments([{ userId: 'member-in-team', personalOrgId: 'personal-org', name: 'Alex' }])).toEqual([{ id: 'member-in-team', name: 'Alex' }]);
  });
  it('paints a pre-populated Y.Doc through the provider bridge and accepts input', async () => {
    const yDocument = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(yDocument, '# Bundle harness\n\nPREPOPULATED-MARKER');
    const element = globalThis.document.createElement('div');
    globalThis.document.body.append(element);

    let ready = false;
    const handle = mountCollabEditor({
      element,
      source: { kind: 'in-memory', document: yDocument },
      user: {
        memberId: asTeamMemberId('member-harness'),
        name: 'Harness User',
        cursorColor: '#3366ff',
      },
      onReady: () => { ready = true; },
    });
    mountedHandles.push(handle);

    await settle();
    const editable = element.querySelector<HTMLElement>('[contenteditable="true"]');
    expect(ready).toBe(true);
    expect(editable?.textContent).toContain('PREPOPULATED-MARKER');

    await act(async () => handle.insertText(' ACCEPTED-INPUT'));
    await settle();

    expect(editable?.textContent).toContain('ACCEPTED-INPUT');
    expect(handle.getMarkdown()).toContain('ACCEPTED-INPUT');
    expect(handle.getState()).toMatchObject({
      connection: 'local',
      edit: 'dirty',
      hostReadOnly: false,
      serverAccess: 'not-applicable',
      termination: null,
    });
    await expect(handle.flush()).resolves.toEqual({
      status: 'not-required',
      reason: 'in-memory',
    });
  });

  it('records browser decision votes in the shared document using the team member identity', async () => {
    const yDocument = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(yDocument, '```decision\nid: browser-q\nask: Ship this?\ntype: singleSelect\noptions:\n  - id: yes\n    label: Ship it\n  - id: no\n    label: Wait\n```');
    const element = document.createElement('div'); document.body.append(element);
    // Shared ballots stay disabled until a privacy-aware server authorizes the
    // list. A transport-free in-memory mount cannot supply that authority.
    const socket = new FakeRoomSocket();
    socket.decisionDocument = yDocument;
    const handle = mountCollabEditor({
      element,
      source: {
        kind: 'team-room', serverUrl: 'ws://collab.test',
        room: { orgId: asTeamOrgId('org-votes'), projectId: asTeamProjectId('project-votes'), documentId: asTeamDocumentId('doc-votes') },
        auth: { scope: 'team', memberId: asTeamMemberId('team-reader'), getTeamJwt: async () => asTeamJwt('team-jwt') },
        createWebSocket: () => socket as unknown as WebSocket,
      },
      user: { memberId: asTeamMemberId('team-reader'), name: 'Reader' },
    });
    mountedHandles.push(handle);
    await settle();
    await act(async () => { socket.open(); socket.deliverSyncResponse(true); });
    await waitFor(() => expect(element.querySelector('button[data-testid="decision-option-row"]')).not.toBeNull());
    const option = [...element.querySelectorAll('button')].find((button) => button.textContent?.includes('Ship it'))!;
    fireEvent.click(option);
    fireEvent.click(element.querySelector('[data-testid="decision-answer"]')!);
    await waitFor(() => expect(yDocument.getMap('decisions').get('browser-q\x1fteam-reader')).toMatchObject({ answer: { type: 'singleSelect', selectedId: 'yes' } }));
  });

  it('paints tracker and shared-document references written by a desktop client', async () => {
    // A desktop client's node set is wider than the bundle's. A Y.Doc holding
    // either reference node used to abort the whole binding with
    // "Node <type> is not registered", so the document never painted.
    const yDocument = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(
      yDocument,
      'Blocked by [NIM-123](nimbalyst://NIM-123), see [Launch Plan](nimbalyst://doc/fa164469-0e2b-4f1a-9c2d-6b1f0a3d5e77).',
    );
    const element = globalThis.document.createElement('div');
    globalThis.document.body.append(element);

    const errors: string[] = [];
    const handle = mountCollabEditor({
      element,
      source: { kind: 'in-memory', document: yDocument },
      user: {
        memberId: asTeamMemberId('member-references'),
        name: 'Reference User',
      },
      onError: (error) => { errors.push(error.message); },
    });
    mountedHandles.push(handle);
    await settle();

    const editable = element.querySelector<HTMLElement>('[contenteditable="true"]');
    expect(errors).toEqual([]);
    expect(editable?.textContent).toContain('NIM-123');
    expect(editable?.textContent).toContain('Launch Plan');
    expect(handle.getMarkdown()).toContain('[NIM-123](nimbalyst://NIM-123)');
    expect(handle.getMarkdown()).toContain(
      '(nimbalyst://doc/fa164469-0e2b-4f1a-9c2d-6b1f0a3d5e77)',
    );
  });

  it('carries no formatting toolbar and applies the browser-host chrome', async () => {
    const yDocument = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(yDocument, 'Chrome marker');
    const element = globalThis.document.createElement('div');
    globalThis.document.body.append(element);

    const handle = mountCollabEditor({
      element,
      source: { kind: 'in-memory', document: yDocument },
      user: {
        memberId: asTeamMemberId('member-chrome'),
        name: 'Chrome User',
        cursorColor: '#3366ff',
      },
    });
    mountedHandles.push(handle);
    await settle();

    // The desktop document editor has no top toolbar; this host must match it.
    expect(element.querySelector('.toolbar')).toBeNull();
    expect(element.querySelector<HTMLElement>('.editor-scroller')?.classList.contains('select-text'))
      .toBe(true);
    // Remote carets would otherwise read collaborators' names into the prose.
    expect(element.querySelector('.collab-cursors-container')?.getAttribute('aria-hidden'))
      .toBe('true');
  });

  it('announces lifecycle departure and rejoins when the document becomes active', async () => {
    const setActive = vi.spyOn(CollabPresenceSurface.prototype, 'setActive');
    const visibilityState = vi.spyOn(document, 'visibilityState', 'get');
    const element = document.createElement('div');
    document.body.append(element);
    const handle = mountCollabEditor({
      element,
      source: { kind: 'in-memory', document: new Y.Doc() },
      user: {
        memberId: asTeamMemberId('member-lifecycle'),
        name: 'Lifecycle User',
      },
    });
    mountedHandles.push(handle);
    await settle();

    window.dispatchEvent(new Event('pagehide'));
    expect(setActive).toHaveBeenLastCalledWith(false);

    window.dispatchEvent(new Event('pageshow'));
    expect(setActive).toHaveBeenLastCalledWith(true);

    visibilityState.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(setActive).toHaveBeenLastCalledWith(false);

    visibilityState.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(setActive).toHaveBeenLastCalledWith(true);

    handle.setPresenceActive(false);
    expect(setActive).toHaveBeenLastCalledWith(false);
    handle.setPresenceActive(true);
    expect(setActive).toHaveBeenLastCalledWith(true);
    visibilityState.mockRestore();
    setActive.mockRestore();
  });
});

/**
 * A room socket that opens and answers the initial sync, and nothing else.
 *
 * That is precisely the state a reader is in: the document arrived, no edit has
 * been attempted, so the server has never acknowledged or refused a write.
 */
class FakeRoomSocket {
  static readonly opened: FakeRoomSocket[] = [];
  readyState = 0;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor() {
    FakeRoomSocket.opened.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const current = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
    current.add(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  decisionDocument?: Y.Doc;

  send(data: string): void {
    if (!this.decisionDocument) return;
    const message = JSON.parse(data);
    if (message.type === 'docDecisionCommand' && message.command.operation === 'list') {
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'docDecisionState', requestId: message.requestId, decisions: [], privacyVersion: 1 }) }));
    }
    if (message.type === 'docUpdate') {
      Y.applyUpdate(this.decisionDocument, base64ToUint8Array(message.encryptedUpdate));
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'docUpdateAck', clientUpdateId: message.clientUpdateId }) }));
    }
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  /**
   * The server's answer to `docSyncRequest`. `canWrite` is omitted to stand in
   * for a server that predates the verdict, which is how the client's fallback
   * to its own host answer stays covered.
   */
  deliverSyncResponse(canWrite?: boolean): void {
    this.emit('message', {
      data: JSON.stringify({
        type: 'docSyncResponse',
        updates: this.decisionDocument ? [{ sequence: 1, encryptedUpdate: uint8ArrayToBase64(Y.encodeStateAsUpdate(this.decisionDocument)), iv: '' }] : [],
        hasMore: false,
        cursor: 0,
        serverHead: 0,
        serverHasState: true,
        ...(canWrite === undefined ? {} : { canWrite }),
      }),
    });
  }

  deliverWriteAcknowledged(): void {
    this.emit('message', {
      data: JSON.stringify({ type: 'docUpdateAck', clientUpdateId: 'probe-access' }),
    });
  }

  /** The server refusing a write, which is how a stale host answer is corrected. */
  deliverReadOnlyRefusal(): void {
    this.emit('message', {
      data: JSON.stringify({
        type: 'error',
        code: 'document_read_only',
        message: 'Your current role permits reading this document but not editing it',
      }),
    });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe('comment authoring on a document that has not been written to', () => {
  async function openTeamDocument(
    documentId: string,
    canComment: () => boolean,
    serverCanWrite?: boolean,
  ): Promise<{ handle: CollabEditorHandle; documentUri: string }> {
    FakeRoomSocket.opened.length = 0;
    const element = document.createElement('div');
    document.body.append(element);
    const documentUri = `nimbalyst://doc/${documentId}`;
    const comments: CollabEditorCommentsOptions = {
      currentUser: { id: 'member-reader', name: 'Reader' },
      getMembers: () => [],
      documentTitle: 'Shared plan',
      documentId,
      documentUri,
      canComment,
    };
    const handle = mountCollabEditor({
      element,
      source: {
        kind: 'team-room',
        serverUrl: 'ws://collab.test',
        room: {
          orgId: asTeamOrgId('org-comments'),
          projectId: asTeamProjectId('project-comments'),
          documentId: asTeamDocumentId(documentId),
        },
        auth: {
          scope: 'team',
          memberId: asTeamMemberId('member-reader'),
          getTeamJwt: async () => asTeamJwt('team-jwt'),
        },
        createWebSocket: () => new FakeRoomSocket() as unknown as WebSocket,
      },
      user: { memberId: asTeamMemberId('member-reader'), name: 'Reader' },
      comments,
    });
    mountedHandles.push(handle);
    await settle();

    const socket = FakeRoomSocket.opened[0];
    if (!socket) throw new Error('the editor never opened a room socket');
    await act(async () => {
      socket.open();
      socket.deliverSyncResponse(serverCanWrite);
    });
    await settle();
    return { handle, documentUri };
  }

  function commentCapability(documentUri: string): boolean {
    const controller = collabCommentControllerRegistry.get(documentUri);
    if (!controller) throw new Error('the comment plugin never registered a controller');
    return controller.getCapabilities().comment;
  }

  function commentController(documentUri: string) {
    const controller = collabCommentControllerRegistry.get(documentUri);
    if (!controller) throw new Error('the comment plugin never registered a controller');
    return controller;
  }

  it('lets a permitted host author on a document it has never written to', async () => {
    // The server only ever acknowledges a write it was asked to make, so a
    // document opened to be annotated stays at 'unknown' for its whole session.
    // Authoring has to be available there or the comment panel is unusable.
    const writer = await openTeamDocument('doc-writer', () => true);
    expect(writer.handle.getState()).toMatchObject({
      connection: 'connected',
      serverAccess: 'unknown',
    });
    expect(commentCapability(writer.documentUri)).toBe(true);
    // Reaching anchor resolution at all is the point: this attempt used to be
    // turned away as COMMENT_FORBIDDEN before the anchor was ever looked at.
    await expect(commentController(writer.documentUri).createAnchored({
      anchor: { exact: 'not present' },
      body: 'Authored before any edit',
      clientMutationId: 'unknown-access-attempt',
    }, {
      kind: 'user',
      userId: 'member-reader',
      displayName: 'Reader',
    })).rejects.toMatchObject({ code: 'ANCHOR_NOT_FOUND' });
  });

  it('takes the sync response write verdict without waiting for a write', async () => {
    // A server that reports access on connect settles this before the user
    // touches anything, so a downgraded member is never offered an affordance
    // that would bounce.
    const writer = await openTeamDocument('doc-verdict-writer', () => true, true);
    expect(writer.handle.getState()).toMatchObject({
      serverAccess: 'writable',
      readOnly: false,
    });
    expect(commentCapability(writer.documentUri)).toBe(true);

    const downgraded = await openTeamDocument('doc-verdict-reader', () => true, false);
    expect(downgraded.handle.getState()).toMatchObject({
      serverAccess: 'read-only',
      readOnly: true,
    });
    expect(commentCapability(downgraded.documentUri)).toBe(false);
  });

  it('refuses a host that says no, and withdraws on a server write refusal', async () => {
    const viewer = await openTeamDocument('doc-viewer', () => false);
    expect(viewer.handle.getState()).toMatchObject({
      connection: 'connected',
      serverAccess: 'unknown',
    });
    expect(commentCapability(viewer.documentUri)).toBe(false);
    await expect(commentController(viewer.documentUri).createAnchored({
      anchor: { exact: 'not present' },
      body: 'Must not be written locally',
      clientMutationId: 'viewer-attempt',
    }, {
      kind: 'user',
      userId: 'member-reader',
      displayName: 'Reader',
    })).rejects.toMatchObject({ code: 'COMMENT_FORBIDDEN' });
    expect(viewer.handle.getDocument().getArray('comments')).toHaveLength(0);

    // A host answer that has gone stale is corrected by the server's refusal
    // rather than by withholding the affordance up front.
    const stale = await openTeamDocument('doc-downgraded', () => true);
    expect(commentCapability(stale.documentUri)).toBe(true);
    const staleSocket = FakeRoomSocket.opened[0];
    if (!staleSocket) throw new Error('the downgraded member never opened a room socket');
    await act(async () => staleSocket.deliverReadOnlyRefusal());
    expect(stale.handle.getState()).toMatchObject({ serverAccess: 'read-only' });
    expect(commentCapability(stale.documentUri)).toBe(false);
  });
});
