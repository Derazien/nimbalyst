// @vitest-environment node
/**
 * The ExitPlanMode mode of resources/claudeCliPermissionHook.cjs. Contract proven live on CLI
 * 2.1.295: a PreToolUse `allow` skips the plan dialog, so approve/deny must map to those exact
 * outputs, and every failure must print NOTHING (so the CLI shows its own dialog).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const scriptPath = path.resolve(__dirname, '../../../../../resources/claudeCliPermissionHook.cjs');
const hook = require_(scriptPath) as {
  buildExitPlanPayload: (input: unknown) => Record<string, unknown> | null;
  mapExitPlanAnswer: (answer: unknown, toolInput: unknown) => Record<string, unknown> | null;
  resolveExitPlanEndpoint: (env: Record<string, string | undefined>) => string;
};

describe('exit-plan-mode hook: pure mapping', () => {
  it('turns the CLI stdin into the POST body, or null without a session', () => {
    const body = hook.buildExitPlanPayload({
      session_id: 'sess',
      tool_use_id: 'toolu_1',
      permission_mode: 'plan',
      tool_input: { plan: 'p', planFilePath: 'f.md' },
    });
    expect(body).toEqual({
      sessionId: 'sess',
      toolUseId: 'toolu_1',
      permissionMode: 'plan',
      toolInput: { plan: 'p', planFilePath: 'f.md' },
    });
    expect(hook.buildExitPlanPayload({ tool_input: {} })).toBeNull();
  });

  it('approve -> PreToolUse allow echoing the tool input unchanged', () => {
    const input = { plan: 'p', planFilePath: 'f.md' };
    expect(hook.mapExitPlanAnswer({ decision: 'approve' }, input)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: input },
    });
  });

  it('deny -> PreToolUse deny whose reason carries the feedback and tells the agent to keep planning', () => {
    const out = hook.mapExitPlanAnswer({ decision: 'deny', feedback: 'use sqlite' }, {}) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('Continue planning');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('use sqlite');
    const bare = hook.mapExitPlanAnswer({ decision: 'deny' }, {}) as typeof out;
    expect(bare.hookSpecificOutput.permissionDecisionReason).not.toContain('feedback');
  });

  it('ask, garbage and missing answers map to no output', () => {
    expect(hook.mapExitPlanAnswer({ decision: 'ask' }, {})).toBeNull();
    expect(hook.mapExitPlanAnswer({ decision: 'maybe' }, {})).toBeNull();
    expect(hook.mapExitPlanAnswer(undefined, {})).toBeNull();
  });

  it('derives the endpoint from the permission URL unless one is given', () => {
    expect(hook.resolveExitPlanEndpoint({ NIMBALYST_PERMISSION_URL: 'http://127.0.0.1:5123/permission' })).toBe(
      'http://127.0.0.1:5123/exit-plan-mode',
    );
    expect(hook.resolveExitPlanEndpoint({ NIMBALYST_EXIT_PLAN_URL: 'http://x/y' })).toBe('http://x/y');
    expect(hook.resolveExitPlanEndpoint({})).toBe('');
  });
});

describe('exit-plan-mode hook: as the CLI runs it', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.closeAllConnections?.();
    server?.close();
    server = undefined;
  });

  async function run(
    respond: ((url: string, auth: string | undefined, body: string, res: import('node:http').ServerResponse) => void) | null,
    extraEnv: Record<string, string> = {},
  ) {
    const seen: { url?: string; auth?: string; body?: string } = {};
    let port = 1; // nothing listens on port 1: connection refused
    if (respond) {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          seen.url = req.url;
          seen.auth = req.headers.authorization;
          seen.body = body;
          respond(req.url ?? '', req.headers.authorization, body, res);
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      port = (server.address() as { port: number }).port;
    }
    const stdin = JSON.stringify({
      session_id: 'sess-1',
      tool_use_id: 'toolu_9',
      permission_mode: 'plan',
      tool_input: { plan: 'do it', planFilePath: 'p.md' },
    });
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = execFile(
        process.execPath,
        [scriptPath, 'exit-plan-mode'],
        {
          env: {
            ...process.env,
            NIMBALYST_PERMISSION_URL: `http://127.0.0.1:${port}/permission`,
            NIMBALYST_PERMISSION_TOKEN: 'tok',
            ...extraEnv,
          },
          timeout: 20000,
        },
        (err, stdout) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout }),
      );
      child.stdin!.end(stdin);
    });
    return { ...result, seen };
  }

  it('POSTs the session to /exit-plan-mode with the bearer and prints the allow output on approve', async () => {
    const r = await run((_u, _a, _b, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ decision: 'approve' }));
    });
    expect(r.seen.url).toBe('/exit-plan-mode');
    expect(r.seen.auth).toBe('Bearer tok');
    expect(JSON.parse(r.seen.body!)).toMatchObject({ sessionId: 'sess-1', toolUseId: 'toolu_9', permissionMode: 'plan' });
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { plan: 'do it', planFilePath: 'p.md' },
      },
    });
    expect(r.code).toBe(0);
  });

  it('prints the deny output with the feedback', async () => {
    const r = await run((_u, _a, _b, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ decision: 'deny', feedback: 'shorter' }));
    });
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(r.stdout).toContain('shorter');
  });

  it.each([
    ['an ask answer', (res: import('node:http').ServerResponse) => { res.writeHead(200); res.end('{"decision":"ask"}'); }],
    ['a server error', (res: import('node:http').ServerResponse) => { res.writeHead(500); res.end('boom'); }],
    ['a body that is not JSON', (res: import('node:http').ServerResponse) => { res.writeHead(200); res.end('nope'); }],
  ])('prints nothing and exits 0 on %s', async (_name, reply) => {
    const r = await run((_u, _a, _b, res) => reply(res));
    expect(r.stdout).toBe('');
    expect(r.code).toBe(0);
  });

  it('prints nothing when Nimbalyst is unreachable', async () => {
    const r = await run(null);
    expect(r.stdout).toBe('');
    expect(r.code).toBe(0);
  });

  it('prints nothing when Nimbalyst never answers within the request timeout', async () => {
    const r = await run(() => {}, { NIMBALYST_EXIT_PLAN_TIMEOUT_MS: '300' });
    expect(r.stdout).toBe('');
    expect(r.code).toBe(0);
  });
});
