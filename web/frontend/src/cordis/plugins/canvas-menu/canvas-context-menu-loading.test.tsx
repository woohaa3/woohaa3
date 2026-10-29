/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { UiProvider } from "@woohaa3/ui/primitives";
import ContextMenuHost from "./canvas-context-menu-host.js";

const mocks = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  select: vi.fn()
}));
vi.mock("../../react.js", () => ({ useService: (key: string) => mocks.services[key] }));
vi.mock("../../host.js", () => ({
  useContextMenuItems: () => [{ id: "insert:text", label: "文本", section: "basic-material" }],
  useSelectContextMenuItem: () => mocks.select
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("shows materials and the AI creation entry synchronously without loading assistant data", async () => {
  const menu = { type: "canvas-context" as const, nodeId: null, screen: { x: 100, y: 100 }, world: { x: 40, y: 50 } };
  const listConnections = vi.fn();
  mocks.services = {
    canvasScope: { canvasId: () => "canvas" },
    canvasSession: { isWritable: () => true },
    canvasNavigation: { closeMenu: vi.fn(), getSnapshot: () => ({ menu }) },
    agentConversationService: { listConnections }
  };
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<UiProvider><ContextMenuHost menu={menu} writable /></UiProvider>));
    const popover = document.querySelector('[data-testid="canvas-creation-popover"]')!;
    expect(popover.querySelector("textarea")!.placeholder).toBe("搜索素材…");
    expect(popover.querySelector(".canvas-create__ai-entry")!.textContent).toContain("用 AI 创作");
    const material = popover.querySelector<HTMLButtonElement>(".canvas-create__grid button")!;
    act(() => material.click());
    expect(mocks.select).toHaveBeenCalledWith("insert:text", expect.anything());
    expect(listConnections).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount()); container.remove();
  }
});
