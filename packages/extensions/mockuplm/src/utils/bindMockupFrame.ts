import { COMMENT_MODE_STYLES } from "../components/comments/commentModeStyles";
import { renderMockupHtml } from "./mockupDomUtils";
import { injectTheme, type MockupTheme } from "./themeEngine";

/** A decorator's iframe can acquire a new Document without changing its React ref. */
export function bindMockupFrame(
  frame: HTMLIFrameElement,
  html: string,
  theme: MockupTheme,
  onRendered: (scriptsRan: boolean) => void
): () => void {
  let paintedDocument: Document | null = null;
  const paint = () => {
    const doc = frame.contentDocument;
    if (!doc || doc === paintedDocument) return;
    // doc.close() itself fires load. Mark before writing so our own load never
    // resets scripts, scroll, or interaction state. A detach/reattach creates
    // a different Document, which must be painted even with unchanged HTML.
    paintedDocument = doc;
    const { scriptsRan } = renderMockupHtml(frame, html, {
      onAfterRender: (iframeDoc) => {
        injectTheme(iframeDoc, theme);
        const style = iframeDoc.createElement("style");
        style.textContent = `
          .nimbalyst-selected {
            outline: 2px solid #007AFF !important;
            outline-offset: 2px !important;
            box-shadow: 0 0 0 4px rgba(0, 122, 255, 0.2) !important;
          }
          ${COMMENT_MODE_STYLES}
        `;
        iframeDoc.head.appendChild(style);
      },
    });
    onRendered(scriptsRan);
  };
  frame.addEventListener("load", paint);
  paint();
  return () => frame.removeEventListener("load", paint);
}
