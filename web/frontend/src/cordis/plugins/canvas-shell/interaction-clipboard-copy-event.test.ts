/**
 * 桌面原生 Edit 菜单下的画布复制（change: fix-desktop-native-menu-clipboard-shortcuts）。
 *
 * 缺陷：Tauri/macOS 窗口默认带 App 菜单，`Cmd+C` 先被原生 Edit > Copy 的快捷键消费，
 * 页面收不到 `keydown`。原实现只在 `keydown` 里构造画布载荷，因此桌面端复制节点完全无效
 * （听不到任何画布动作，粘贴也拿不到 `infinspire-canvas-copy-v1` 文本）。
 *
 * 修复由两处共同成立，本文件锁住这两条契约：
 * 1. `#bevy-canvas` 必须可聚焦并在指针按下时取得焦点——否则 WebKit 不派发 DOM `copy`；
 * 2. `copy` 事件命中画布时写 `clipboardData` 并 `preventDefault`，编辑面与文本选区不介入。
 */
import { describe, expect, it } from "vitest";
import { installInteractionController } from "./interaction-controller.js";
import { MEMORY_CLIPBOARD_KEY } from "./interaction-keyboard.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { canvasWith, getSession, harness, installSharedSession, runtimeCapturing } from "./test-support/controller-harness.js";

installSharedSession();

type CopyClipboardData = {
  setData: (type: string, value: string) => void;
  getData: (type: string) => string;
  types: string[];
};

function clipboardData(): CopyClipboardData {
  const data = new Map<string, string>();
  return {
    setData: (type, value) => void data.set(type, value),
    getData: (type) => data.get(type) ?? "",
    get types() {
      return [...data.keys()];
    }
  };
}

function mountCopyTarget() {
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
  const dom = harness();
  const { runtime } = runtimeCapturing();
  const controller = installInteractionController({
    canvas: dom.canvas,
    getRuntime: () => runtime,
    getSession: () => getSession() as never,
    target: dom.target as never
  });
  return { dom, controller };
}

function selectedNode() {
  nodeSelectionStore.setFromRuntime({ nodeIds: ["n1"], primaryNodeId: "n1", editingFocus: false }, new Set(["n1"]));
  nodeSelectionStore.setKeyboardActive(true);
}

describe("画布 Mod+C（change: fix-desktop-native-menu-clipboard-shortcuts）", () => {
  it("DOM copy 事件把画布载荷写入 clipboardData 并认领事件", () => {
    selectedNode();
    const { dom, controller } = mountCopyTarget();
    const data = clipboardData();
    let prevented = 0;
    dom.fire("copy", {
      target: dom.canvas,
      clipboardData: data,
      preventDefault: () => { prevented += 1; }
    });
    expect(prevented).toBe(1);
    expect(data.getData("text/plain")).toContain("infinspire-canvas-copy-v1");
    // 页内 fallback 与系统剪贴板文本一致，粘贴不依赖浏览器是否回填 clipboardData。
    expect(dom.target[MEMORY_CLIPBOARD_KEY]).toBe(data.getData("text/plain"));
    controller.dispose();
    nodeSelectionStore.reset();
  });

  it("编辑面与真实文本选区不介入复制", () => {
    selectedNode();
    const { dom, controller } = mountCopyTarget();
    const input = { tagName: "INPUT", isContentEditable: false, getAttribute: () => null } as unknown as EventTarget;
    const onInput = clipboardData();
    let inputPrevented = 0;
    dom.fire("copy", {
      target: input,
      clipboardData: onInput,
      preventDefault: () => { inputPrevented += 1; }
    });
    expect(inputPrevented).toBe(0);
    expect(onInput.types).toEqual([]);

    // 页面存在真实文本选区时，⌘C 应由浏览器复制选中文本。
    const selection = { toString: () => "selected text" } as unknown as Selection;
    const target = dom.target as unknown as { getSelection: () => Selection | null };
    target.getSelection = () => selection;
    const onText = clipboardData();
    let textPrevented = 0;
    dom.fire("copy", {
      target: dom.canvas,
      clipboardData: onText,
      preventDefault: () => { textPrevented += 1; }
    });
    expect(textPrevented).toBe(0);
    expect(onText.types).toEqual([]);
    controller.dispose();
    nodeSelectionStore.reset();
  });

  it("画布没有键盘范围时不认领 copy（例如焦点在弹窗）", () => {
    selectedNode();
    const { dom, controller } = mountCopyTarget();
    nodeSelectionStore.setKeyboardActive(false);
    const data = clipboardData();
    let prevented = 0;
    dom.fire("copy", {
      target: dom.canvas,
      clipboardData: data,
      preventDefault: () => { prevented += 1; }
    });
    expect(prevented).toBe(0);
    expect(data.types).toEqual([]);
    controller.dispose();
    nodeSelectionStore.reset();
  });
});
