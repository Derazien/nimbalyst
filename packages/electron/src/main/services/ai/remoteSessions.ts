import { readDeployment } from '../cloudflareSandbox/deploymentStore';
import { getAgentWorkflowService } from '../AgentWorkflowService';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { findWindowByWorkspace } from '../../window/WindowManager';
import { encryptRemoteAttachments } from './remoteAttachments';
import { RemoteSessionMirror } from './RemoteSessionMirror';
import { RemoteSessionMirrorSet } from './remoteSessionMirrorSet';

const mirrorDeps: ConstructorParameters<typeof RemoteSessionMirror>[0] = {
  localSessionIds: async workspace => new Set((await AISessionsRepository.list(workspace, {includeArchived: true})).map(s => s.id)),
  configuredHostIds: () => { const id = readDeployment()?.node?.deviceId; return new Set(id ? [id] : []); },
  encryptAttachments: encryptRemoteAttachments,
  preparePrompt: async (prompt, workspace) => {
    const invocation = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
    if (!invocation) return prompt;
    const workflow = (await getAgentWorkflowService(workspace).listEntries({provider: 'claude-code'})).find(entry => entry.name === invocation[1] && entry.content);
    if (!workflow?.content) return prompt;
    // The selected workflow is sent as encrypted prompt text, never installed
    // as ambient settings or executed on this viewing machine.
    return `Workflow /${workflow.name} (run in the remote workspace):\n\n${workflow.content.replace(/\$ARGUMENTS/g, invocation[2] ?? '')}\n\nUser arguments: ${invocation[2] ?? ''}`;
  },
  hasLocalSession: async id => !!await AISessionsRepository.get(id),
  listChanged: (workspacePath, sessionId) => {
    const window = findWindowByWorkspace(workspacePath);
    if (window && !window.isDestroyed()) window.webContents.send('sessions:refresh-list', { workspacePath, sessionId });
  },
};

/**
 * Cloud sessions (sandboxes, other desktops, cloud-joined nodes) and sessions on
 * a local headless host (#416), behind one object every handler uses. The
 * configured sandbox is a cloud host only; the local mirror learns its host
 * from the node itself.
 */
export const remoteSessions = new RemoteSessionMirrorSet(
  new RemoteSessionMirror(mirrorDeps),
  new RemoteSessionMirror({ ...mirrorDeps, configuredHostIds: () => new Set() }),
);
