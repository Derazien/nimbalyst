import React, { createRef, type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { afterEach, expect, it, vi } from "vitest";
import {
  WorkstreamEditorTabs,
  type WorkstreamEditorTabsRef,
} from "../WorkstreamEditorTabs";
import {
  initWorkstreamState,
  workstreamStateAtom,
  workstreamStatesLoadedAtom,
} from "../../../store/atoms/workstreamState";
import { revealEditorPosition } from "../../TabEditor/editorRevealCommand";

const { actions, tabs } = vi.hoisted(() => ({
  actions: {
    addTab: vi.fn(),
    switchTab: vi.fn(),
    findTabByPath: vi.fn(),
    removeTab: vi.fn(),
  },
  tabs: [],
}));
vi.mock("../../../contexts/TabsContext", () => ({
  TabsProvider: ({ children }: { children: ReactNode }) => children,
  useTabs: () => ({ tabs, activeTabId: null }),
  useTabsActions: () => actions,
  useTabNavigationShortcuts: () => {},
}));
vi.mock("../../TabManager/TabManager", () => ({ TabManager: () => null }));
vi.mock("../../TabContent/TabContent", () => ({ TabContent: () => null }));
vi.mock("../FilePlacementControl", () => ({
  FilePlacementControl: () => null,
  FilePlacementNotice: () => null,
}));
vi.mock("../../TabEditor/editorRevealCommand", () => ({
  revealEditorPosition: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("does not mirror an empty hidden editor before hydration, forwards file locations, and acknowledges hidden tracker opens", () => {
  initWorkstreamState("/placement-test");
  const store = createStore();
  const id = "hidden-editor";
  const saved = [
    {
      resource: {
        kind: "file" as const,
        resourceId: "/saved.md",
        filePath: "/saved.md",
      },
    },
  ];
  store.set(workstreamStateAtom(id), { openResources: saved });
  const ref = createRef<WorkstreamEditorTabsRef>();
  render(
    <Provider store={store}>
      <WorkstreamEditorTabs
        ref={ref}
        workstreamId={id}
        workspacePath="/placement-test"
        isActive={false}
      />
    </Provider>
  );
  expect(store.get(workstreamStateAtom(id)).openResources).toEqual(saved);
  act(() => store.set(workstreamStatesLoadedAtom, true));
  expect(actions.addTab).toHaveBeenCalledWith("/saved.md");
  act(() => ref.current?.openFile("/source.ts", { line: 37, column: 4 }));
  expect(revealEditorPosition).toHaveBeenCalledWith("/source.ts", {
    line: 37,
    column: 4,
  });
  const event = new CustomEvent("nimbalyst:workstream-open-tracker", {
    detail: { workstreamId: id, trackerItemId: "tracker-1" },
    cancelable: true,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
  expect(actions.addTab).toHaveBeenCalledWith("tracker://tracker-1");
  expect(store.get(workstreamStateAtom(id)).layoutMode).toBe("split");
});
