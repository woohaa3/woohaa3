/**
 * 宿主默认图片查看器 Plugin 的注册与让位测试（change: default-image-focus-viewer）。
 *
 * 关注的是「扩展缺席也必须能双击看图」与「编辑器装入后必须让位」这一对约束：
 * 同一 focus kind 出现两个工作区贡献会被公共宿主判成歧义（「多个扩展声明了此节点的工作区」）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { startFrontendRuntime, type FrontendRuntime } from "../../kernel.js";
import { SlotRegistry } from "../../slots.js";
import { CanvasNavigationStore } from "../../navigation/store.js";
import { FocusExitCoordinator } from "../../navigation/exit-coordinator.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { imageViewerExtension, IMAGE_VIEWER_PLUGIN_ID } from "./plugin.js";

let runtime: FrontendRuntime | null = null;

const IMAGE_VIEWER_WORKSPACE_ID = "image-viewer-workspace";

function imageCanvas() {
  const base = createEmptyWoohaa3ServerCanvas("canvas-1", "2026-10-28T00:00:00.000Z");
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [{ id: "n1", type: "image", position: { x: 0, y: 0 } }] },
    nodeData: { n1: { title: "海报", outputAssetId: "asset-1" } },
    assets: [{
      id: "asset-1", title: "图片", source: "uploaded", status: "ready", mediaKind: "image",
      createdAt: "2026-10-28T00:00:00.000Z", url: "/api/media/canvas-1/asset-1.png",
      // 就绪资产必须带稳定 storageKey（fix-media-output-readiness：只带地址的「成功」不算就绪）。
      metadata: { storageKey: "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
    }]
  } as never;
}

/** 只装配本插件需要的宿主端口；不带真实渲染器。 */
async function makeHarness() {
  const slots = new SlotRegistry();
  const navigation = new CanvasNavigationStore();
  const focusExit = new FocusExitCoordinator();
  const contentRectListeners = new Set<() => void>();
  const canvasRuntime = {
    controller: () => null,
    focusContentRect: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    subscribeFocusContentRect: (listener: () => void) => {
      contentRectListeners.add(listener);
      return () => contentRectListeners.delete(listener);
    },
    focusTransitionPort: () => ({ run: async () => true, cancel: () => undefined, isActive: () => false }),
    setImageFocus: () => undefined,
    setImageFocusTexture: () => undefined,
    setImageFocusPending: () => undefined,
    registerImageViewportTarget: () => () => undefined
  };
  const instance = await startFrontendRuntime({
    installPlatform: (ctx: Context) => {
      ctx.provide("slots" as never, slots as never);
      ctx.provide("canvasNavigation" as never, navigation as never);
      ctx.provide("focusExit" as never, focusExit as never);
      ctx.provide("canvasRuntime" as never, canvasRuntime as never);
      woohaa3CanvasStore.getState().applyRemoteCanvas(imageCanvas());
    },
    plugins: [{
      id: IMAGE_VIEWER_PLUGIN_ID,
      required: true,
      plugin: imageViewerExtension()
    }]
  });
  return { runtime: instance, slots, navigation };
}

afterEach(async () => {
  await runtime?.dispose();
  runtime = null;
  woohaa3CanvasStore.getState().applyRemoteCanvas(null as never);
});

describe("宿主默认图片聚焦查看器", () => {
  it("注册 kind=image-view 的独占工作区（与编辑器的 kind=image 分开）", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    const workspaces = harness.slots.list("canvas.focus-workspace").filter((entry) => entry.kind === "image-view");
    expect(workspaces.map((entry) => entry.id)).toEqual([IMAGE_VIEWER_WORKSPACE_ID]);
    expect(workspaces[0]?.owner).toBe(IMAGE_VIEWER_PLUGIN_ID);
    expect(workspaces[0]?.exclusive).toBe(true);
  });

  it("编辑器装入后查看器仍在：两者是不同 kind，不再是让位关系", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    // 模拟 PhotoCraft 一类图片编辑器装入（kind=image，与查看器的 image-view 并存）。
    const removeEditor = harness.slots.register("canvas.focus-workspace", {
      id: "photocraft-focus",
      owner: "photocraft",
      kind: "image",
      exclusive: true,
      render: () => null
    });
    expect(harness.slots.list("canvas.focus-workspace").map((entry) => entry.kind).sort())
      .toEqual(["image", "image-view"]);
    removeEditor();
    expect(harness.slots.list("canvas.focus-workspace").map((entry) => entry.id)).toEqual([IMAGE_VIEWER_WORKSPACE_ID]);
  });

  it("工作区不声明静态 layout：底部/面板占位只能由工作区的 useFocusLayout 上报", async () => {
    // 公共宿主的 useFocusLayoutSource 会在工作区 useFocusLayout 之后提交；静态 layout 会把
    // 上报配置覆盖掉（player 归零 → 底部控制条塌成 0 高并压住画面）。video/model editor
    // 同样不写静态 layout（change: default-image-focus-viewer 回归）。
    const harness = await makeHarness();
    runtime = harness.runtime;
    const workspace = harness.slots.list("canvas.focus-workspace")[0];
    expect(workspace?.layout).toBeUndefined();
  });

  it("插件释放时注销工作区与退出协调 participant", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    expect(harness.slots.list("canvas.focus-workspace")).toHaveLength(1);
    await harness.runtime.dispose();
    runtime = null;
    expect(harness.slots.list("canvas.focus-workspace")).toHaveLength(0);
  });
});

describe("节点操作横条「去P图」入口", () => {
  const editAction = (slots: SlotRegistry) => slots.list("canvas.node-action").find((entry) => entry.id === "image-edit-focus");

  it("编辑器缺席时不呈现：点它只会得到只读查看器，与文案不符", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    // 贡献始终在册（这样编辑器热装入后无需重注册），是否呈现由 `describe` 决定。
    const action = editAction(harness.slots);
    expect(action).toBeDefined();
    expect(action!.describe({ nodeId: "n1", nodeType: "image", writable: true })).toBeNull();
  });

  it("编辑器在位时按图片节点呈现，并排在「转 3D」之后", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    const removeEditor = harness.slots.register("canvas.focus-workspace", {
      id: "photocraft-focus", owner: "photocraft", kind: "image", exclusive: true, render: () => null
    });
    const action = editAction(harness.slots);
    expect(action).toBeDefined();
    // 选中「转 3D」的 order 是 20；本动作 21，因此在它右边。
    expect(action!.order).toBeGreaterThan(20);
    const descriptor = action!.describe({ nodeId: "n1", nodeType: "image", writable: false });
    expect(descriptor).toMatchObject({ label: "去P图", icon: "photoshop", enabled: true });
    // 非图片节点、或图片尚未就绪时不呈现。
    expect(action!.describe({ nodeId: "missing", nodeType: "text", writable: true })).toBeNull();
    removeEditor();
    expect(editAction(harness.slots)).toBeDefined(); // 贡献始终在册，是否呈现由 describe 决定
    expect(editAction(harness.slots)!.describe({ nodeId: "n1", nodeType: "image", writable: true })).toBeNull();
  });

  it("激活走与双击同一条进入路径（requestEnterNodeFocus / kind=image）", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    const enter = vi.spyOn(harness.navigation, "requestEnterNodeFocus").mockResolvedValue({ ok: true } as never);
    const removeEditor = harness.slots.register("canvas.focus-workspace", {
      id: "photocraft-focus", owner: "photocraft", kind: "image", exclusive: true, render: () => null
    });
    editAction(harness.slots)!.activate({
      nodeId: "n1", nodeType: "image", writable: true, menu: false, requestSettings: () => undefined
    });
    expect(enter).toHaveBeenCalledWith({ nodeId: "n1", kind: "image", owner: "direct" });
    removeEditor();
  });
});
