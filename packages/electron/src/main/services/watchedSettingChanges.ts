/**
 * Settings whose silent flips have cost real work: when cross-project messaging
 * turned itself off on 2026-10-11, nothing recorded who changed it or when. Every
 * change to one of these is logged with the value before and after, plus the
 * caller, so the next flip names its cause.
 */
export const WATCHED_SETTING_KEYS: ReadonlySet<string> = new Set(['agent.crossWorkspaceMessaging', 'alphaFeatures.cross-project']);

/** The log line for a watched key whose value changed, else null. */
export function describeWatchedSettingChange(key: string, before: unknown, after: unknown, caller?: string): string | null {
  if (!WATCHED_SETTING_KEYS.has(key) || Object.is(before, after)) return null;
  const from = caller ? ` from ${caller}` : '';
  return `[Settings] ${key} changed ${JSON.stringify(before ?? null)} -> ${JSON.stringify(after ?? null)}${from}`;
}

/** First stack frames outside the settings layer, so the log says who asked. */
export function settingChangeCaller(): string {
  const frames = (new Error().stack ?? '').split('\n').slice(1).map((l) => l.trim());
  const outside = frames.filter((f) => !/watchedSettingChanges|SettingsService|utils[\/]store/.test(f));
  return outside.slice(0, 3).join(' <- ') || 'unknown';
}
