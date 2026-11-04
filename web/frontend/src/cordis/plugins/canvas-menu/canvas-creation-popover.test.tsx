/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiProvider } from "@woohaa3/ui/primitives";
import CanvasCreationPopover from "./canvas-creation-popover.js";
import type { CanvasContextMenuItem } from "./canvas-context-menu.js";

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
async function render(writable = true, items: CanvasContextMenuItem[] = [{ id: "insert:text", label: "文本", section: "basic-material" }]) {
  await act(async () => root.render(<UiProvider><CanvasCreationPopover menuIdentity={menu} screen={{ x: 100, y: 100 }} world={{ x: 40, y: 50 }} items={items} writable={writable} onSelect={selectItem} onClose={close} /></UiProvider>));
}
describe("blank canvas creation menu", () => {
  it("按创建分区展示操作，上传独立置底并保留扩展贡献", async () => {
    await render(true, [
      { id: "insert:text", label: "文本", section: "basic-material" },
      { id: "insert:image", label: "图片", section: "basic-material" },
      { id: "insert:model3d", label: "3D 模型", section: "basic-material" },
      { id: "insert:video", label: "视频", section: "basic-material" },
      { id: "insert:audio", label: "音频", section: "basic-material" },
      { id: "insert-scope:area", label: "导演区", section: "basic-material" },
      { id: "insert-scope:group", label: "节点组", section: "basic-material" },
      { id: "insert-scope:camera", label: "镜头", section: "basic-material" },
      { id: "insert-template:custom", label: "扩展素材", section: "creation-tools" },
      { id: "upload", label: "上传…", section: "other" }
    ]);
    expect(document.querySelector(".canvas-create__heading h2")?.textContent).toBe("在此处新建");
    const action = document.querySelector<HTMLButtonElement>(
      '.canvas-create__footer .canvas-create__upload'
    )!;
    const labels = (section: string) => [...document.querySelectorAll(`.canvas-create__materials [data-section="${section}"] .canvas-create__label`)].map(label => label.textContent);
    expect(labels("canvas-2d")).toEqual(["新建文本", "新建图片", "新建视频", "新建音频", "新建节点组"]);
    expect(labels("shared")).toEqual(["新建镜头"]);
    expect(labels("scene-3d")).toEqual(["新建3D 模型", "新建导演区"]);
    expect(labels("creation-tools")).toEqual(["新建扩展素材"]);
    const badges = [...document.querySelectorAll(".canvas-create__agent-badge")];
    expect(badges.map(badge => [badge.closest("button")?.querySelector(".canvas-create__label")?.textContent, badge.textContent])).toEqual([
      ["新建节点组", "Agent 编排"],
      ["新建3D 模型", "Agent 生成"],
      ["新建导演区", "Agent 编排"]
    ]);
    expect(action.title).toBe("上传素材…");
    expect(action.querySelector("svg")).not.toBeNull();
    expect(action.textContent).toBe("上传素材…");
    expect(document.querySelector('.canvas-create__materials [data-section="other"]')).toBeNull();
    await act(async () => action.click());
    expect(selectItem).toHaveBeenCalledWith("upload");
    await act(async () => document.querySelector<HTMLButtonElement>('[data-section="creation-tools"] button')!.click());
    expect(selectItem).toHaveBeenLastCalledWith("insert-template:custom");
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
    expect(classes[3]).toContain("lucide-music");
    expect(classes[4]).toContain("lucide-box");
  });
  it("does not render a filter input and never executes on Enter", async () => {
    await render();
    expect(document.querySelector("input")).toBeNull();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })));
    expect(mocks.services.canvasEdit.record).not.toHaveBeenCalled();
  });
  it("footer keeps the upload action and its disabled reason", async () => {
    await render(true, [
      { id: "insert:text", label: "文本", section: "basic-material" },
      { id: "insert-scope:camera", label: "镜头", section: "basic-material" },
      { id: "upload", label: "上传…", section: "other", disabled: true, reason: "当前画布只读" }
    ]);
    const upload = document.querySelector<HTMLButtonElement>(".canvas-create__footer .canvas-create__upload")!;
    expect(upload.disabled).toBe(true);
    expect(upload.title).toBe("当前画布只读");
    await act(async () => upload.click());
    expect(selectItem).not.toHaveBeenCalledWith("upload");
    expect(document.querySelectorAll(".canvas-create__grid button")).toHaveLength(2);
  });
  it("no longer offers the group creation entry", async () => {
    await render();
    expect(document.querySelector(".canvas-create__ai-entry")).toBeNull();
  });
});
