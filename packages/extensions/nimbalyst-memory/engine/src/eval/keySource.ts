/**
 * Where the harness gets an embedding API key.
 *
 * Deliberately NOT `process.env`. Reading a provider key out of the ambient
 * environment is a hard prohibition in this repo: a user with an unrelated
 * `ANTHROPIC_API_KEY` in a `.env` had it silently picked up, persisted, and
 * billed for $100+. The rule is about the product, but a dev script that
 * normalises "just export the key" trains exactly the habit the rule exists to
 * prevent, and a harness that quietly spends a key nobody pointed it at is its
 * own small version of the same incident.
 *
 * The operator must name a JSON key file explicitly. Desktop credentials are
 * protected by the main-process vault and are not an offline evaluation input.
 */
import { existsSync, readFileSync } from 'node:fs';

export const DEFAULT_KEY_FIELD = 'apiKeys.openai';

/** Read a dotted path out of a parsed JSON object. Returns null if absent. */
export function readDotted(obj: unknown, dotted: string): string | null {
  let cur: unknown = obj;
  for (const part of dotted.split('.')) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' && cur.length > 0 ? cur : null;
}

export interface KeyLookup {
  key: string | null;
  /** Where it came from, or why it was not found. Printed, never the key. */
  detail: string;
}

/**
 * Resolve an API key only from the file explicitly supplied by the operator.
 */
export function resolveApiKey(file?: string, field = DEFAULT_KEY_FIELD): KeyLookup {
  if (!file) return { key: null, detail: 'Supply --key-file with an explicit evaluation credential file; desktop API keys are in secure storage.' };
  const candidates = [file];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(candidate, 'utf8'));
    } catch {
      return { key: null, detail: `${candidate} could not be read as JSON` };
    }
    const key = readDotted(parsed, field);
    if (key) return { key, detail: `${candidate} (${field})` };
    return { key: null, detail: `${candidate} has no ${field}` };
  }
  return { key: null, detail: `no settings file found (looked in: ${candidates.join(', ')})` };
}
