// @vitest-environment node
/**
 * A meta-agent tool that is defined but not routed is invisible to every session.
 *
 * `/mcp/host` lists a tool only when the topology reverse index maps its name to the host
 * server. archive_session and unarchive_session shipped with definitions, handlers and
 * tests, and no session could see them, because the topology was never told. A live
 * session searched its whole tool list and reported the tool did not exist.
 */
import { describe, expect, it } from 'vitest';
import { MCP_HOST } from '@nimbalyst/runtime/ai/server';
import { META_AGENT_TOOL_DEFS } from '../metaAgentServer';
import { selectFirstPartyToolsForEndpoint } from '../mcpEndpointRouting';

describe('meta-agent tools reach the host endpoint', () => {
  it('routes every defined meta-agent tool to /mcp/host', () => {
    const routed = new Set(selectFirstPartyToolsForEndpoint(META_AGENT_TOOL_DEFS, MCP_HOST).map((t) => t.name));
    const dropped = META_AGENT_TOOL_DEFS.map((t) => t.name).filter((name) => !routed.has(name));
    expect(dropped).toEqual([]);
  });
});
