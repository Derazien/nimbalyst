import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findRuntimeHostViolations,
  collectRuntimeHostImports,
} from '../check-runtime-host-boundary.mjs';

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../check-runtime-host-boundary.mjs',
);

test('catches both host escapes that actually happened', () => {
  const violations = findRuntimeHostViolations([
    // The eight call sites that read app.isPackaged / app.getAppPath.
    { file: 'packages/runtime/src/electron/claudeCodeEnvironment.ts', specifier: 'electron', resolved: 'electron' },
    // ClaudeCodeProvider's relative path out of the package, resolved as the
    // gate resolves it. This one pulled ~51 desktop-app files into the graph.
    {
      file: 'packages/runtime/src/ai/server/providers/ClaudeCodeProvider.ts',
      specifier: '../../../../../electron/src/main/HistoryManager',
      resolved: path.join('/repo', 'packages', 'electron', 'src', 'main', 'HistoryManager'),
    },
  ]);

  assert.deepEqual(violations.map(({ name }) => name), ['electron', 'packages/electron']);
});

test('does not fire on the runtime paths that merely look host-shaped', () => {
  const violations = findRuntimeHostViolations([
    // The module kept at src/electron/ for its mock specifier; it is runtime's
    // own file, not the desktop package.
    {
      file: 'packages/runtime/src/ai/server/providers/claudeCode/cliPathResolver.ts',
      specifier: '../../../../electron/claudeCodeEnvironment',
      resolved: path.join('/repo', 'packages', 'runtime', 'src', 'electron', 'claudeCodeEnvironment'),
    },
    { file: 'x.ts', specifier: 'electron-store', resolved: 'electron-store' },
  ]);

  assert.deepEqual(violations, []);
});

test('runtime source currently satisfies the boundary', () => {
  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^\[runtime-host-boundary\] runtime source clean \(\d+ imports scanned\)\.$/m);
});

test('scans a non-trivial number of real imports, so a silent no-op is visible', () => {
  assert.ok(collectRuntimeHostImports().length > 1000);
});
