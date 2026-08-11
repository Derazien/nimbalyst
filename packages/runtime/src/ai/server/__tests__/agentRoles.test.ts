// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  COMPANION_ROLES,
  isCompanionHead,
  isCompanionRole,
  isSubCompanion,
} from '../agentRoles';

describe('agent role predicates', () => {
  it('treats companion and sub-companion as companion roles', () => {
    expect(isCompanionRole('companion')).toBe(true);
    expect(isCompanionRole('sub-companion')).toBe(true);
  });

  it('leaves standard and meta-agent alone', () => {
    expect(isCompanionRole('standard')).toBe(false);
    expect(isCompanionRole('meta-agent')).toBe(false);
  });

  it('treats a missing role as standard, never as companion', () => {
    expect(isCompanionRole(undefined)).toBe(false);
    expect(isCompanionRole(null)).toBe(false);
  });

  it('separates the head from its assistants', () => {
    expect(isCompanionHead('companion')).toBe(true);
    expect(isCompanionHead('sub-companion')).toBe(false);
    expect(isSubCompanion('sub-companion')).toBe(true);
    expect(isSubCompanion('companion')).toBe(false);
  });

  it('exposes the set for callers that need to enumerate', () => {
    expect([...COMPANION_ROLES].sort()).toEqual(['companion', 'sub-companion']);
  });
});
