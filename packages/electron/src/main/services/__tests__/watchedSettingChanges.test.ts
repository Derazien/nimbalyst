// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { describeWatchedSettingChange } from '../watchedSettingChanges';
import { getDefaultAlphaFeatures } from '../../../shared/alphaFeatures';
import { getDescriptor } from '../../../shared/settings/keys';

describe('watched setting changes', () => {
  it('logs a change to cross-project messaging with before, after and caller', () => {
    expect(describeWatchedSettingChange('agent.crossWorkspaceMessaging', 'allow', 'off', 'ipc settings:set')).toBe(
      '[Settings] agent.crossWorkspaceMessaging changed "allow" -> "off" from ipc settings:set',
    );
  });

  it('stays quiet for an unchanged value or an unwatched key', () => {
    expect(describeWatchedSettingChange('agent.crossWorkspaceMessaging', 'allow', 'allow')).toBeNull();
    expect(describeWatchedSettingChange('ai.showToolCalls', true, false)).toBeNull();
  });

  it('defaults cross-project sessions and messaging to on in this fork', () => {
    expect(getDefaultAlphaFeatures()['cross-project']).toBe(true);
    expect(getDescriptor('agent.crossWorkspaceMessaging').defaultValue).toBe('allow');
  });
});
