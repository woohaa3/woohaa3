/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiProvider } from "@woohaa3/ui/primitives";
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
async function render(writable = true, items = [{ id: "insert:text", label: "文本", section: "basic-material" }]) {
  await act(async () => root.render(<UiProvider><CanvasCreationPopover menuIdentity={menu} screen={{ x: 100, y: 100 }} world={{ x: 40, y: 50 }} items={items} writable={writable} onSelect={selectItem} onClose={close} /></UiProvider>));
}
describe("blank canvas creation menu", () => {
  it("把上传放到基础素材行末尾，并用浅色分隔与音频隔开", async () => {
    await render(true, [
      { id: "insert:text", label: "文本", section: "basic-material" },
      { id: "insert:image", label: "图片", section: "basic-material" },
      { id: "insert:model3d", label: "3D 模型", section: "basic-material" },
      { id: "insert:video", label: "视频", section: "basic-material" },
      { id: "insert:audio", label: "音频", section: "basic-material" },
      { id: "insert-template:film-set-node", label: "3D 片场", section: "creation-tools" },
      { id: "upload", label: "上传…", section: "other" }
    ]);
    const action = document.querySelector<HTMLButtonElement>(
      '.canvas-create__materials [data-section="basic-material"] .canvas-create__grid-action'
    )!;
    const basicButtons = [...document.querySelectorAll('.canvas-create__materials [data-section="basic-material"] button')];
    expect(basicButtons).toHaveLength(6);
    expect(basicButtons[basicButtons.length - 1]).toBe(action);
    expect(action.title).toBe("上传…");
    expect(action.querySelector("svg")).not.toBeNull();
    expect(action.textContent).toBe("上传…");
    expect(action.className).toContain("canvas-create__grid-action");
    expect(document.querySelector('.canvas-create__materials [data-section="other"]')).toBeNull();
    expect(document.querySelectorAll(".canvas-create__materials section")).toHaveLength(2);
    await act(async () => action.click());
    expect(selectItem).toHaveBeenCalledWith("upload");
  });
  it("uses concrete type icons for every node material", async () => {
    await render(true, [
      { id: "insert:text", label: "文本", section: "basic-material" },
      { id: "insert:image", label: "图片", section: "basic-material" },
      { id: "insert:video", label: "视频", section: "basic-material" },
      { id: "insert:model3d", label: "3D 模型", section: "basic-material" },
      { id: "insert:audio", label: "音频", section: "basic-material" }
    ]);
    const classes = [...document.querySelectorAll(".canvas-create__grid button svg")].map(svg => svg.getAttribute("class") ?? "");
    expect(classes[0]).toContain("lucide-type");
    expect(classes[1]).toContain("lucide-image");
    expect(classes[2]).toContain("lucide-film");
    expect(classes[3]).toContain("lucide-box");
    expect(classes[4]).toContain("lucide-music");
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
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })));
    expect(mocks.services.canvasEdit.record).not.toHaveBeenCalled();
  });
  it("no longer offers the group creation entry", async () => {
    await render();
    expect(document.querySelector(".canvas-create__ai-entry")).toBeNull();
  });
});
