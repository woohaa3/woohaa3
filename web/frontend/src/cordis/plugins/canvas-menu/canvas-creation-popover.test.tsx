/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiProvider } from "../../../shared/ui/UiProvider.js";
import CanvasCreationPopover from "./canvas-creation-popover.js";

const mocks = vi.hoisted(() => ({ services: {} as Record<string, any> }));
vi.mock("../../react.js", () => ({ useService: (key: string) => mocks.services[key] }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let el: HTMLDivElement;
const menu = {};
let currentMenu: object;
let canvasId: string;
const close = vi.fn();
const selectItem = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  el = document.createElement("div"); document.body.append(el); root = createRoot(el);
  canvasId = "canvas"; currentMenu = menu;
  mocks.services = {
    canvasEdit: { record: vi.fn(async () => ({ ok: true })) },
    canvasScope: { canvasId: () => canvasId },
    canvasSession: { isWritable: vi.fn(() => true) },
    canvasRuntime: { controller: () => ({ selectNode: select }) },
    canvasNavigation: { getSnapshot: () => ({ menu: currentMenu }), openPanel: vi.fn() }
  };
});
const select = vi.fn();
afterEach(async () => { await act(async () => root.unmount()); el.remove(); });
async function render(writable = true) {
  await act(async () => root.render(<UiProvider><CanvasCreationPopover menuIdentity={menu} screen={{ x: 100, y: 100 }} world={{ x: 40, y: 50 }} items={[{ id: "insert:text", label: "文本", section: "basic-material" }]} writable={writable} onSelect={selectItem} onClose={close} /></UiProvider>));
}
function entry() { return document.querySelector<HTMLButtonElement>(".canvas-create__ai-entry")!; }
describe("blank canvas creation menu", () => {
  it("creates and selects a group at the context position without an assistant input step", async () => {
    await render();
    expect(mocks.services.canvasEdit.record).not.toHaveBeenCalled();
    await act(async () => entry().click());
    const commands = mocks.services.canvasEdit.record.mock.calls[0][0];
    expect(commands).toEqual([{ type: "node.add", node: { id: expect.any(String), type: "group", position: { x: 40, y: 50 } }, nodeData: {} }]);
    expect(select).toHaveBeenCalledWith(commands[0].node.id);
    expect(mocks.services.canvasNavigation.openPanel).toHaveBeenCalledWith({ type: "model-node-editor", nodeId: commands[0].node.id });
    expect(close).toHaveBeenCalledOnce();
    expect(document.querySelector(".canvas-create__composer")).toBeNull();
  });
  it("keeps material shortcuts and a search field without executing on Enter", async () => {
    await render();
    const field = document.querySelector("textarea")!;
    expect(field.placeholder).toBe("搜索素材…");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(field, "不存在的素材");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.querySelector(".canvas-create__grid")).toBeNull();
    expect(entry().textContent).toContain("用 AI 创作");
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })));
    expect(mocks.services.canvasEdit.record).not.toHaveBeenCalled();
  });
  it("disables creation for read-only menus and rechecks write permission on click", async () => {
    await render(false);
    expect(entry().disabled).toBe(true);
    await render();
    mocks.services.canvasSession.isWritable.mockReturnValue(false);
    await act(async () => entry().click());
    expect(mocks.services.canvasEdit.record).not.toHaveBeenCalled();
  });
  it("prevents repeated creation and preserves the menu on a rejected edit", async () => {
    let resolve!: (result: unknown) => void;
    mocks.services.canvasEdit.record.mockReturnValue(new Promise(r => { resolve = r; }));
    await render();
    act(() => { entry().click(); entry().click(); });
    expect(mocks.services.canvasEdit.record).toHaveBeenCalledOnce();
    await act(async () => resolve({ ok: false, reason: "画布已断开连接" }));
    expect(document.body.textContent).toContain("画布已断开连接");
    expect(select).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(entry().disabled).toBe(false);
  });
  it.each(["canvas", "menu"])("does not select a late result after switching %s", async target => {
    let resolve!: (result: unknown) => void;
    mocks.services.canvasEdit.record.mockReturnValue(new Promise(r => { resolve = r; }));
    await render();
    act(() => entry().click());
    if (target === "canvas") canvasId = "other"; else currentMenu = {};
    await act(async () => resolve({ ok: true }));
    expect(select).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
