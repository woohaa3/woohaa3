/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { UiProvider } from "../../../shared/ui/UiProvider.js";
import ContextMenuHost from "./canvas-context-menu-host.js";
import { creationDraft } from "./canvas-creation-drafts.js";

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

it("shows the complete menu synchronously and identifies pending assistant data on AI intent", async () => {
  let resolveConnections!: (value: unknown) => void;
  let resolveCatalog!: (value: unknown) => void;
  let resolveOtherCatalog!: (value: unknown) => void;
  const connections = new Promise(resolve => { resolveConnections = resolve; });
  const catalog = new Promise(resolve => { resolveCatalog = resolve; });
  const otherCatalog = new Promise(resolve => { resolveOtherCatalog = resolve; });
  const readCatalog = vi.fn((id: string) => id === "adapter" ? catalog : otherCatalog);
  const readConnections = vi.fn(() => connections);
  const transport = { request: vi.fn(), stream: vi.fn() };
  const closeMenu = vi.fn();
  const menu = { type: "canvas-context" as const, nodeId: null, screen: { x: 100, y: 100 }, world: { x: 40, y: 50 } };
  const identity = { dataScopeId: "space" };
  mocks.services = {
    applicationRemote: { transport }, canvasScope: { canvasId: () => "canvas" },
    currentUser: { subscribe: () => () => undefined, getSnapshot: () => identity },
    canvasLocate: { locateNodes: vi.fn() },
    canvasNavigation: { closeMenu, getSnapshot: () => ({ menu }) },
    agentConversationService: { listConnections: readConnections, catalog: readCatalog }
  };
  Object.assign(creationDraft(transport, "space", "canvas"), { prompt: "文本", connectionId: "connection", model: "model" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    // Synchronous commit: the first menu render must not wait for an import or API.
    act(() => root.render(<UiProvider><ContextMenuHost menu={menu} writable /></UiProvider>));
    const popover = document.querySelector('[data-testid="canvas-creation-popover"]')!;
    const field = popover.querySelector("textarea")!;
    const material = popover.querySelector<HTMLButtonElement>(".canvas-create__grid button")!;
    expect(field.value).toBe("文本");
    expect(material.disabled).toBe(false);
    expect(readConnections).not.toHaveBeenCalled();
    act(() => material.click());
    expect(mocks.select).toHaveBeenCalledWith("insert:text", expect.anything());

    await act(async () => popover.querySelector<HTMLButtonElement>(".canvas-create__ai-entry")!.click());
    expect(popover.querySelector("textarea")).toBe(field);
    expect(popover.textContent).toContain("正在读取助手连接…");
    expect(field.disabled).toBe(false);
    act(() => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })));
    expect(transport.request).not.toHaveBeenCalled();

    const create = popover.querySelector<HTMLButtonElement>(".ui-button")!;
    expect(create.disabled).toBe(true);

    await act(async () => resolveConnections({ ok: true, value: [{
      connectionId: "connection", adapterId: "adapter", name: "本地助手", ready: true,
      authMode: "api-key", capabilities: { tools: true }, models: [{ id: "model", label: "模型" }]
    }, {
      connectionId: "other", adapterId: "other-adapter", name: "云端助手", ready: true,
      authMode: "api-key", capabilities: { tools: true }, models: []
    }] }));
    expect(readCatalog).toHaveBeenCalledWith("adapter");
    expect(popover.textContent).not.toContain("正在读取助手连接…");
    expect(popover.textContent).toContain("正在读取模型与能力（0/2）：本地助手、云端助手…");
    await act(async () => resolveOtherCatalog({ ok: true, value: { capabilities: { targets: ["canvas-group"], tools: true }, models: [] } }));
    expect(popover.textContent).toContain("正在读取模型与能力（1/2）：本地助手…");
    expect(create.disabled).toBe(true);
    act(() => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })));
    expect(transport.request).not.toHaveBeenCalled();

    await act(async () => resolveCatalog({ ok: true, value: { capabilities: { targets: ["canvas-group"], tools: true }, models: [] } }));
    expect(create.disabled).toBe(false);
    expect(popover.textContent).not.toContain("正在读取模型与能力");
    expect(field.value).toBe("文本");
    expect(closeMenu).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
