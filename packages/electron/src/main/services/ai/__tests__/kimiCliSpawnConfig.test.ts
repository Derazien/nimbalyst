// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildKimiCliSpawnConfig, kimiCliModelArg } from '../kimiCliSpawnConfig';

describe('kimiCliModelArg', () => {
  it('spells every Nimbalyst form of a Kimi model the way kimi -m accepts it', () => {
    // kimi 0.43.1 rejects a bare alias: `Model "k3-256k" is not configured in config.toml`.
    expect(kimiCliModelArg('kimi-code-cli:k3-256k')).toBe('kimi-code/k3-256k');
    expect(kimiCliModelArg('kimi-code:k3')).toBe('kimi-code/k3');
    expect(kimiCliModelArg('kimi-for-coding')).toBe('kimi-code/kimi-for-coding');
    expect(kimiCliModelArg('kimi-code/k3')).toBe('kimi-code/k3');
    expect(kimiCliModelArg('claude-code-cli:opus')).toBeUndefined();
    expect(kimiCliModelArg(undefined)).toBeUndefined();
    expect(kimiCliModelArg('')).toBeUndefined();
  });
});

describe('buildKimiCliSpawnConfig', () => {
  it('runs an npm shim through node, resumes, picks the model, and never passes an API key', () => {
    const config = buildKimiCliSpawnConfig({
      launch: { command: 'C:/node/node.exe', prefixArgs: ['C:/npm/kimi/main.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } },
      baseEnv: { PATH: 'C:/bin', KIMI_API_KEY: 'sk-x', MOONSHOT_API_KEY: 'sk-y', ANTHROPIC_API_KEY: 'sk-z' },
      model: 'kimi-code-cli:k3',
      resumeKimiSessionId: 'session_abc',
      yolo: true,
      additionalDirectories: ['C:/attachments'],
    });
    expect(config.executable).toBe('C:/node/node.exe');
    expect(config.args).toEqual([
      'C:/npm/kimi/main.mjs',
      '-S', 'session_abc',
      '-m', 'kimi-code/k3',
      '--yolo',
      '--add-dir', 'C:/attachments',
    ]);
    expect(config.env).toEqual({ PATH: 'C:/bin', ELECTRON_RUN_AS_NODE: '1' });
  });

  it('starts a fresh session with no resume flag and asks for approvals by default', () => {
    const config = buildKimiCliSpawnConfig({
      launch: { command: 'C:/kimi/kimi.exe', prefixArgs: [], env: {} },
      baseEnv: {},
    });
    expect(config).toEqual({ executable: 'C:/kimi/kimi.exe', args: [], env: {} });
  });
});
