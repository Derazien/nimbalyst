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

  it('allows classifying a pre-taxonomy standard session into the companion family (the Looc QA case)', () => {
    // The Looc QA resident sat at 'standard' since before 'sub-companion'
    // existed. It was never promoted and then demoted, so reclassifying it
    // now is an initial classification, not a reversed promotion, and must
    // be allowed. The one-way promotion ratchet lives in the promotion flow
    // itself, not in this validator.
    const result = validateAgentRoleTransition('standard', 'sub-companion');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.role).toBe('sub-companion');
    }
  });

  it('allows a standard session to be reassigned standard (no-op transition)', () => {
    const result = validateAgentRoleTransition('standard', 'standard');

    expect(result.ok).toBe(true);
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
