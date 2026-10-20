import { logger } from '../../utils/logger';
import { getAIProviderOverrides, getAiSettingsStore, getDefaultAIModel } from '../../utils/store';
import { isExtensionAgentProvider } from './providerResolution';
import { resolveProviderEnabled } from './modelEnablementFilter';
import type { SessionProviderGuardSettings } from './sessionProviderGuard';

/**
 * Live settings reads for the session provider guard. Every call re-reads the
 * main-process stores, so a toggle flipped in Settings applies to the very next
 * session with no cache to invalidate.
 */
export function createLiveSessionProviderGuardSettings(): SessionProviderGuardSettings {
  return {
    isProviderEnabled(provider, workspacePath) {
      const providerSettings = (getAiSettingsStore().get('providerSettings', {}) ?? {}) as Record<
        string,
        { enabled?: boolean } | undefined
      >;
      let enabled = resolveProviderEnabled(provider, providerSettings[provider]);
      if (workspacePath) {
        try {
          const override = getAIProviderOverrides(workspacePath)?.providers?.[provider]?.enabled;
          if (override !== undefined) enabled = override;
        } catch (error) {
          // The global toggle still applies; a broken override read must not
          // become a way around the guard or a reason to block creation.
          logger.main.warn('[provider-guard] could not read project override, using global setting', error);
        }
      }
      return enabled;
    },
    getDefaultModel: () => getDefaultAIModel(),
    getDefaultProvider() {
      const stored = getAiSettingsStore().get('defaultProvider');
      return typeof stored === 'string' && stored ? stored : undefined;
    },
    isExtensionProvider: (provider) => isExtensionAgentProvider(provider),
    log: (message) => logger.main.warn(message),
  };
}
