import { describe, expect, it } from 'vitest';
import {
  attachmentUnsupportedMessage,
  buildAttachmentSupportMap,
  providerSupportsAttachments,
} from '../providerAttachmentSupport';

describe('buildAttachmentSupportMap', () => {
  it('records an explicit boolean either way', () => {
    const map = buildAttachmentSupportMap([
      { id: 'lea-hermes', supportsAttachments: false },
      { id: 'some-agent', supportsAttachments: true },
    ]);
    expect(map.get('lea-hermes')).toBe(false);
    expect(map.get('some-agent')).toBe(true);
  });

  it('omits a provider that declared nothing, so silence is not a refusal', () => {
    const map = buildAttachmentSupportMap([{ id: 'quiet-agent' }]);
    expect(map.has('quiet-agent')).toBe(false);
  });

  it('ignores malformed rows instead of throwing', () => {
    const map = buildAttachmentSupportMap([
      null,
      undefined,
      { supportsAttachments: false },
      { id: '', supportsAttachments: false },
      { id: 'ok', supportsAttachments: false },
    ] as any);
    expect([...map.entries()]).toEqual([['ok', false]]);
  });

  it('is empty for a non-array payload', () => {
    expect(buildAttachmentSupportMap(undefined).size).toBe(0);
    expect(buildAttachmentSupportMap(null).size).toBe(0);
    expect(buildAttachmentSupportMap('nope' as any).size).toBe(0);
  });
});

describe('providerSupportsAttachments', () => {
  const map = buildAttachmentSupportMap([
    { id: 'lea-hermes', supportsAttachments: false },
    { id: 'takes-files', supportsAttachments: true },
  ]);

  it('refuses a provider that declared supportsAttachments: false', () => {
    expect(providerSupportsAttachments('lea-hermes', map)).toBe(false);
  });

  it('allows a provider that declared true', () => {
    expect(providerSupportsAttachments('takes-files', map)).toBe(true);
  });

  it('allows a built-in provider that is not in the map at all', () => {
    expect(providerSupportsAttachments('claude-code', map)).toBe(true);
  });

  it('fails open while the map has not loaded yet', () => {
    expect(providerSupportsAttachments('lea-hermes', null)).toBe(true);
    expect(providerSupportsAttachments('lea-hermes', new Map())).toBe(true);
  });

  it('allows an absent provider', () => {
    expect(providerSupportsAttachments(null, map)).toBe(true);
    expect(providerSupportsAttachments(undefined, map)).toBe(true);
  });
});

describe('attachmentUnsupportedMessage', () => {
  it('names the provider so the user knows who refused', () => {
    const { message } = attachmentUnsupportedMessage('Lea (Hermes)', 'image');
    expect(message).toContain('Lea (Hermes)');
    expect(message).toContain('images');
  });

  it('falls back to a generic subject when the name is missing', () => {
    expect(attachmentUnsupportedMessage(null, 'file').message).toMatch(/^This agent/);
    expect(attachmentUnsupportedMessage('   ', 'file').message).toMatch(/^This agent/);
  });

  it('distinguishes a pasted image from a dropped file', () => {
    expect(attachmentUnsupportedMessage('X', 'image').message).toContain('pasted image');
    expect(attachmentUnsupportedMessage('X', 'file').message).toContain('dropped file');
  });
});
