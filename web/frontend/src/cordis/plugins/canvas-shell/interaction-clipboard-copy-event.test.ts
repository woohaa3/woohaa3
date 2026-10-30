import { applyCanvasCommands } from "../../../../../test-support/managed-shot-commands.js";
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
import { describe, expect, it, vi } from "vitest";
import { canonicalFilmSetFields, createFilmSetSnapshot, type ServerCanvas } from "@woohaa3/contracts";
import { createMediaContentService } from "../../services/media-content.js";
import { parseCanvasCopyPayload } from "./clipboard/payload.js";
import { planCanvasPaste } from "./clipboard/planner.js";
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

function mountCopyTarget(canvas = canvasWith([{ id: "n1", x: 0, y: 0 }]), mediaContent?: ReturnType<typeof createMediaContentService>) {
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const dom = harness();
  const { runtime } = runtimeCapturing();
  const controller = installInteractionController({
    canvas: dom.canvas,
    getRuntime: () => runtime,
    getSession: () => getSession() as never,
    target: dom.target as never,
    mediaContent
  });
  return { dom, controller };
}

function selectedNode() {
  nodeSelectionStore.setFromRuntime({ nodeIds: ["n1"], primaryNodeId: "n1", editingFocus: false }, new Set(["n1"]));
  nodeSelectionStore.setKeyboardActive(true);
}

describe("画布 Mod+C（change: fix-desktop-native-menu-clipboard-shortcuts）", () => {
  it("Delete filters a managed entity from another extension while preserving a mixed ordinary selection", () => {
    const canvas = canvasWith([{ id: "n1", x: 0, y: 0 }, { id: "owner", x: 200, y: 0 }, { id: "ordinary", x: 400, y: 0 }]);
    canvas.nodeData.n1 = { managedBy: { schemaVersion: 1, extensionId: "test", ownerNodeId: "owner", entityId: "entry", lifecycle: "owner-managed" } };
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
    nodeSelectionStore.setFromRuntime({ nodeIds: ["n1", "ordinary"], primaryNodeId: "n1", editingFocus: false }, new Set(["n1", "ordinary", "owner"]));
    nodeSelectionStore.setKeyboardActive(true);
    const dom = harness(), { runtime } = runtimeCapturing();
    const edit = vi.fn(), error = vi.fn();
    const controller = installInteractionController({ canvas: dom.canvas, getRuntime: () => runtime, getSession: () => getSession() as never, target: dom.target as never, onEditCommands: edit, onInteractionError: error });
    dom.fireKey("keydown", { key: "Delete" });
    expect(edit).toHaveBeenCalledWith([{ type: "node.remove", nodeIds: ["ordinary"] }], "删除作品");
    expect(error).toHaveBeenCalledOnce();
    controller.dispose(); nodeSelectionStore.reset();
  });
  it("native copying live media publishes a frozen asset without an interim live payload", async () => {
    selectedNode();
    const canvas = canvasWith([{ id: "n1", x: 0, y: 0 }, { id: "owner", x: 200, y: 0 }]);
    canvas.nodeData.n1 = {
      managedBy: { schemaVersion: 1, extensionId: "test", ownerNodeId: "owner", entityId: "entry", lifecycle: "owner-managed" },
      mediaContent: { providerId: "test.content", schemaVersion: 1, payload: {} }
    };
    const service = createMediaContentService({ canvas: () => canvas, subscribe: () => () => {}, writable: () => false, submit: async () => {} });
    let complete!: () => void;
    const ready = { id: "immutable", mediaKind: "image" as const, status: "ready" as const, source: "generated" as const, title: "Snapshot", createdAt: "2026-10-26", metadata: { storageKey: "sha256-ready" } };
    service.register({ providerId: "test.content", owner: "test", schemaVersions: [1], mediaKinds: ["image"],
      describe: () => ({ mediaKind: "image", sourceIdentity: "one", dependencyNodeIds: ["owner"] }),
      resolvePreview: async () => ready, materialize: async () => ready,
      snapshot: () => new Promise(resolve => { complete = () => resolve(ready); })
    });
    const { dom, controller } = mountCopyTarget(canvas, service);
    const data = clipboardData();
    dom.fire("copy", { target: dom.canvas, clipboardData: data });
    expect(data.getData("text/plain")).toBe("");
    expect(dom.target[MEMORY_CLIPBOARD_KEY]).toBeUndefined();
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    complete();
    await vi.waitFor(() => expect(dom.target[MEMORY_CLIPBOARD_KEY]).toBeTypeOf("string"));
    const copied = parseCanvasCopyPayload(String(dom.target[MEMORY_CLIPBOARD_KEY]));
    expect(copied?.nodeData.n1).toMatchObject({ outputAssetId: "immutable" });
    expect(copied?.nodeData.n1.mediaContent).toBeUndefined();
    expect(copied?.nodeData.n1.managedBy).toBeUndefined();
    expect(copied?.assets).toContainEqual(ready);
    const pasted = planCanvasPaste({ canvas, payload: copied!, anchor: { kind: "point", position: { x: 300, y: 300 } }, viewport: { x: 0, y: 0, zoom: 1 }, createId: () => "independent" });
    expect(pasted).not.toBeNull();
    const applied = applyCanvasCommands(canvas, pasted!.commands);
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw Error(applied.rejection.message);
    expect(applied.canvas.nodeData.independent.outputAssetId).toBe("immutable");
    expect(applyCanvasCommands(applied.canvas, [{ type: "node.remove", nodeIds: ["independent"] }]).ok).toBe(true);
    expect(canvas.nodeData.n1.mediaContent).toBeDefined();
    controller.dispose(); service.dispose(); nodeSelectionStore.reset();
  });

  it("refuses to copy a legacy composite film-set closure", () => {
    selectedNode();
    let canvas: ServerCanvas = canvasWith([{ id: "n1", x: 0, y: 0 }]);
    canvas.document.nodes[0]!.type = "composite-asset";
    canvas.nodeData.n1 = canonicalFilmSetFields(createFilmSetSnapshot({ title: "Film", model: { modelScript: 'scene.box({id:"body"});', modelScriptVersion: "woohaa-model-js-v2" }, motionScript: 'motion.model.rotate("body", {speed:1});', timeline: { duration: 4, loop: false } })) as never;
    const result = applyCanvasCommands(canvas, [{ type: "canvas.setTitle", title: "Film" }]);
    if (!result.ok) throw Error(result.rejection.message);
    canvas = result.canvas;
    // No media service: owner closure copying must not need materialization.
    const { dom, controller } = mountCopyTarget(canvas);
    const data = clipboardData();
    dom.fire("copy", { target: dom.canvas, clipboardData: data });
    expect(data.getData("text/plain")).toBe("");
    expect(dom.target[MEMORY_CLIPBOARD_KEY]).toBeUndefined();
    controller.dispose(); nodeSelectionStore.reset();
  });
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
