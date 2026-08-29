import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXTENSION_PROVIDER_ICON,
  registerExtensionProviderIcons,
  resolveProviderIcon,
  unregisterExtensionProviderIcons,
} from '../ProviderIcons';

describe('resolveProviderIcon', () => {
  it('maps the Codex ACP provider to the shared Codex icon', () => {
    expect(resolveProviderIcon('openai-codex-acp')).toBe('openai-codex');
  });

  it('leaves other provider ids unchanged', () => {
    expect(resolveProviderIcon('openai')).toBe('openai');
    expect(resolveProviderIcon('claude-code')).toBe('claude-code');
  });
});

describe('extension-contributed provider icons', () => {
  it('draws the manifest icon rather than the raw contribution id', () => {
    // Unregistered, the id is handed to Material Symbols as a ligature. It is not one, so the
    // font draws the letters: a "lea-hermes" wordmark in the session list.
    expect(resolveProviderIcon('lea-hermes')).toBe('lea-hermes');
    registerExtensionProviderIcons({ 'lea-hermes': 'hive' });
    expect(resolveProviderIcon('lea-hermes')).toBe('hive');
    unregisterExtensionProviderIcons(['lea-hermes']);
    expect(resolveProviderIcon('lea-hermes')).toBe('lea-hermes');
  });

  // A contribution with no icon must still not produce a wordmark.
  it('gives a provider that declares no icon a generic agent glyph', () => {
    registerExtensionProviderIcons({ 'some-agent': undefined });
    expect(resolveProviderIcon('some-agent')).toBe(DEFAULT_EXTENSION_PROVIDER_ICON);
    unregisterExtensionProviderIcons(['some-agent']);
  });

  // The hand-patched built-in table is the same bug fixed one provider at a time; it must keep
  // winning so an extension cannot re-skin a built-in provider by claiming its id.
  it('never lets an extension override the built-in table', () => {
    registerExtensionProviderIcons({ 'openai-codex-acp': 'bug_report' });
    expect(resolveProviderIcon('openai-codex-acp')).toBe('openai-codex');
    unregisterExtensionProviderIcons(['openai-codex-acp']);
  });

  it('replaces an entry rather than accumulating them', () => {
    registerExtensionProviderIcons({ 'x-agent': 'hive' });
    registerExtensionProviderIcons({ 'x-agent': 'terminal' });
    expect(resolveProviderIcon('x-agent')).toBe('terminal');
    unregisterExtensionProviderIcons(['x-agent']);
  });
});
