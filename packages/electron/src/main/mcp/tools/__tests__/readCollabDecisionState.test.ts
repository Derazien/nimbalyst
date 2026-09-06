import { beforeEach, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({ request: vi.fn(), window: { id: 1 } }));
vi.mock('../../rendererRequest', () => ({ requestFromRenderer: host.request }));
vi.mock('../../mcpWorkspaceResolver', () => ({ findWindowForFilePath: vi.fn(async () => host.window) }));
import { getEditorToolSchemas, handleReadCollabDoc } from '../editorToolHandlers';
beforeEach(() => host.request.mockReset());
it('exposes decision state only as an opt-in read flag', () => {
  const schema = getEditorToolSchemas(undefined).find(tool => tool.name === 'readCollabDoc')!.inputSchema;
  expect(schema.properties.includeDecisionState.type).toBe('boolean');
  expect(schema.required).toEqual(['filePath']);
});
it('forwards the flag and separates read-only state from editable source', async () => {
  const decisionState = { readOnly: true, blocks: [{ blockId: 'dcn-a', humanVotes: [], agentRecommendations: [] }], truncated: false };
  host.request.mockResolvedValue({ status: 'received', response: { success: true, content: 'source', decisionState } });
  const result = await handleReadCollabDoc({ filePath: 'collab://org:o:doc:d', includeDecisionState: true });
  expect(host.request.mock.calls[0][2]).toMatchObject({ includeDecisionState: true });
  expect(result.content[0].text).toBe('source');
  expect(result.content[1].text).toContain('Read-only decision state');
  expect(result.content[1].text).toContain('humanVotes');
});
it('leaves default source reads unchanged', async () => {
  host.request.mockResolvedValue({ status: 'received', response: { success: true, content: 'source' } });
  expect(await handleReadCollabDoc({ filePath: 'collab://org:o:doc:d' })).toEqual({ content: [{ type: 'text', text: 'source' }], isError: false });
  expect(host.request.mock.calls[0][2]).not.toHaveProperty('includeDecisionState');
});
