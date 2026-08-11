import { describe, expect, it } from 'vitest';

import { validateAgentRoleTransition } from '../agentRoleTransition';

describe('validateAgentRoleTransition', () => {
  it('allows a companion-family session to fall back to standard', () => {
    const result = validateAgentRoleTransition('sub-companion', 'standard');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.role).toBe('standard');
    }
  });

  it('allows moving between two non-standard roles (e.g. meta-agent to companion)', () => {
    const result = validateAgentRoleTransition('meta-agent', 'companion');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.role).toBe('companion');
    }
  });

  it('rejects promoting a standard session out of standard', () => {
    const result = validateAgentRoleTransition('standard', 'sub-companion');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/standard/i);
    }
  });

  it('rejects a standard session even when the requested role is standard itself', () => {
    const result = validateAgentRoleTransition('standard', 'standard');

    expect(result.ok).toBe(false);
  });

  it('rejects a value outside the AgentRole union', () => {
    const result = validateAgentRoleTransition('meta-agent', 'super-admin');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/unknown agent role/i);
    }
  });

  it('rejects an empty string', () => {
    const result = validateAgentRoleTransition('companion', '');

    expect(result.ok).toBe(false);
  });
});
