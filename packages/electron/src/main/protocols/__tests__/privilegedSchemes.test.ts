// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

const { registerSchemesAsPrivileged } = vi.hoisted(() => ({ registerSchemesAsPrivileged: vi.fn() }));
vi.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged, handle: vi.fn() },
  app: { getPath: vi.fn() },
  net: { fetch: vi.fn() },
}));

import { registerPrivilegedSchemes } from '../privilegedSchemes';

describe('registerPrivilegedSchemes', () => {
  // Renderers only receive the secure/CORS/fetch lists of the last call, so a
  // second call silently strips every scheme registered before it.
  it('registers every custom scheme in a single call', () => {
    registerPrivilegedSchemes();
    expect(registerSchemesAsPrivileged).toHaveBeenCalledTimes(1);
    const schemes = registerSchemesAsPrivileged.mock.calls[0][0] as Electron.CustomScheme[];
    expect(schemes.map((s) => s.scheme).sort()).toEqual(['collab-asset', 'nim-asset', 'nim-extension', 'nim-preview']);
    for (const s of schemes) {
      expect(s.privileges, s.scheme).toMatchObject({ standard: true, secure: true, supportFetchAPI: true, corsEnabled: true });
    }
  });
});
