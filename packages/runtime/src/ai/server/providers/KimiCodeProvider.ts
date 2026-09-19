/**
 * Kimi Code Agent Provider
 *
 * Integrates the Kimi Code CLI (`kimi`) into Nimbalyst through its ACP
 * (Agent Communication Protocol) server mode: `kimi acp` speaks standard ACP
 * over stdio, driven by the sibling `KimiACPProtocol` adapter under
 * `protocols/`.
 *
 * Auth is the user's Kimi membership via the CLI's own OAuth device flow
 * (`kimi login`) -- there is no API key anywhere in this path, and per the
 * repo's hard rule no key is ever read from `process.env`. Unauthenticated
 * calls fail server-side with JSON-RPC -32000 (`authRequired`), which this
 * provider maps to an `isAuthError` chunk pointing at `kimi login`.
 *
 * Key features:
 * - ACP protocol transport (not PTY scraping)
 * - Session create/resume via protocol session IDs
 * - MCP server passthrough to Kimi's ACP session (inline via `session/new`)
 * - Per-tool permission round-trips owned by the protocol layer (`kimi`
 *   issues `session/request_permission` per action), so the only gate here is
 *   workspace trust -- not an upfront allow-all requirement
 * - Canonical transcript storage via raw event logging (parsed back by
 *   `KimiACPRawParser`)
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BaseAgentProvider } from './BaseAgentProvider';
import { buildUserMessageAddition } from './documentContextUtils';
import { describeUnusableWorkspacePath } from './workspacePreconditions';
import { buildClaudeCodeSystemPrompt } from '../../prompt';
import { DEFAULT_MODELS } from '../../modelConstants';
import {
  ProviderConfig,
  DocumentContext,
  StreamChunk,
  AIModel,
  AIProviderType,
  ChatAttachment,
} from '../types';
import { ModelIdentifier } from '../ModelIdentifier';
import { KimiACPProtocol, type OnBeforeKimiFileWrite, type OnKimiTurnFilesEdited } from '../protocols/KimiACPProtocol';
import { ProtocolEvent, ProtocolSession } from '../protocols/ProtocolInterface';
import { PermissionMode } from './ProviderPermissionMixin';
import { McpConfigService } from '../services/McpConfigService';
import { getMcpConfigService, isInternalMcpServerEnabled, areTrackerToolsEnabled, resolveTrackersWorkspacePath } from '../services/mcpServerConfig';
import { MCPServerConfig } from '../../../types/MCPServerConfig';
import { safeJSONSerialize } from '../../../utils/serialization';
import { AgentProtocolTranscriptAdapter } from './agentProtocol/AgentProtocolTranscriptAdapter';
import { TranscriptMigrationRepository } from '../../../storage/repositories/TranscriptMigrationRepository';

interface KimiCodeProviderDeps {
  protocol?: KimiACPProtocol;
}

function splitPathEntries(pathValue: string | undefined): string[] {
  if (!pathValue) return [];
  return pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

function findExecutableInPathEntries(
  executableNames: string[],
  pathValue: string | undefined
): string | undefined {
  for (const entry of splitPathEntries(pathValue)) {
    for (const executableName of executableNames) {
      const candidate = path.join(entry, executableName);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function getSystemKimiExecutableCandidates(pathValue?: string): string[] {
  const platform = process.platform;
  const homeDir = os.homedir();
  const pathModule = platform === 'win32' ? path.win32 : path;
  const seen = new Set<string>();
  const candidates: string[] = [];
  const addCandidate = (candidate: string | undefined) => {
    if (!candidate) return;
    const normalized = pathModule.normalize(candidate);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(candidate);
  };

  if (platform === 'win32') {
    // Native installer location (%USERPROFILE%\.kimi-code\bin\kimi.exe).
    addCandidate(path.win32.join(homeDir, '.kimi-code', 'bin', 'kimi.exe'));
    addCandidate(path.win32.join(homeDir, '.kimi-code', 'bin', 'kimi.cmd'));
    const appData = process.env.APPDATA || path.win32.join(homeDir, 'AppData', 'Roaming');
    addCandidate(path.win32.join(appData, 'npm', 'kimi.cmd'));
    addCandidate(path.win32.join(homeDir, 'AppData', 'Roaming', 'npm', 'kimi.cmd'));
    addCandidate(findExecutableInPathEntries(['kimi.exe', 'kimi.cmd'], pathValue ?? process.env.PATH));
    addCandidate('kimi');
    return candidates;
  }

  addCandidate(path.join(homeDir, '.kimi-code', 'bin', 'kimi'));
  addCandidate(path.join(homeDir, '.local', 'bin', 'kimi'));
  addCandidate(path.join(homeDir, '.npm-global', 'bin', 'kimi'));
  addCandidate('/usr/local/bin/kimi');
  addCandidate('/opt/homebrew/bin/kimi');
  addCandidate(findExecutableInPathEntries(['kimi'], pathValue ?? process.env.PATH));
  addCandidate('kimi');
  return candidates;
}

const KIMI_NOT_INSTALLED_ERROR =
  'Kimi Code CLI is not installed. Install it with one of:\n\n' +
  '  npm install -g @moonshot-ai/kimi-code\n' +
  '  or the native installer from https://www.kimi.com/code\n\n' +
  'Then run `kimi login` to authenticate with your Kimi membership.';

const KIMI_AUTH_ERROR =
  'Kimi Code is not logged in. Run `kimi login` in your terminal to authenticate with your Kimi membership (device flow), then retry.';

export class KimiCodeProvider extends BaseAgentProvider {
  static readonly DEFAULT_MODEL = DEFAULT_MODELS['kimi-code'];

  // Static alias catalog mirroring what the CLI's ACP model picker reports
  // (verified against `kimi acp` session/new configOptions). The live catalog
  // arrives via those configOptions in a later phase; aliases here are the
  // short form -- the ACP transport spells them `kimi-code/<alias>`.
  private static readonly ALIAS_CATALOG: ReadonlyArray<{
    alias: string;
    name: string;
    contextWindow: number;
  }> = [
    { alias: 'k3', name: 'Kimi K3', contextWindow: 1048576 },
    { alias: 'k3-256k', name: 'Kimi K3 (256K)', contextWindow: 262144 },
    { alias: 'kimi-for-coding', name: 'Kimi for Coding (K2.8 Preview)', contextWindow: 262144 },
    { alias: 'kimi-for-coding-highspeed', name: 'Kimi for Coding Highspeed (K2.7)', contextWindow: 262144 },
  ];

  private readonly protocol: KimiACPProtocol;
  private readonly mcpConfigService: McpConfigService;

  private _initData: {
    model: string;
    mcpServerCount: number;
    isResumedSession: boolean;
  } | null = null;

  // Internal MCP-server enablement (ports, kill-switches, extension/tracker
  // loaders, auth token) lives in the shared `mcpServerConfig` registry now.
  private static mcpConfigLoader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null = null;
  private static shellEnvironmentLoader: (() => Record<string, string> | null) | null = null;
  private static enhancedPathLoader: (() => string) | null = null;
  private static kimiPathLoader: (() => string | null) | null = null;
  // fs/write_text_file hooks (pre-edit baseline, turn-end refresh). Kimi
  // routes Write and Edit through that reverse-RPC, and the arguments reach
  // the stream only milliseconds before the write lands, so this hook is the
  // one deterministic place to snapshot the file first.
  private static onBeforeFileWrite: OnBeforeKimiFileWrite | null = null;
  private static onTurnFilesEdited: OnKimiTurnFilesEdited | null = null;

  constructor(deps?: KimiCodeProviderDeps) {
    super();

    this.protocol = deps?.protocol || new KimiACPProtocol(undefined, {
      onBeforeFileWrite: KimiCodeProvider.onBeforeFileWrite ?? undefined,
      onTurnFilesEdited: KimiCodeProvider.onTurnFilesEdited ?? undefined,
    });

    this.mcpConfigService = getMcpConfigService({
      mcpConfigLoader: KimiCodeProvider.mcpConfigLoader,
      claudeSettingsEnvLoader: null,
      shellEnvironmentLoader: KimiCodeProvider.shellEnvironmentLoader,
    });
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
  }

  getProviderName(): AIProviderType {
    return 'kimi-code';
  }

  // --- Static injection setters (called from electron main process at startup) ---
  // Internal MCP-server ports / kill-switches / loaders / auth token are
  // configured once via `configureMcpServers` (shared registry).

  public static setMCPConfigLoader(loader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null): void {
    KimiCodeProvider.mcpConfigLoader = loader;
  }

  public static setShellEnvironmentLoader(loader: (() => Record<string, string> | null) | null): void {
    KimiCodeProvider.shellEnvironmentLoader = loader;
  }

  public static setEnhancedPathLoader(loader: (() => string) | null): void {
    KimiCodeProvider.enhancedPathLoader = loader;
  }

  public static setKimiPathLoader(loader: (() => string | null) | null): void {
    KimiCodeProvider.kimiPathLoader = loader;
  }

  public static setOnBeforeFileWrite(handler: OnBeforeKimiFileWrite | null): void {
    KimiCodeProvider.onBeforeFileWrite = handler;
  }

  public static setOnTurnFilesEdited(handler: OnKimiTurnFilesEdited | null): void {
    KimiCodeProvider.onTurnFilesEdited = handler;
  }

  private static resolveKimiExecutableForRuntime(pathValue?: string): string | undefined {
    if (KimiCodeProvider.kimiPathLoader) {
      const customPath = KimiCodeProvider.kimiPathLoader();
      if (customPath) {
        return customPath;
      }
    }

    for (const candidate of getSystemKimiExecutableCandidates(pathValue)) {
      if (candidate === 'kimi' || fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  // --- Model discovery ---

  static async getModels(): Promise<AIModel[]> {
    return KimiCodeProvider.ALIAS_CATALOG.map((entry) => ({
      id: ModelIdentifier.create('kimi-code', entry.alias).combined,
      name: entry.name,
      provider: 'kimi-code' as AIProviderType,
      contextWindow: entry.contextWindow,
    }));
  }

  static getDefaultModel(): string {
    return KimiCodeProvider.DEFAULT_MODEL;
  }

  getName(): string {
    return 'kimi-code';
  }

  getDisplayName(): string {
    return 'Kimi Code';
  }

  getDescription(): string {
    return 'Kimi Code CLI agent provider via ACP protocol (kimi login membership auth)';
  }

  getProviderSessionData(sessionId: string): any {
    const { providerSessionId } = this.sessions.getProviderSessionData(sessionId);
    return {
      providerSessionId,
      kimiAcpSessionId: providerSessionId,
    };
  }

  getInitData(): {
    model: string;
    mcpServerCount: number;
    isResumedSession: boolean;
  } | null {
    return this._initData;
  }

  async cancelStream(_sessionId?: string): Promise<void> {
    this.abort();
  }

  async *sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    messages?: any[],
    workspacePath?: string,
    attachments?: ChatAttachment[]
  ): AsyncIterableIterator<StreamChunk> {
    const unusableWorkspace = describeUnusableWorkspacePath(workspacePath);
    if (unusableWorkspace || !workspacePath) {
      yield { type: 'error', error: unusableWorkspace ?? 'No project folder is set for this session.' };
      return;
    }

    const systemPrompt = this.buildSystemPrompt(documentContext);
    const { userMessageAddition, messageWithContext } = buildUserMessageAddition(message, documentContext);

    if (sessionId && (systemPrompt || userMessageAddition)) {
      this.emit('promptAdditions', {
        sessionId,
        systemPromptAddition: systemPrompt || null,
        userMessageAddition,
        attachments: [],
        timestamp: Date.now(),
      });
    }

    const prompt = messageWithContext;

    if (sessionId) {
      const metadataToLog: Record<string, unknown> = this.withPromptProvenanceMetadata(documentContext);
      if (documentContext?.mode) {
        metadataToLog.mode = documentContext.mode;
      }
      await this.logAgentMessageBestEffort(
        sessionId,
        'input',
        prompt,
        Object.keys(metadataToLog).length > 0 ? { metadata: metadataToLog } : undefined
      );
    }

    const mcpConfigWorkspacePath = documentContext?.mcpConfigWorkspacePath || workspacePath;
    const abortController = new AbortController();
    this.abortController = abortController;

    let fullText = '';

    try {
      // Kimi asks per tool via ACP `session/request_permission` round-trips
      // owned by the protocol layer, so the only provider-side gate is
      // workspace trust -- unlike Copilot, no allow-all mode is required.
      const permissionResult = await this.requestKimiTurnPermission(
        workspacePath,
        documentContext?.permissionsPath
      );
      if (permissionResult.decision !== 'allow') {
        yield { type: 'error', error: permissionResult.reason || 'Kimi Code turn denied' };
        return;
      }

      const existingSessionId = this.sessions.getSessionId(sessionId || '');

      const mcpServers = await this.mcpConfigService.getMcpServersConfig({
        sessionId,
        workspacePath: mcpConfigWorkspacePath,
        profile: 'standard',
      });

      this.configureProtocol();

      const kimiAvailable = KimiCodeProvider.isKimiInstalled();
      if (!kimiAvailable) {
        yield { type: 'error', error: KIMI_NOT_INSTALLED_ERROR };
        return;
      }

      const resolvedModel = this.getConfiguredModel();
      const isResumedSession = !!existingSessionId;

      const sessionOptions = {
        workspacePath,
        model: resolvedModel,
        systemPrompt,
        mcpServers,
        ...(permissionResult.permissionMode ? { permissionMode: permissionResult.permissionMode } : {}),
      };

      const session = isResumedSession
        ? await this.protocol.resumeSession(existingSessionId, sessionOptions)
        : await this.protocol.createSession(sessionOptions);

      this._initData = {
        // The protocol reports the model it actually applied (`session/set_model`
        // can be refused); fall back to what we asked for when it has no say.
        model: session.appliedModel ?? resolvedModel,
        mcpServerCount: Object.keys(mcpServers).length,
        isResumedSession,
      };

      const transcriptAdapter = new AgentProtocolTranscriptAdapter(null, sessionId ?? '');
      transcriptAdapter.userMessage(
        prompt,
        documentContext?.mode === 'planning' ? 'planning' : 'agent',
        attachments as any,
      );

      for await (const event of this.protocol.sendMessage(session, {
        content: prompt,
        attachments,
        sessionId,
        mode: documentContext?.mode || 'agent',
        // Per-turn signal: this is what turns Stop into session/cancel.
        abortSignal: abortController.signal,
      })) {
        if (abortController.signal.aborted) {
          throw new Error('Operation cancelled');
        }

        if (sessionId) {
          try {
            await this.storeRawEventIfPresent(event, sessionId);
          } catch {
            // DB not available -- non-critical
          }
        }

        for (const item of transcriptAdapter.processEvent(event)) {
          switch (item.kind) {
            case 'text':
              fullText += item.text;
              yield { type: 'text', content: item.text };
              break;
            case 'tool_call':
              yield { type: 'tool_call', toolCall: item.toolCall };
              break;
            case 'tool_result':
              // File tracking closes its edit window on a tool_call that
              // carries a result.
              yield {
                type: 'tool_call',
                toolCall: {
                  id: item.toolResult.id,
                  name: item.toolResult.name,
                  result: item.toolResult.result,
                },
              };
              break;
            case 'complete':
              // Store the complete assistant response so the KimiACPRawParser
              // can create a canonical assistant_message event from it.
              if (sessionId && fullText) {
                await this.storeAssistantResponse(sessionId, fullText);
                // Process the new raw message through the transformer NOW,
                // before yielding `complete`. The parser skips per-chunk ACP
                // events and only produces canonical events from the
                // item.completed message we just stored. Without this call,
                // the transformer might not run again before the session
                // reload (watermark already advanced past chunk events).
                await this.processTranscriptMessages(sessionId);
              }
              yield {
                type: 'complete',
                content: item.event.content,
                isComplete: true,
                usage: item.event.usage,
              };
              break;
            case 'error':
              yield this.toErrorChunk(item.message);
              break;
            case 'raw_event':
            case 'reasoning':
            case 'unknown':
              break;
          }
        }
      }

      if (sessionId && session.id && session.id !== existingSessionId) {
        this.sessions.captureSessionId(sessionId, session.id);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isAbort = abortController.signal.aborted || /abort|cancel/i.test(errorMessage);
      if (!isAbort) {
        yield this.toErrorChunk(errorMessage);
      }
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null;
      }
    }
  }

  cleanupSession(sessionId: string): void {
    this.sessions.deleteSession(sessionId);
  }

  destroy(): void {
    this.protocol.destroy();
    super.destroy();
  }

  protected buildSystemPrompt(documentContext?: DocumentContext): string {
    const hasSessionNaming = isInternalMcpServerEnabled();
    const worktreePath = documentContext?.worktreePath;

    return buildClaudeCodeSystemPrompt({
      hasSessionNaming,
      toolReferenceStyle: 'codex',
      worktreePath,
      isVoiceMode: false,
      enableAgentTeams: false,
      trackersEnabled: areTrackerToolsEnabled(resolveTrackersWorkspacePath(documentContext)),
    });
  }

  /**
   * Map a Nimbalyst model id (`kimi-code:k3`) onto the ACP alias the CLI
   * expects (`kimi-code/k3`). Values that already carry the transport spelling
   * pass through untouched.
   */
  private getConfiguredModel(): string {
    const configured = this.config?.model || KimiCodeProvider.DEFAULT_MODEL;
    const parsed = ModelIdentifier.tryParse(configured);
    const alias = parsed && parsed.provider === 'kimi-code'
      ? parsed.model
      : configured.replace(/^kimi-code:/, '');
    if (alias.startsWith('kimi-code/')) {
      return alias;
    }
    return `kimi-code/${alias}`;
  }

  private toErrorChunk(errorMessage: string): StreamChunk {
    if (/authRequired|-32000|login|unauthorized/i.test(errorMessage)) {
      return { type: 'error', error: KIMI_AUTH_ERROR, isAuthError: true };
    }
    if (/process exited|ENOENT|spawn.*kimi/i.test(errorMessage)) {
      return { type: 'error', error: KIMI_NOT_INSTALLED_ERROR };
    }
    return { type: 'error', error: errorMessage };
  }

  private static isKimiInstalled(): boolean {
    const command = KimiCodeProvider.resolveKimiExecutableForRuntime(
      KimiCodeProvider.enhancedPathLoader?.() || process.env.PATH
    ) || 'kimi';
    // Use the enhanced PATH (npm-global, ~/.kimi-code/bin, etc.) so the runtime
    // check matches what the settings panel sees. A packaged app launched from
    // a GUI shell has a minimal process.env.PATH, which misses every place
    // kimi is typically installed.
    let env: NodeJS.ProcessEnv | undefined;
    if (KimiCodeProvider.enhancedPathLoader) {
      try {
        env = { ...process.env, PATH: KimiCodeProvider.enhancedPathLoader() };
      } catch {
        // fall through to default env
      }
    }
    try {
      execFileSync(command, ['--version'], { stdio: 'pipe', timeout: 5000, env });
      return true;
    } catch {
      return false;
    }
  }

  private configureProtocol(): void {
    const resolvedPath = KimiCodeProvider.resolveKimiExecutableForRuntime(
      KimiCodeProvider.enhancedPathLoader?.() || process.env.PATH
    );
    if (resolvedPath) {
      this.protocol.setKimiPath(resolvedPath);
    }
    // Default: `kimi acp` (from the @moonshot-ai/kimi-code install)

    const env = KimiCodeProvider.buildKimiEnvironment();
    if (env) {
      this.protocol.setProcessEnv(env);
    }
  }

  private static buildKimiEnvironment(): Record<string, string> | null {
    let shellEnv: Record<string, string> | null = null;
    let enhancedPath: string | null = null;

    if (KimiCodeProvider.shellEnvironmentLoader) {
      try {
        shellEnv = KimiCodeProvider.shellEnvironmentLoader();
      } catch {
        // continue without shell env
      }
    }

    if (KimiCodeProvider.enhancedPathLoader) {
      try {
        enhancedPath = KimiCodeProvider.enhancedPathLoader();
      } catch {
        // continue without enhanced PATH
      }
    }

    if (!shellEnv && !enhancedPath) {
      return null;
    }

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    if (shellEnv) {
      Object.assign(env, shellEnv);
    }
    if (enhancedPath) {
      env.PATH = enhancedPath;
    }

    // Scrub API keys per CLAUDE.md policy -- kimi auth is the CLI's own OAuth
    // (`kimi login`), never an env-carried key.
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
    delete env.MOONSHOT_API_KEY;
    delete env.KIMI_API_KEY;

    return env;
  }

  /**
   * Workspace-trust gate before initiating a turn. Kimi's ACP transport asks
   * per tool (`session/request_permission`), so a trusted workspace is allowed
   * in any permission mode -- the trust check is the gate, not the mode.
   */
  private async requestKimiTurnPermission(
    workspacePath: string,
    permissionsPath?: string
  ): Promise<{ decision: 'allow' | 'deny'; reason?: string; permissionMode?: PermissionMode }> {
    const pathForTrust = permissionsPath || workspacePath;

    if (pathForTrust && BaseAgentProvider.trustChecker) {
      const trustStatus = BaseAgentProvider.trustChecker(pathForTrust);

      if (!trustStatus.trusted) {
        this.logSecurity('[KimiCodeProvider] Workspace not trusted, denying Kimi Code turn', {
          workspacePath: pathForTrust,
        });
        return {
          decision: 'deny',
          reason: 'Workspace is not trusted. Please trust this workspace to use Kimi Code.',
        };
      }

      return { decision: 'allow', permissionMode: trustStatus.mode };
    }

    return { decision: 'allow' };
  }

  private async processTranscriptMessages(sessionId: string): Promise<void> {
    try {
      if (TranscriptMigrationRepository.hasService()) {
        await TranscriptMigrationRepository.getService().processNewMessages(
          sessionId,
          this.getProviderName(),
        );
      }
    } catch {
      // Best effort -- the session reload will catch up via ensureUpToDate
    }
  }

  private async storeAssistantResponse(sessionId: string, text: string): Promise<void> {
    const codexCompatibleEvent = {
      type: 'item.completed',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    };
    try {
      await this.logAgentMessage(
        sessionId,
        this.getProviderName(),
        'output',
        JSON.stringify(codexCompatibleEvent),
        { eventType: 'item.completed', kimiProvider: true },
        false,
        undefined,
        true
      );
    } catch {
      // Best effort
    }
  }

  private async storeRawEventIfPresent(event: ProtocolEvent, sessionId: string): Promise<void> {
    if (event.type !== 'raw_event' || !event.metadata?.rawEvent) {
      return;
    }

    const { content, usedFallback } = safeJSONSerialize(event.metadata.rawEvent);
    const rawEventType = this.getRawEventType(event.metadata.rawEvent);

    await this.logAgentMessage(
      sessionId,
      this.getProviderName(),
      'output',
      usedFallback
        ? JSON.stringify({ type: rawEventType, valueType: typeof event.metadata.rawEvent, fallback: true })
        : content,
      {
        eventType: rawEventType,
        kimiProvider: true,
        rawEventSerializationFallback: usedFallback,
      },
      false,
      undefined,
      false
    );
  }

  private getRawEventType(rawEvent: unknown): string {
    if (rawEvent && typeof rawEvent === 'object') {
      const method = (rawEvent as Record<string, unknown>).method;
      if (typeof method === 'string' && method.trim().length > 0) {
        return method;
      }
      const type = (rawEvent as Record<string, unknown>).type;
      if (typeof type === 'string' && type.trim().length > 0) {
        return type;
      }
    }
    return 'unknown';
  }
}
