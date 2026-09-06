import React from "react";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Doc as YDoc } from "yjs";
import type { CollaborationCommentsService } from "@nimbalyst/extension-sdk";

vi.mock("@nimbalyst/extension-sdk", async () => {
  const actual = await vi.importActual<
    typeof import("@nimbalyst/extension-sdk")
  >("@nimbalyst/extension-sdk");
  return {
    ...actual,
    useEditorLifecycle: (
      host: { testContent?: string },
      options: { applyContent(content: string): void }
    ) => {
      React.useEffect(() => {
        if (host.testContent) options.applyContent(host.testContent);
      }, [host]);
      return {
        markDirty: vi.fn(),
        isLoading: false,
        error: null,
        theme: "dark",
        diffState: null,
      };
    },
    useCollaborativeEditor: vi.fn(),
  };
});

import { MockupEditor } from "../components/MockupEditor";

function stubHost(extra: Record<string, unknown> = {}) {
  return {
    filePath: "/workspace/dashboard.mockup.html",
    fileName: "dashboard.mockup.html",
    isActive: false,
    readOnly: false,
    registerEditorAPI: vi.fn(),
    onReadOnlyChanged: vi.fn(() => () => undefined),
    onThemeChanged: vi.fn(() => () => undefined),
    onSaveRequested: vi.fn(() => () => undefined),
    onDiffRequested: vi.fn(() => () => undefined),
    onContentChanged: vi.fn(() => () => undefined),
    loadContent: vi.fn(async () => "<html><body>Dashboard</body></html>"),
    saveContent: vi.fn(async () => undefined),
    setDirty: vi.fn(),
    reportDiffResult: vi.fn(),
    ...extra,
  } as never;
}

function stubCanvas(): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
  } as never);
}

describe("MockupEditor editor API", () => {
  it("registers readiness for hidden-editor tools and unregisters on unmount", () => {
    stubCanvas();
    const registerEditorAPI = vi.fn();
    const host = stubHost({ registerEditorAPI });

    const view = render(<MockupEditor host={host} />);

    expect(registerEditorAPI).toHaveBeenCalledWith(
      expect.objectContaining({
        getCurrentHtml: expect.any(Function),
        exportToPngBlob: expect.any(Function),
      })
    );

    view.unmount();
    expect(registerEditorAPI).toHaveBeenLastCalledWith(null);
  });
});

/**
 * The comments panel is the platform's, docked beside this editor by the host.
 * A mockup that mounts one of its own puts two identical panels on screen for
 * the same document -- two Reply boxes, two Resolve buttons, per thread.
 */
describe("MockupEditor comments surface", () => {
  function commentsService(): CollaborationCommentsService {
    return {
      getSnapshot: () => Object.freeze([]),
      subscribe: () => () => undefined,
      getCapabilities: () => ({ read: true, comment: true }),
      getMentionableMembers: () => [],
      createThread: vi.fn(),
      reply: vi.fn(),
      setResolved: vi.fn(async () => undefined),
      focusThread: vi.fn(async () => true),
      openPanel: vi.fn(),
      registerAnchorAdapter: () => () => undefined,
    } as unknown as CollaborationCommentsService;
  }

  it("mounts no comments panel of its own, even in comment mode", () => {
    stubCanvas();
    const service = commentsService();
    const host = stubHost({
      collaboration: {
        yDoc: new YDoc(),
        comments: service,
        user: { id: "user-1", name: "Ada" },
      },
    });

    const { container } = render(<MockupEditor host={host} />);

    // Entering comment mode is the moment the editor's own pane used to appear.
    const toggle = container.querySelector<HTMLButtonElement>(
      ".mockup-comment-mode-toggle"
    );
    fireEvent.click(toggle!);

    expect(container.querySelectorAll(".nim-comments-panel")).toHaveLength(0);
    // The pins overlay is the extension's half and stays.
    expect(container.querySelector(".mockup-comment-overlay")).not.toBeNull();
  });
});

/**
 * What a read-only embed publishes, and what it refuses to do.
 *
 * The feedback detail popover mounts a mockup full-size and lets clicks reach
 * it, which is new. Two properties hold that up and neither is visible on
 * screen: the editor tells the host where the reader is, and a click inside
 * the design cannot change the design.
 */
describe("MockupEditor read-only embed", () => {
  function readOnlyHost(extra: Record<string, unknown> = {}) {
    return stubHost({ readOnly: true, embedded: true, ...extra });
  }

  function iframeDocOf(container: HTMLElement): Document {
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    return frame.contentDocument as Document;
  }

  it("paints a detached embed when its browsing context loads and does not repaint its own load", () => {
    stubCanvas();
    const container = document.createElement("div");
    const view = render(
      <MockupEditor
        host={readOnlyHost({ testContent: "<h1>Detached preview</h1>" })}
      />,
      { container }
    );
    const frame = container.querySelector("iframe")!;
    // Lexical can mount a decorator before attaching its DOM to the editor.
    expect(frame.contentDocument).toBeNull();
    document.body.appendChild(container);
    fireEvent.load(frame);
    expect(frame.contentDocument!.body.textContent).toContain(
      "Detached preview"
    );
    const write = vi.spyOn(frame.contentDocument!, "write");
    fireEvent.load(frame);
    expect(write).not.toHaveBeenCalled();
    // Reparenting the same iframe destroys its browsing context without a ref change.
    container.remove();
    document.body.appendChild(container);
    fireEvent.load(frame);
    expect(frame.contentDocument!.body.textContent).toContain(
      "Detached preview"
    );
    view.unmount();
    container.remove();
  });

  it("publishes a scroll viewport the host can carry between mockups", () => {
    stubCanvas();
    const registerViewport = vi.fn();
    const view = render(
      <MockupEditor host={readOnlyHost({ registerViewport })} />
    );

    expect(registerViewport).toHaveBeenCalledWith(
      expect.objectContaining({
        getScrollFraction: expect.any(Function),
        setScrollFraction: expect.any(Function),
      })
    );

    // Nothing to scroll yet, so the honest answer is the top -- not NaN from a
    // division by a zero scrollable height, which assigned to scrollTop would
    // silently pin the *next* mockup to the top and look like a lost carry.
    const viewport = registerViewport.mock.calls[0]![0]!;
    expect(viewport.getScrollFraction()).toBe(0);
    expect(() => viewport.setScrollFraction(0.5)).not.toThrow();

    // A host that stops listening must not keep a dead editor's accessors.
    view.unmount();
    expect(registerViewport).toHaveBeenLastCalledWith(null);
  });

  it("leaves the source untouched when someone clicks around inside it", () => {
    stubCanvas();
    const registerEditorAPI = vi.fn();
    const { container } = render(
      <MockupEditor host={readOnlyHost({ registerEditorAPI })} />
    );
    const api = registerEditorAPI.mock.calls[0]![0]! as {
      getCurrentHtml(): string;
    };
    const before = api.getCurrentHtml();

    // Stand in for a viewer using the prototype: hover states, disclosure
    // toggles, a script mutating its own DOM.
    const doc = iframeDocOf(container);
    const injected = doc.createElement("div");
    injected.textContent = "clicked";
    doc.body.appendChild(injected);
    fireEvent.click(doc.body);

    /*
     * The editor holds the HTML *source* and renders it into the frame, so DOM
     * mutation has no path back. That is a property of how this editor happens
     * to be built rather than a rule anyone enforced, which is exactly why it
     * is asserted instead of assumed -- the popover's "interactive but not
     * editable" boundary rests on it.
     */
    expect(api.getCurrentHtml()).toBe(before);
  });

  it("makes an in-mockup link inert rather than navigating the frame away", () => {
    stubCanvas();
    const { container } = render(<MockupEditor host={readOnlyHost()} />);

    const doc = iframeDocOf(container);
    const anchor = doc.createElement("a");
    anchor.setAttribute("href", "/pricing");
    anchor.textContent = "Pricing";
    doc.body.appendChild(anchor);

    const click = new doc.defaultView!.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    anchor.dispatchEvent(click);

    // The frame renders from a string with no base URL, so following the link
    // replaces the design with a failed navigation -- and inside a popover
    // there is no back button to recover with.
    expect(click.defaultPrevented).toBe(true);
  });
});
