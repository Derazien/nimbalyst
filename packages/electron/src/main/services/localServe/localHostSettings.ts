/**
 * What the "Local hosts" setting accepts (#416).
 *
 * The bearer token is the only thing standing between this address and an
 * agent that runs with the OS user's permissions, so the address is held to
 * the same rule the node applies to its own listener: loopback or the tailnet,
 * never a LAN or public interface.
 */

import { isAllowedLocalServeBindAddress } from '@nimbalyst/runtime/sync/localServe/protocol';

export const MIN_LOCAL_HOST_TOKEN_LENGTH = 32;

export type LocalHostInputResult = { ok: true; url: string } | { ok: false; error: string };

export function validateLocalHostInput(rawUrl: unknown, token: unknown): LocalHostInputResult {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return { ok: false, error: 'Enter the host address, for example http://127.0.0.1:47615.' };
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: 'That is not a valid address. Use http://127.0.0.1:<port> or http://<tailnet address>:<port>.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, error: 'The address must start with http:// or https://.' };
  if (!parsed.port) return { ok: false, error: 'Include the port the node listens on, for example :47615.' };
  if (!isAllowedLocalServeBindAddress(parsed.hostname)) {
    return { ok: false, error: 'Only this machine (127.0.0.1) or a tailnet address (100.64.0.0/10) is allowed.' };
  }
  if (typeof token !== 'string' || token.trim().length < MIN_LOCAL_HOST_TOKEN_LENGTH || /\s/.test(token.trim())) {
    return { ok: false, error: `Paste the node's token: at least ${MIN_LOCAL_HOST_TOKEN_LENGTH} characters, no spaces.` };
  }
  return { ok: true, url: `${parsed.protocol}//${parsed.host}` };
}
