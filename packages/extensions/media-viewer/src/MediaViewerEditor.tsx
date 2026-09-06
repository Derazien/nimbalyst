import { useMemo, useState } from 'react';
import type { EditorHostProps } from '@nimbalyst/runtime';

/**
 * Plays the tab's video file.
 *
 * The element is pointed at a host asset URL rather than at bytes from
 * `loadBinaryContent`. That is the whole design: a blob built from a
 * whole-file ArrayBuffer would pull a multi-gigabyte screen recording through
 * IPC and into renderer memory before the first frame paints, where a URL lets
 * the host serve byte ranges and playback starts immediately.
 *
 * That also means seeking is only as good as the host's range support. A host
 * that answers every request with the whole file leaves `<video>` in a state
 * where seeks silently resolve back to 0 -- the failure reports itself as
 * success, so there is nothing to detect here and nothing to fall back to.
 */
export function MediaViewerEditor({ host }: EditorHostProps) {
  const [failed, setFailed] = useState(false);

  const src = useMemo(() => host.getAssetUrl?.() ?? null, [host]);

  if (!src) {
    return (
      <div className="media-viewer-editor media-viewer-unavailable">
        <p>This video cannot be played here.</p>
        <p className="media-viewer-detail">
          It is not backed by a file on disk.
        </p>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="media-viewer-editor media-viewer-unavailable">
        <p>This video could not be played.</p>
        <p className="media-viewer-detail">
          The file may be incomplete, or use a format this build cannot decode.
        </p>
      </div>
    );
  }

  return (
    <div className="media-viewer-editor">
      <video
        className="media-viewer-video"
        src={src}
        controls
        preload="metadata"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
