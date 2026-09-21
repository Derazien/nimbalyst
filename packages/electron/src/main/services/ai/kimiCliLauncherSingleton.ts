/**
 * Production wiring for Kimi Code CLI (`kimi-code-cli`): the genuine `kimi`
 * terminal app in a Nimbalyst session, on the same rails as Claude Code CLI
 * mode (same PTY terminal and drawer, same queue flush, same Stop escalation,
 * same submit core). The Kimi-specific parts are the session runtime (event
 * log -> turn state + transcript rows) and the launch command line.
 *
 * Design and verified kimi behaviour: nimbalyst-local/kimi-code-cli-design-2026-09-19.md
 */

import { existsSync, mkdirSync } from 'fs';
import { AgentMessagesRepository } from '@nimbalyst/runtime';
import { KimiCodeProvider } from '@nimbalyst/runtime/ai/server/providers/KimiCodeProvider';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { TranscriptMigrationRepository } from '@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository';
import { claimExternalSessionForLocalExecution } from '../externalSessions/ExternalSessionService';
import { getMcpConfigService } from '@nimbalyst/runtime/ai/server/services/mcpServerConfig';
import { toKimiSpawnableCommand } from '@nimbalyst/runtime/ai/server/providers/kimiMcpCommand';
import { resolveEffortLevel, resolveKimiEffortLevels } from '@nimbalyst/runtime/ai/server/effortLevels';
import { getDefaultEffortLevel } from '../../utils/store';
import { getTerminalSessionManager } from '../TerminalSessionManager';
import { getEnhancedPath, getShellEnvironment } from '../shellEnvironment';
import { getPermissionService } from '../PermissionService';
import { resolveAttachmentStagingAllowDirectories } from '../attachments/attachmentStagingRoot';
import { HooklessAgentFileWatcher } from './HooklessAgentFileWatcher';
import { resolveClaudeCliWorktreeCwd } from './resolveClaudeCliWorktreeCwd';
import { flushNextClaudeCliQueuedPromptForSession } from './claudeCliQueueFlushSingleton';
import { claudeCliSubmitLatch } from './claudeCliSubmitLatch';
import { broadcastClaudeCliRevealTerminal } from './claudeCliRevealTerminal';
import { broadcastMessageLogged } from './claudeCliUserPromptLog';
import { maybeAutoNameClaudeCliSessionProduction } from './claudeCliSessionAutoNameSingleton';
import { buildKimiCliSpawnConfig, kimiCliModelArg } from './kimiCliSpawnConfig';
import { findKimiSessionDir, kimiSessionIndexPath } from './kimiCliSessionFiles';
import { KimiCliSessionRuntime, type KimiCliRow } from './kimiCliSessionRuntime';
import { switchKimiCliModel } from './kimiCliModelSwitch';
import { switchKimiCliEffort, type SwitchKimiCliEffortResult } from './kimiCliEffortSwitch';
import { resolveClaudeCliEffort } from './claudeCliEffort';
import { kimiCliRuntimes, typeIntoKimiCliTerminal } from './kimiCliRuntimes';
import { KimiCliMcpConfigService, type PreparedKimiCliMcp } from './kimiCliMcpConfig';
import { resolveKimiCliMcpLauncher } from './kimiCliMcpLauncherPath';
import type { EnsureClaudeCliSessionInput, EnsureClaudeCliSessionResult } from './claudeCliLauncherSingleton';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type McpConfigLoader = (workspacePath?: string) => Promise<Record<string, any>>;
const launcherConfig: { mcpConfigLoader: McpConfigLoader | null } = { mcpConfigLoader: null };

/** Static setters, wired from `index.ts` beside the `kimi-code` provider's. */
export const KimiCliLauncherConfig = {
  setMcpConfigLoader: (loader: McpConfigLoader | null) => { launcherConfig.mcpConfigLoader = loader; },
};

const mcpConfig = new KimiCliMcpConfigService({
  launcher: () => resolveKimiCliMcpLauncher(getEnhancedPath()),
  // The same PATH kimi itself is started with, so `npx.cmd` resolves the same way in both lanes.
  toSpawnable: (command, args) => toKimiSpawnableCommand(command, args, { pathValue: getEnhancedPath() }),
});

/**
 * The servers the ACP `kimi-code` provider would hand this session (Nimbalyst's
 * own plus the user's from app and project settings), made reachable for the
 * terminal kimi. Never throws: kimi without MCP beats no kimi.
 */
async function prepareMcp(sessionId: string, workspacePath: string): Promise<PreparedKimiCliMcp | null> {
  try {
    const servers = await getMcpConfigService({
      mcpConfigLoader: launcherConfig.mcpConfigLoader,
      claudeSettingsEnvLoader: null,
      shellEnvironmentLoader: () => getShellEnvironment(),
    }).getMcpServersConfig({ sessionId, workspacePath });
    const prepared = await mcpConfig.prepare(sessionId, servers);
    if (prepared?.skipped.length) {
      console.log(`[KimiCliLauncher] kept the user's own kimi MCP servers named: ${prepared.skipped.join(', ')}`);
    }
    return prepared;
  } catch (error) {
    console.warn('[KimiCliLauncher] could not load MCP servers; kimi starts without them:', error);
    return null;
  }
}

const runtimes = kimiCliRuntimes;
const launchInFlight = new Map<string, Promise<EnsureClaudeCliSessionResult>>();
/** Row writes per session, kept in kimi's order. */
const rowWrites = new Map<string, Promise<void>>();
const fileWatcher = new HooklessAgentFileWatcher();

/** A kimi session another live Nimbalyst session already follows. */
function isClaimedElsewhere(sessionId: string, kimiSessionId: string): boolean {
  for (const [id, runtime] of runtimes) {
    if (id !== sessionId && runtime.kimiSessionId === kimiSessionId) return true;
  }
  return false;
}

export function isKimiCliInstalled(): boolean {
  return KimiCodeProvider.isKimiInstalled();
}

function writeRow(sessionId: string, workspacePath: string, row: KimiCliRow): void {
  const previous = rowWrites.get(sessionId) ?? Promise.resolve();
  const next = previous.then(async () => {
    try {
      await AgentMessagesRepository.create({
        sessionId,
        source: 'kimi-code-cli',
        direction: row.direction,
        content: row.content,
        hidden: false,
        createdAt: row.createdAt,
        ...(row.metadata ? { metadata: row.metadata } : {}),
      });
      if (TranscriptMigrationRepository.hasService()) {
        await TranscriptMigrationRepository.getService().processNewMessages(sessionId, 'kimi-code-cli');
      }
      broadcastMessageLogged(sessionId, workspacePath);
    } catch (error) {
      console.warn('[KimiCliLauncher] failed to store a transcript row:', error);
    }
  });
  rowWrites.set(sessionId, next);
}

function attachmentDirs(workspacePath: string): string[] | undefined {
  try {
    const dirs = resolveAttachmentStagingAllowDirectories(workspacePath);
    for (const dir of dirs) mkdirSync(dir, { recursive: true });
    return dirs;
  } catch (error) {
    console.warn('[KimiCliLauncher] could not prepare the attachments folder:', error);
    return undefined;
  }
}

/**
 * Idempotently ensure the genuine `kimi` is running for this session: resume
 * its kimi session when one is stored, otherwise start fresh and adopt the
 * session kimi creates on the first prompt.
 */
export async function ensureKimiCliSession(
  input: EnsureClaudeCliSessionInput,
): Promise<EnsureClaudeCliSessionResult> {
  await claimExternalSessionForLocalExecution(input.sessionId);
  const manager = getTerminalSessionManager();
  if (manager.isTerminalActive(input.sessionId)) {
    return { success: true, alreadyActive: true };
  }
  const existing = launchInFlight.get(input.sessionId);
  if (existing) return existing;

  const stateManager = getSessionStateManager();
  const launch = (async (): Promise<EnsureClaudeCliSessionResult> => {
    try {
      const kimiLaunch = KimiCodeProvider.resolveKimiLaunchForRuntime(getEnhancedPath());
      if (!kimiLaunch || !isKimiCliInstalled()) {
        return { success: false, error: 'Kimi Code CLI is not installed' };
      }

      const session = await AISessionsRepository.get(input.sessionId);
      const cwd = (await resolveClaudeCliWorktreeCwd(input.sessionId, input.cwd, {
        getSessionWorktreeId: async () => session?.worktreeId ?? null,
        getWorktreePath: async (worktreeId) => {
          const { createWorktreeStore } = await import('../WorktreeStore');
          const { getDatabase } = await import('../../database/initialize');
          const db = getDatabase();
          const worktree = db ? await createWorktreeStore(db).get(worktreeId) : null;
          return worktree?.path ?? null;
        },
        logWarn: (message, err) => console.warn(message, err),
      })) ?? input.workspacePath;

      // A stored kimi session resumes; one kimi no longer has starts fresh.
      const storedKimiId = session?.providerSessionId;
      const sessionDir = storedKimiId ? findKimiSessionDir(kimiSessionIndexPath(), storedKimiId) : null;
      const resume = storedKimiId && sessionDir && existsSync(sessionDir)
        ? { kimiSessionId: storedKimiId, sessionDir }
        : undefined;

      const model = input.model ?? session?.model ?? undefined;
      const permissionMode = getPermissionService().getPermissionMode(input.workspacePath);
      const mcp = await prepareMcp(input.sessionId, input.workspacePath);
      // Resolved now so the first idle below can queue it without awaiting,
      // which is what keeps it ahead of the first prompt.
      const launchEffort = await resolveLaunchEffort(input);
      let launchEffortQueued = false;
      const spawnConfig = buildKimiCliSpawnConfig({
        launch: kimiLaunch,
        baseEnv: KimiCodeProvider.buildKimiEnvironment() ?? { ...process.env },
        model,
        resumeKimiSessionId: resume?.kimiSessionId,
        yolo: permissionMode === 'allow-all' || permissionMode === 'bypass-all',
        additionalDirectories: attachmentDirs(input.workspacePath),
        extraEnv: mcp?.env,
      });

      await stateManager.startSession({
        sessionId: input.sessionId,
        workspacePath: input.workspacePath,
        initialStatus: 'running',
      });

      const reveal = () => broadcastClaudeCliRevealTerminal({ sessionId: input.sessionId, interactive: true, source: 'output' });
      const runtime = new KimiCliSessionRuntime({
        workDir: cwd,
        indexPath: kimiSessionIndexPath(),
        resume,
        launchModel: kimiCliModelArg(model),
        isClaimed: (kimiSessionId) => isClaimedElsewhere(input.sessionId, kimiSessionId),
        onKimiSessionId: (kimiSessionId) => {
          void AISessionsRepository.updateMetadata(input.sessionId, { providerSessionId: kimiSessionId })
            .catch((error) => console.warn('[KimiCliLauncher] could not store the kimi session id:', error));
        },
        onRow: (row) => writeRow(input.sessionId, input.workspacePath, row),
        onNeedsAttention: reveal,
        onTurnState: (state) => {
          if (state !== 'idle') claudeCliSubmitLatch.clear(input.sessionId);
          if (state === 'idle') {
            void stateManager.updateActivity({ sessionId: input.sessionId, status: 'idle', isStreaming: false });
            fileWatcher.scheduleStop(input.sessionId, 500);
            void maybeAutoNameClaudeCliSessionProduction(input.sessionId);
            // kimi takes no effort on its command line, so the first time its
            // prompt box is up the selection goes in through its picker. Typing
            // is queued per session, and this is queued before the flush below,
            // so the first prompt waits for it.
            // The same goes for a level picked while a turn was running.
            const effort = effortsWaitingForIdle.get(input.sessionId) ?? (launchEffortQueued ? undefined : launchEffort);
            launchEffortQueued = true;
            effortsWaitingForIdle.delete(input.sessionId);
            if (effort) {
              void setKimiCliSessionEffort(input.sessionId, effort).then((result) => {
                // A model with no levels is left alone on purpose; only a real miss is worth a line.
                if (!result.switched && resolveKimiEffortLevels(runtime.getModel() ?? undefined)?.length) {
                  console.warn(`[KimiCliLauncher] kimi stayed on "${runtime.getThinkingEffort()}" thinking instead of "${effort}"`);
                }
              }).catch((error) => console.warn('[KimiCliLauncher] could not apply the effort:', error));
            }
            void flushNextClaudeCliQueuedPromptForSession(input.sessionId, input.workspacePath);
          } else if (state === 'running') {
            void stateManager.updateActivity({ sessionId: input.sessionId, status: 'running', isStreaming: true });
            void fileWatcher.ensureForSession(input.sessionId, cwd)
              .catch((err) => console.warn('[KimiCliLauncher] file watcher start failed:', err));
          } else {
            // kimi is asking for an approval in its own terminal.
            void stateManager.updateActivity({ sessionId: input.sessionId, status: 'waiting_for_input', isStreaming: false });
            reveal();
          }
        },
      });
      runtimes.set(input.sessionId, runtime);

      await manager.createClaudeCliTerminal(input.sessionId, {
        cwd,
        spawnConfig,
        workspacePath: input.workspacePath,
        cols: input.cols,
        rows: input.rows,
        provider: 'kimi-code-cli',
        readTurnState: () => runtime.getTurnState(),
        onOutput: (data) => runtime.noteTerminalOutput(data),
        onExit: (exitCode) => {
          console.log(`[KimiCliLauncher] kimi exited for ${input.sessionId} with code ${exitCode}`);
          runtime.poll();
          runtime.stop();
          // A relaunch may already own this session id; leave it alone.
          if (runtimes.get(input.sessionId) !== runtime) return;
          runtimes.delete(input.sessionId);
          effortsWaitingForIdle.delete(input.sessionId);
          void mcpConfig.release(input.sessionId);
          void fileWatcher.stopForSession(input.sessionId).catch(() => {});
          void stateManager.endSession(input.sessionId).catch(() => {});
        },
      });
      runtime.start();
      return { success: true };
    } catch (error) {
      console.error('[KimiCliLauncher] Failed to ensure session:', error);
      runtimes.get(input.sessionId)?.stop();
      runtimes.delete(input.sessionId);
      void mcpConfig.release(input.sessionId);
      void stateManager.endSession(input.sessionId).catch(() => {});
      return { success: false, error: String(error) };
    } finally {
      launchInFlight.delete(input.sessionId);
    }
  })();

  launchInFlight.set(input.sessionId, launch);
  return launch;
}

/** Switch a running Kimi Code CLI session's model, for that session only. */
export async function setKimiCliSessionModel(sessionId: string, model: string): Promise<{ switched: boolean; cliArg?: string }> {
  const runtime = runtimes.get(sessionId);
  if (!runtime) return { switched: false };
  const manager = getTerminalSessionManager();
  return typeIntoKimiCliTerminal(sessionId, () => switchKimiCliModel({ model }, {
    write: (data) => manager.writeToTerminal(sessionId, data),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    currentModel: () => runtime.getModel(),
  }));
}

/** Efforts picked while kimi was busy, applied the next time it is idle. */
const effortsWaitingForIdle = new Map<string, string>();

/**
 * Put the composer's effort on a running Kimi Code CLI session, for that
 * session only. While a turn runs nothing is typed: the picker would not open,
 * and the Esc that backs out of it is what stops a turn in kimi. The level is
 * kept and goes in when the turn ends, ahead of the next prompt.
 */
export async function setKimiCliSessionEffort(sessionId: string, effort: string): Promise<SwitchKimiCliEffortResult> {
  const runtime = runtimes.get(sessionId);
  if (!runtime) return { switched: false };
  if (runtime.getTurnState() !== 'idle') {
    effortsWaitingForIdle.set(sessionId, effort);
    return { switched: true, effort };
  }
  const manager = getTerminalSessionManager();
  return typeIntoKimiCliTerminal(sessionId, () => switchKimiCliEffort({ effort, model: runtime.getModel() }, {
    write: (data) => manager.writeToTerminal(sessionId, data),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    currentEffort: () => runtime.getThinkingEffort(),
    pickerLevels: () => runtime.getEffortPickerLevels(),
  }));
}

/**
 * The effort this session should run at: what the launch was given, else the
 * session's own selection, else the app default the selector shows. Undefined
 * leaves kimi on its own default.
 */
async function resolveLaunchEffort(input: EnsureClaudeCliSessionInput): Promise<string | undefined> {
  return resolveClaudeCliEffort(
    { explicit: input.effortLevel, sessionId: input.sessionId },
    {
      getSessionEffortLevel: async (sessionId) =>
        ((await AISessionsRepository.get(sessionId))?.metadata as { effortLevel?: string } | undefined)?.effortLevel,
      getDefaultEffortLevel,
      resolveEffortLevel,
      logWarn: (message, err) => console.warn(message, err),
    },
  );
}
