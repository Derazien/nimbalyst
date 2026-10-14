/**
 * The session row a super loop iteration runs in. Iterations are machine-made,
 * so they start ready to work, never in the Claude CLI's plan mode.
 */
export function superLoopIterationSessionRow(input: {
  sessionId: string;
  model: string;
  phaseLabel: string;
  iterationNumber: number;
  workspaceId: string;
  worktreePath: string;
  worktreeId: string;
}) {
  // Model ids are "provider:model".
  const provider = input.model.includes(':') ? input.model.split(':')[0] : 'claude-code';
  return {
    id: input.sessionId,
    provider,
    model: input.model,
    title: `Super Loop ${input.phaseLabel} #${input.iterationNumber}`,
    workspaceId: input.workspaceId,
    providerConfig: { workingDirectory: input.worktreePath },
    worktreeId: input.worktreeId,
    metadata: { startInPlanMode: false },
  };
}
