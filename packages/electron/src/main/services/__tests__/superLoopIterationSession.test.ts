// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { superLoopIterationSessionRow } from '../superLoopIterationSession';

describe('superLoopIterationSessionRow', () => {
  it('starts a Claude CLI iteration ready to work, not in plan mode', () => {
    const row = superLoopIterationSessionRow({
      sessionId: 's1', model: 'claude-code-cli:opus', phaseLabel: 'Build', iterationNumber: 3,
      workspaceId: '/w', worktreePath: '/w/wt', worktreeId: 'wt1',
    });
    expect(row.provider).toBe('claude-code-cli');
    expect(row.metadata).toEqual({ startInPlanMode: false });
  });
});
