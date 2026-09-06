// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  team: vi.fn(), policy: vi.fn(), model: vi.fn(), find: vi.fn(), create: vi.fn(), ensure: vi.fn(), active: vi.fn(), sync: vi.fn(), ack: vi.fn(),
}));
vi.mock('@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel', () => ({ globalRegistry: { getForWorkspace: mocks.model } }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({ database: {} }));
vi.mock('../../window/WindowManager', () => ({ documentServices: new Map([['/work', { getTrackerItemById: mocks.find, createTrackerItem: mocks.create }]]) }));
vi.mock('../TeamService', () => ({ resolveTeamForWorkspace: mocks.team }));
vi.mock('../TrackerSchemaService', () => ({ ensureWorkspaceTrackerSchemasLoaded: vi.fn() }));
vi.mock('../TrackerPolicyService', () => ({ resolveTrackerSharingPolicy: mocks.policy }));
vi.mock('../TrackerSyncManager', () => ({ ensureTrackerSyncForWorkspace: mocks.ensure, isTrackerSyncActive: mocks.active, syncTrackerItem: mocks.sync }));
vi.mock('../tracker/awaitServerIssueKey', () => ({ awaitServerIssueKey: mocks.ack }));
import { ensureDocumentDecisionTracker } from '../DocumentDecisionTrackerService';

const input = { workspacePath: '/work', orgId: 'org-1', teamProjectId: 'server-project', documentId: 'doc-1', blockIds: ['block-a', 'block-b'], title: 'Choose a direction' };
let saved: any;
beforeEach(() => {
  vi.clearAllMocks();
  saved = null;
  mocks.team.mockResolvedValue({ team: { orgId: 'org-1', teamProjectId: 'server-project' } });
  mocks.policy.mockReturnValue({ known: true, policy: { sharing: 'team', draftByDefault: false } });
  mocks.model.mockReturnValue({ creatable: true });
  mocks.active.mockReturnValue(true);
  mocks.find.mockImplementation(async () => saved);
  mocks.create.mockImplementation(async (value) => { saved = { ...value, module: '' }; return saved; });
  mocks.ack.mockResolvedValue('NIM-101');
});

describe('standalone document tracker linking', () => {
  it('creates one native link, waits for the server key, and reuses it on concurrent/repeated send', async () => {
    const results = await Promise.all([ensureDocumentDecisionTracker(input), ensureDocumentDecisionTracker(input)]);
    expect(results[0]).toEqual({ status: 'linked', itemId: 'decision-document-doc-1', issueKey: 'NIM-101' });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.sync).toHaveBeenCalledOnce();
    expect(saved.customFields).toMatchObject({ decisionId: 'block-a', linkedDecisionBlockIds: ['block-a', 'block-b'], shared: true });
    expect(saved.description).toContain('/org/org-1/project/server-project/document/doc-1?blockId=block-a');
    expect(saved.content).toBeUndefined();
    saved.issueKey = 'NIM-101';
    saved.status = 'decided';
    await ensureDocumentDecisionTracker(input);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.sync).toHaveBeenCalledOnce();
    expect(saved.status).toBe('decided');
  });

  it('does not claim success without server acknowledgement and retries the original row', async () => {
    mocks.ack.mockResolvedValueOnce(null);
    await expect(ensureDocumentDecisionTracker(input)).rejects.toThrow('not been acknowledged');
    await expect(ensureDocumentDecisionTracker(input)).resolves.toMatchObject({ status: 'linked' });
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('skips private or unknown schemas without changing sharing or creating any item', async () => {
    mocks.policy.mockReturnValueOnce({ known: true, policy: { sharing: 'personal', draftByDefault: false } });
    await expect(ensureDocumentDecisionTracker(input)).resolves.toMatchObject({ status: 'skipped', reason: expect.stringContaining('private') });
    mocks.policy.mockReturnValueOnce({ known: false });
    await expect(ensureDocumentDecisionTracker(input)).resolves.toMatchObject({ status: 'skipped' });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it('fails closed when the workspace moves to another team or project', async () => {
    mocks.team.mockResolvedValue({ team: { orgId: 'org-1', teamProjectId: 'another-project' } });
    await expect(ensureDocumentDecisionTracker(input)).rejects.toThrow('no longer matches');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('never adopts or publishes a colliding legacy file-backed item', async () => {
    saved = { id: 'decision-document-doc-1', type: 'decision', source: 'frontmatter', module: 'private.md', workspace: '/work' };
    await expect(ensureDocumentDecisionTracker(input)).rejects.toThrow('different item');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});
