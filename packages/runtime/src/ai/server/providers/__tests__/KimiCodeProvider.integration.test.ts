// @vitest-environment node
/**
 * Live Kimi Code integration — drives the real `kimi` CLI (`kimi acp`) through
 * KimiCodeProvider end-to-end: session create, streamed text, a tool-call file
 * write with a permission round-trip, and completion.
 *
 * Gated: only runs when RUN_AI_PROVIDER_TESTS includes 'kimi' (or 'true') and
 * a `kimi` executable is reachable. Auth is the user's own `kimi login` CLI
 * session — no API keys, per repo policy.
 *
 *   RUN_AI_PROVIDER_TESTS=kimi npx vitest run packages/runtime/src/ai/server/providers/__tests__/KimiCodeProvider.integration.test.ts
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { KimiCodeProvider } from '../KimiCodeProvider';

const RUN_CONFIG = (() => {
  const raw = (process.env.RUN_AI_PROVIDER_TESTS ?? '').toLowerCase().trim();
  return ['true', '1', 'yes', 'on', '*', 'all'].includes(raw) || raw.split(',').map(s => s.trim()).includes('kimi');
})();

function findKimi(): string | undefined {
  for (const cmd of process.platform === 'win32' ? ['kimi.exe', 'kimi'] : ['kimi']) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'pipe', timeout: 5000 });
      return cmd;
    } catch {
      // try next
    }
  }
  const homeBin = path.join(os.homedir(), '.kimi-code', 'bin', process.platform === 'win32' ? 'kimi.exe' : 'kimi');
  try {
    execFileSync(homeBin, ['--version'], { stdio: 'pipe', timeout: 5000 });
    return homeBin;
  } catch {
    return undefined;
  }
}

const kimiExecutable = findKimi();

describe.runIf(RUN_CONFIG && !!kimiExecutable)('KimiCodeProvider live integration', () => {
  it(
    'streams a real turn that writes a file through the ACP permission round-trip',
    async () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-live-'));
      const probeFile = path.join(workspace, 'kimi-live-probe.txt');

      try {
        if (kimiExecutable && path.isAbsolute(kimiExecutable)) {
          KimiCodeProvider.setKimiPathLoader(() => kimiExecutable);
        }

        const provider = new KimiCodeProvider();
        await provider.initialize({ model: KimiCodeProvider.getDefaultModel() } as any);

        const chunks: any[] = [];
        for await (const chunk of provider.sendMessage(
          "Create a file named kimi-live-probe.txt containing exactly 'kimi live ok', then reply with the single word: done",
          undefined,
          'kimi-live-test',
          [],
          workspace
        )) {
          chunks.push(chunk);
          if (chunk.type === 'complete' || chunk.type === 'error') break;
        }

        const errorChunk = chunks.find((c) => c.type === 'error');
        expect(errorChunk, `provider error: ${errorChunk?.error}`).toBeUndefined();

        const text = chunks.filter((c) => c.type === 'text').map((c) => c.content ?? '').join('');
        expect(text.length).toBeGreaterThan(0);
        expect(chunks.some((c) => c.type === 'complete')).toBe(true);

        // The Write card must carry kimi's late-arriving arguments with an
        // absolute path inside the workspace, or file tracking and the diff
        // view get nothing (kimi's own rawInput path is cwd-relative).
        const writeCall = chunks.find(
          (c) => c.type === 'tool_call' && c.toolCall?.name === 'Write' && c.toolCall?.arguments
        );
        expect(writeCall, 'a Write card with arguments').toBeDefined();
        const writePath = String(writeCall.toolCall.arguments.path ?? writeCall.toolCall.arguments.file_path);
        expect(path.isAbsolute(writePath)).toBe(true);
        expect(path.resolve(writePath)).toBe(path.resolve(probeFile));

        expect(fs.existsSync(probeFile), 'probe file should be written by the agent').toBe(true);
        expect(fs.readFileSync(probeFile, 'utf8')).toContain('kimi live ok');
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    },
    180_000
  );
});
