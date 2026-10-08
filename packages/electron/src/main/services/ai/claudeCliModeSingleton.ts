/**
 * Production wiring for `ClaudeCliModeTracker`: persists the live CLI permission
 * mode into session metadata and tells the renderer to reload the session, the same
 * way the todo capture does (`claudeCliObservationSingleton.ts`).
 *
 * `AISessionsRepository.updateMetadata` shallow-merges the `metadata` blob, so
 * sibling keys (todos, effort, status) are never clobbered. The session `mode`
 * column follows the plan flag so the renderer's plan/agent state tracks the CLI.
 */

import { AISessionsRepository } from '@nimbalyst/runtime';
import { broadcastMessageLogged as notifyMessageLogged } from './claudeCliUserPromptLog';
import { ClaudeCliModeTracker } from './claudeCliModeTracker';

let tracker: ClaudeCliModeTracker | null = null;

export function getClaudeCliModeTracker(): ClaudeCliModeTracker {
  tracker ??= new ClaudeCliModeTracker({
    persist: async (sessionId, workspacePath, patch) => {
      await AISessionsRepository.updateMetadata(sessionId, {
        ...(patch.cliPermissionMode
          ? { mode: patch.cliPermissionMode === 'plan' ? 'planning' : 'agent' }
          : {}),
        metadata: {
          ...(patch.cliPermissionMode ? { cliPermissionMode: patch.cliPermissionMode } : {}),
          ...(patch.cliBypassAvailable !== undefined ? { cliBypassAvailable: patch.cliBypassAvailable } : {}),
        },
      });
      notifyMessageLogged(sessionId, workspacePath);
    },
  });
  return tracker;
}
