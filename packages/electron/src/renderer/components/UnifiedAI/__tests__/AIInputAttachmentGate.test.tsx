// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIInput } from '../AIInput';
import { errorNotificationService } from '../../../services/ErrorNotificationService';

/**
 * Regression: a provider that declares `supportsAttachments: false` used to have
 * a pasted image saved anyway and referenced in its prompt, because the paste
 * path never read the capability. The image then reached a backend with no
 * handler for it and was dropped without a word.
 */

// jsdom ships no DataTransfer, so stub exactly the surface the handlers read:
// clipboard `items` (type + getAsFile) and `getData`, drop `files`/`types`/`getData`.
function imagePasteEvent() {
  const file = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' });
  return {
    clipboardData: {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      getData: () => '',
      files: [file],
      types: ['Files'],
    },
  };
}

function fileDropEvent() {
  const file = new File([new Uint8Array([1, 2, 3])], 'notes.pdf', { type: 'application/pdf' });
  return {
    dataTransfer: {
      items: [{ kind: 'file', type: 'application/pdf', getAsFile: () => file }],
      getData: () => '',
      files: [file],
      types: ['Files'],
    },
  };
}

function renderInput(props: Record<string, unknown>) {
  const onAttachmentAdd = vi.fn();
  const onChange = vi.fn();
  const utils = render(
    <AIInput
      value=""
      onChange={onChange}
      onSend={vi.fn()}
      sessionId="session-1"
      workspacePath="/tmp/ws"
      onAttachmentAdd={onAttachmentAdd}
      onAttachmentRemove={vi.fn()}
      testId="gate-input"
      {...props}
    />,
  );
  const textarea = utils.container.querySelector('textarea') as HTMLTextAreaElement;
  return { ...utils, textarea, onAttachmentAdd, onChange };
}

describe('AIInput attachment gate', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(errorNotificationService, 'showWarning').mockReturnValue('id' as any);
    // jsdom has no window.alert; the supported-provider path reaches it.
    vi.stubGlobal('alert', vi.fn());
    (window as any).electronAPI = {
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'attachment:validate') return { valid: true };
        if (channel === 'attachment:save') {
          return { success: true, attachment: { id: 'a1', filename: 'image.png' } };
        }
        return { success: true, data: [] };
      }),
      on: vi.fn(() => () => {}),
      off: vi.fn(),
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('refuses a pasted image when the provider takes no attachments, and says so', () => {
    const { textarea, onAttachmentAdd } = renderInput({
      attachmentsSupported: false,
      providerDisplayName: 'Lea (Hermes)',
    });

    fireEvent.paste(textarea, imagePasteEvent());

    expect(onAttachmentAdd).not.toHaveBeenCalled();
    expect((window as any).electronAPI.invoke).not.toHaveBeenCalledWith(
      'attachment:validate',
      expect.anything(),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toContain('Lea (Hermes)');
  });

  it('refuses a dropped file the same way', () => {
    const { textarea, onAttachmentAdd } = renderInput({
      attachmentsSupported: false,
      providerDisplayName: 'Lea (Hermes)',
    });
    const dropZone = textarea.closest('div') as HTMLElement;

    fireEvent.drop(dropZone, fileDropEvent());

    expect(onAttachmentAdd).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toContain('Lea (Hermes)');
  });

  it('still attaches a pasted image for a provider that supports attachments', async () => {
    const { textarea } = renderInput({ attachmentsSupported: true });

    fireEvent.paste(textarea, imagePasteEvent());
    await vi.waitFor(() =>
      expect((window as any).electronAPI.invoke).toHaveBeenCalledWith(
        'attachment:validate',
        expect.objectContaining({ mimeType: 'image/png' }),
      ),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('defaults to supporting attachments when the prop is omitted', async () => {
    const { textarea } = renderInput({});

    fireEvent.paste(textarea, imagePasteEvent());
    await vi.waitFor(() =>
      expect((window as any).electronAPI.invoke).toHaveBeenCalledWith(
        'attachment:validate',
        expect.anything(),
      ),
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
