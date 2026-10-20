import type { AppAgentsResponses } from '@opencode-ai/sdk/client';
import { OpenCodeServerManager } from '../../protocols/OpenCodeSDKProtocol';
import { createOpenCodeClientForServer } from './OpenCodeSdkClient';

type AgentListPayload = AppAgentsResponses[200];
type OpenCodeAgent = AgentListPayload[number];

interface OpenCodeAgentClient {
  app: {
    agents(options?: {
      query?: { directory?: string };
    }): Promise<{ data?: AgentListPayload }>;
  };
}

interface OpenCodeAgentServerManager {
  readonly isRunning: boolean;
  readonly baseUrl: string;
  readonly serverGeneration: number;
}

/**
 * The subset of an OpenCode agent the host needs to offer it as a session role.
 * Deliberately not the SDK `Agent` type: this crosses the IPC boundary into the
 * renderer, so it stays plain, serializable data with no SDK import.
 */
export interface OpenCodeAgentSummary {
  name: string;
  description?: string;
  mode: 'primary' | 'all';
  builtIn: boolean;
  /**
   * The model this role is configured to run. OpenCode resolves
   * `input.model ?? agent.model ?? session model`, and Nimbalyst always sends an
   * explicit per-prompt model, so this is reported to the user rather than
   * applied silently -- see the role selector for how the conflict is surfaced.
   */
  model?: { providerID: string; modelID: string };
  /** Permission policy, so the user knows what the role may do before running as it. */
  permission: {
    edit: 'ask' | 'allow' | 'deny';
    bash: Record<string, 'ask' | 'allow' | 'deny'>;
    webfetch?: 'ask' | 'allow' | 'deny';
  };
}

export interface OpenCodeAgentCatalogSnapshot {
  agents: OpenCodeAgentSummary[];
  /** True once a running server has answered for this workspace. */
  discovered: boolean;
  error?: string;
}

export interface OpenCodeAgentCatalogDependencies {
  createClient?: (baseUrl: string) => OpenCodeAgentClient | Promise<OpenCodeAgentClient>;
  getServerManager?: () => OpenCodeAgentServerManager;
}

const defaultDependencies: Required<OpenCodeAgentCatalogDependencies> = {
  createClient: async (baseUrl) => {
    const connection = OpenCodeServerManager.getInstance().connection;
    return (await createOpenCodeClientForServer(
      connection.baseUrl === baseUrl ? connection : { baseUrl, apiVersion: null, authorization: null }
    )) as OpenCodeAgentClient;
  },
  getServerManager: () => OpenCodeServerManager.getInstance(),
};

let dependencies = { ...defaultDependencies };

/**
 * In-memory only, keyed by server generation + workspace. Agents are defined by
 * OpenCode's own config (global plus `.opencode/agent` in the project), so the
 * answer is per-workspace and only valid for the server process that gave it.
 * Nothing here is persisted: the user's *selection* lives in session metadata
 * and is sent regardless of what this cache knows, so a cold cache costs a
 * label, never a behavior.
 */
const cache = new Map<string, OpenCodeAgentSummary[]>();

/** Test-only: drop the cache and swap in stub client/server dependencies. */
export function configureOpenCodeAgentCatalogForTests(
  next?: OpenCodeAgentCatalogDependencies
): void {
  dependencies = { ...defaultDependencies, ...next };
  cache.clear();
}

/**
 * Read the roles OpenCode offers for this workspace.
 *
 * Never starts a server: it answers from the cache and refreshes only when a
 * server is already running, matching the model catalog's rule that opening a
 * piece of UI must not silently spawn `opencode serve`. In practice the cache
 * fills on the session's first turn, which is when a server exists.
 */
export async function getOpenCodeAgentCatalog(
  workspacePath: string
): Promise<OpenCodeAgentCatalogSnapshot> {
  const manager = dependencies.getServerManager();
  const key = `${manager.serverGeneration}:${workspacePath}`;
  const cached = cache.get(key);

  if (!manager.isRunning) {
    return { agents: cached ?? [], discovered: !!cached };
  }

  try {
    const client = await dependencies.createClient(manager.baseUrl);
    const response = await client.app.agents({ query: { directory: workspacePath } });
    if (!Array.isArray(response.data)) {
      throw new Error('OpenCode app.agents did not return an agent list');
    }
    const agents = selectSessionRoles(response.data);
    cache.set(key, agents);
    return { agents, discovered: true };
  } catch (error) {
    return {
      agents: cached ?? [],
      discovered: !!cached,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Keep only the agents that can be run as the session's own role.
 *
 * `primary` is a role you run the session as; `all` is an agent OpenCode allows
 * in either position, so it qualifies too. `subagent` is the teammate surface --
 * a child session spawned by the primary agent -- and is not a session role.
 */
function selectSessionRoles(agents: AgentListPayload): OpenCodeAgentSummary[] {
  return agents
    .filter((agent) => agent.mode === 'primary' || agent.mode === 'all')
    .map(toAgentSummary);
}

function toAgentSummary(agent: OpenCodeAgent): OpenCodeAgentSummary {
  return {
    name: agent.name,
    ...(agent.description ? { description: agent.description } : {}),
    mode: agent.mode as 'primary' | 'all',
    builtIn: agent.builtIn,
    ...(agent.model
      ? { model: { providerID: agent.model.providerID, modelID: agent.model.modelID } }
      : {}),
    permission: {
      edit: agent.permission.edit,
      bash: { ...agent.permission.bash },
      ...(agent.permission.webfetch ? { webfetch: agent.permission.webfetch } : {}),
    },
  };
}
