#!/usr/bin/env node
/**
 * Claude Code `PreToolUse` hook for the genuine `claude-code-cli` path
 * (NIM-806 Phase 4, Direction A — the interactive-mode-compatible mechanism).
 *
 * `--permission-prompt-tool` is silently ignored by the interactive CLI (verified
 * live, 2.1.168 — the native TUI prompt still showed). A `PreToolUse` hook,
 * however, IS honored interactively: returning `permissionDecision: "allow"|"deny"`
 * suppresses the native prompt (only `defer` is print-mode-only). So Nimbalyst
 * registers this hook via `--settings` and routes the decision to a GUI widget.
 *
 * Flow: the CLI runs this command before a matched tool (Bash/Edit/Write/…),
 * passing the tool call as JSON on stdin. We POST it to Nimbalyst's local
 * `/permission` endpoint (same loopback server + bearer as the MCP server), which
 * renders the ToolPermission widget and blocks until the user answers, then
 * returns `{decision}`. We translate that to the hook's permission contract.
 *
 * Zero dependencies (CommonJS, plain `http`) so it runs under any Node-compatible
 * runtime, including Electron-as-Node (`ELECTRON_RUN_AS_NODE=1 <electron> <this>`).
 *
 * FAIL-SAFE: on ANY error (no endpoint, bad response, timeout) we emit
 * `permissionDecision: "ask"` and exit 0 — the CLI then falls back to its native
 * prompt. We never hard-block the user and never exit non-zero (a non-zero exit
 * is itself a blocking signal to the CLI).
 */

'use strict';

const http = require('http');
const https = require('https');

const ENDPOINT = process.env.NIMBALYST_PERMISSION_URL || '';
const TOKEN = process.env.NIMBALYST_PERMISSION_TOKEN || '';
// Stay just under the CLI's hook timeout so we lose the race to the CLI, not the
// other way around (a clean "ask" fallback beats an ambiguous kill).
const REQUEST_TIMEOUT_MS = Number(process.env.NIMBALYST_PERMISSION_TIMEOUT_MS || 590000);

/** Emit the hook decision and exit. `reason` is optional, shown by the CLI. */
function emit(decision, reason) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision, // 'allow' | 'deny' | 'ask'
      ...(reason ? { permissionDecisionReason: reason } : {}),
    },
  };
  try {
    process.stdout.write(JSON.stringify(out));
  } catch {
    // ignore
  }
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    // Guard against a stdin that never closes.
    setTimeout(() => resolve(data), 5000);
  });
}

function postPermission(payload, endpoint = ENDPOINT, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(endpoint);
    } catch (e) {
      reject(new Error('bad endpoint url'));
      return;
    }
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        },
      },
      (res) => {
        let resBody = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          resBody += c;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(resBody));
            } catch (e) {
              reject(new Error('bad response json'));
            }
          } else {
            reject(new Error(`status ${res.statusCode}`));
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('request timeout'));
    });
    req.on('error', (e) => reject(e));
    req.write(body);
    req.end();
  });
}

async function runPermissionGate() {
  if (!ENDPOINT) {
    emit('ask', 'Nimbalyst permission endpoint not configured');
    return;
  }
  let input = {};
  try {
    const raw = await readStdin();
    input = raw ? JSON.parse(raw) : {};
  } catch {
    emit('ask', 'Could not parse hook input');
    return;
  }

  // Claude Code PreToolUse stdin (snake_case): session_id, tool_name, tool_input, cwd.
  const payload = {
    sessionId: input.session_id || input.sessionId || '',
    toolName: input.tool_name || input.toolName || '',
    toolInput: input.tool_input || input.toolInput || {},
    cwd: input.cwd || '',
  };

  if (!payload.sessionId || !payload.toolName) {
    emit('ask', 'Missing session or tool in hook input');
    return;
  }

  try {
    const result = await postPermission(payload);
    const decision = result && result.decision === 'allow' ? 'allow' : result && result.decision === 'deny' ? 'deny' : 'ask';
    emit(decision, result && result.reason ? String(result.reason) : undefined);
  } catch (e) {
    // Endpoint unreachable / errored → defer to the CLI's native prompt.
    emit('ask', `Nimbalyst permission unavailable: ${e instanceof Error ? e.message : 'error'}`);
  }
}

// ---------------------------------------------------------------------------
// ExitPlanMode mode ("node claudeCliPermissionHook.cjs exit-plan-mode")
//
// A PreToolUse hook on ExitPlanMode that lets Nimbalyst's plan card answer the CLI's
// "Ready to code?" dialog. Verified live on CLI 2.1.295: a PreToolUse allow skips the
// dialog (the CLI continues in default mode); a PermissionRequest hook is NOT honored for
// ExitPlanMode. FAIL-OPEN: on any error or timeout this prints NOTHING and exits 0, so the
// CLI shows its own terminal dialog exactly as if no hook were installed.
// ---------------------------------------------------------------------------

const EXIT_PLAN_TIMEOUT_MS = Number(process.env.NIMBALYST_EXIT_PLAN_TIMEOUT_MS || 3590000);

/** /permission -> /exit-plan-mode on the same loopback host, unless given explicitly. */
function resolveExitPlanEndpoint(env) {
  if (env.NIMBALYST_EXIT_PLAN_URL) return env.NIMBALYST_EXIT_PLAN_URL;
  const base = env.NIMBALYST_PERMISSION_URL || '';
  return base ? base.replace(/\/permission(\?.*)?$/, '/exit-plan-mode') : '';
}

/** Hook stdin (snake_case) -> the body POSTed to Nimbalyst, or null when unusable. */
function buildExitPlanPayload(input) {
  const sessionId = (input && (input.session_id || input.sessionId)) || '';
  if (!sessionId) return null;
  return {
    sessionId,
    toolInput: (input && (input.tool_input || input.toolInput)) || {},
    toolUseId: (input && (input.tool_use_id || input.toolUseId)) || '',
    permissionMode: (input && (input.permission_mode || input.permissionMode)) || '',
  };
}

/** Message the agent sees when the user sends the plan back. */
function buildExitPlanDenyReason(feedback) {
  const text = typeof feedback === 'string' ? feedback.trim() : '';
  return (
    'Plan denied by the user. Continue planning and revise the plan.' +
    (text ? ' User feedback: ' + text : '')
  );
}

/**
 * Nimbalyst's answer -> the PreToolUse hook output, or null for "print nothing" (anything
 * but an explicit approve/deny falls back to the CLI's own dialog).
 */
function mapExitPlanAnswer(answer, toolInput) {
  const decision = answer && answer.decision;
  if (decision === 'approve') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: toolInput || {},
      },
    };
  }
  if (decision === 'deny') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: buildExitPlanDenyReason(answer.feedback),
      },
    };
  }
  return null;
}

async function exitPlanOutput() {
  const endpoint = resolveExitPlanEndpoint(process.env);
  if (!endpoint) return null;
  const raw = await readStdin();
  const payload = buildExitPlanPayload(raw ? JSON.parse(raw) : {});
  if (!payload) return null;
  const answer = await postPermission(payload, endpoint, EXIT_PLAN_TIMEOUT_MS);
  return mapExitPlanAnswer(answer, payload.toolInput);
}

async function runExitPlanMode() {
  try {
    const out = await exitPlanOutput();
    if (out) process.stdout.write(JSON.stringify(out));
  } catch {
    // Print nothing: the CLI falls back to its own plan dialog.
  }
  process.exit(0);
}

module.exports = {
  buildExitPlanPayload,
  buildExitPlanDenyReason,
  mapExitPlanAnswer,
  resolveExitPlanEndpoint,
};

if (require.main === module) {
  if (process.argv[2] === 'exit-plan-mode') {
    void runExitPlanMode();
  } else {
    void runPermissionGate();
  }
}
