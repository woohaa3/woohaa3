/**
 * Space 临时平移闩锁回归
 * （change: fix-space-pan-latch-after-focus-exit）。
 *
 * 症状：从 3D 模型聚焦（其检查器含 AI 提示词 textarea）返回普通画布后，左键点击节点不再
 * 点选，只会平移画布，必须双击别的节点才能恢复。
 *
 * 根因：`spacePressed` 是「按住空格临时平移」的单布尔闩锁，`keydown` 无条件写入、只有
 * 窗口冒泡阶段的 `keyup` 清除。在输入框里打空格会写入，而失焦/切页/浮层吞掉 `keyup`
 * 时永远清不掉；此后 `onPointerDown` 在命中查询之前就把每一次左键按下短路成 pan。
 */
import { describe, expect, it } from "vitest";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { installInteractionController } from "./interaction-controller.js";
import {
  canvasWith,
  getSession,
  harness,
  installSharedSession,
  runtimeCapturing
} from "./test-support/controller-harness.js";
import { focusHarness, modelCenter } from "./test-support/model-focus-harness.js";

installSharedSession();

function setup(options: { isModalActive?: () => boolean; imageFocused?: () => boolean; imagePending?: () => boolean } = {}) {
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 100, y: 100 }]));
  const dom = harness();
  const { runtime } = runtimeCapturing();
  const controller = installInteractionController({
    canvas: dom.canvas,
    getRuntime: () => runtime,
    getSession: () => getSession() as never,
    target: dom.target as never,
    ...(options.isModalActive ? { isModalActive: options.isModalActive } : {}),
    ...(options.imageFocused ? { isImageFocused: options.imageFocused } : {}),
    ...(options.imagePending ? { isImageFocusPending: options.imagePending } : {})
  });
  const selection = (dom.target as unknown as {
    __canvasSelection: () => { nodeIds: string[] };
  }).__canvasSelection;
  return { dom, controller, selection };
}

/** 可编辑面替身：textarea 里的空格是输入字符，不是画布平移。 */
const textarea = () =>
  ({ tagName: "TEXTAREA", isContentEditable: false, getAttribute: () => null }) as unknown as EventTarget;

const spaceDown = (dom: ReturnType<typeof harness>, target: EventTarget | null = null) =>
  dom.fireKey("keydown", { code: "Space", key: " ", target });
const spaceUp = (dom: ReturnType<typeof harness>) =>
  dom.fireKey("keyup", { code: "Space", key: " " });

describe("Space 临时平移不因输入框或丢失 keyup 而闩死", () => {
  it("在输入框里按空格不武装画布平移，随后的左键仍点选节点", () => {
    const { dom, controller, selection } = setup();
    spaceDown(dom, textarea());
    // 输入框里的 keyup 可能被浮层吞掉：这里故意不发 keyup，模拟最坏情况。
    dom.fire("pointerdown", { clientX: 150, clientY: 150 });
    expect(selection().nodeIds).toEqual(["n1"]);
    dom.fire("pointerup", { clientX: 150, clientY: 150 });
    controller.dispose();
  });

  it("普通画布上按住空格仍进入平移，松手后恢复点选", () => {
    const { dom, controller, selection } = setup();
    spaceDown(dom);
    dom.fire("pointerdown", { clientX: 150, clientY: 150 });
    expect(selection().nodeIds).toEqual([]);
    dom.fire("pointerup", { clientX: 150, clientY: 150 });
    spaceUp(dom);
    dom.fire("pointerdown", { clientX: 150, clientY: 150 });
    expect(selection().nodeIds).toEqual(["n1"]);
    dom.fire("pointerup", { clientX: 150, clientY: 150 });
    controller.dispose();
  });

  it("窗口失焦清掉已按下的空格，回来仍能点选", () => {
    const { dom, controller, selection } = setup();
    spaceDown(dom);
    // 失焦（切换应用/窗口）时 keyup 永远到不了页面。
    dom.fire("blur", {});
    dom.fire("pointerdown", { clientX: 150, clientY: 150 });
    expect(selection().nodeIds).toEqual(["n1"]);
    dom.fire("pointerup", { clientX: 150, clientY: 150 });
    controller.dispose();
  });

  it("页面隐藏清掉已按下的空格", () => {
    const { dom, controller, selection } = setup();
    const document = dom.target.document as Record<string, unknown>;
    document.visibilityState = "hidden";
    spaceDown(dom);
    dom.fire("visibilitychange", {});
    document.visibilityState = "visible";
    dom.fire("pointerdown", { clientX: 150, clientY: 150 });
    expect(selection().nodeIds).toEqual(["n1"]);
    dom.fire("pointerup", { clientX: 150, clientY: 150 });
    controller.dispose();
  });

  it("modal 打开时按空格不武装平移", () => {
    let modal = true;
    const { dom, controller, selection } = setup({ isModalActive: () => modal });
    spaceDown(dom);
    modal = false;
    dom.fire("pointerdown", { clientX: 150, clientY: 150 });
    expect(selection().nodeIds).toEqual(["n1"]);
    dom.fire("pointerup", { clientX: 150, clientY: 150 });
    controller.dispose();
  });

  it("图片聚焦尚未接管画面时仍可用空格平移，接管后不再武装", () => {
    let pending = true;
    const { dom, controller, selection } = setup({ imageFocused: () => true, imagePending: () => pending });
    spaceDown(dom);
    dom.fire("pointerdown", { clientX: 150, clientY: 150 });
    expect(selection().nodeIds).toEqual([]);
    dom.fire("pointerup", { clientX: 150, clientY: 150 });
    spaceUp(dom);
    pending = false;
    spaceDown(dom);
    dom.fire("pointerdown", { clientX: 150, clientY: 150 });
    expect(selection().nodeIds).toEqual(["n1"]);
    dom.fire("pointerup", { clientX: 150, clientY: 150 });
    controller.dispose();
  });

  it("Space 释放监听挂在捕获阶段，浮层 stopPropagation 无法吞掉复位", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 100, y: 100 }]));
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const registered: Array<{ type: string; capture: boolean }> = [];
    const add = dom.target.addEventListener as (type: string, handler: unknown, options?: unknown) => void;
    dom.target.addEventListener = ((type: string, handler: unknown, options?: unknown) => {
      if (type === "keyup") registered.push({ type, capture: options === true || (typeof options === "object" && options !== null && (options as { capture?: boolean }).capture === true) });
      add(type, handler, options);
    }) as never;
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });
    // 必须有一个 keyup 监听在捕获阶段：冒泡阶段的会被文本输入层/浮层 stopPropagation 吞掉。
    expect(registered.some((entry) => entry.capture)).toBe(true);
    controller.dispose();
  });
});

describe("聚焦进出门禁释放 Space 平移闩锁", () => {
  it("进入/退出聚焦时清掉已按下的空格，返回画布后左键仍点选节点", () => {
    const h = focusHarness();
    const point = modelCenter(h.target);
    // 在普通画布按住空格进入聚焦（例如聚焦里要继续按空格播放）。
    h.dom.fireKey("keydown", { code: "Space", key: " " });
    h.dom.fire("dblclick", { clientX: point.x, clientY: point.y });
    expect(h.controller.isModelFocused()).toBe(true);
    // 退出聚焦时 keyup 可能丢在覆盖层里：控制器必须自行释放。
    h.controller.applyFocusTarget(null, { preserveSession: false });
    expect(h.controller.isModelFocused()).toBe(false);
    h.dom.fire("pointerdown", { clientX: point.x, clientY: point.y });
    const selection = (h.dom.target as unknown as {
      __canvasSelection: () => { nodeIds: string[] };
    }).__canvasSelection;
    expect(selection().nodeIds).toEqual(["m1"]);
    h.dom.fire("pointerup", { clientX: point.x, clientY: point.y });
    h.controller.dispose();
  });
});
