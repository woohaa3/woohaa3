/**
 * 宿主默认图片查看器 Plugin 的注册与让位测试（change: default-image-focus-viewer）。
 *
 * 关注的是「扩展缺席也必须能双击看图」与「编辑器装入后必须让位」这一对约束：
 * 同一 focus kind 出现两个工作区贡献会被公共宿主判成歧义（「多个扩展声明了此节点的工作区」）。
 */
import { afterEach, describe, expect, it } from "vitest";
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
      createdAt: "2026-10-28T00:00:00.000Z", url: "/api/media/canvas-1/asset-1.png"
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
  it("没有其他图片工作区时注册 kind=image 的独占工作区", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    const workspaces = harness.slots.list("canvas.focus-workspace").filter((entry) => entry.kind === "image");
    expect(workspaces.map((entry) => entry.id)).toEqual([IMAGE_VIEWER_WORKSPACE_ID]);
    expect(workspaces[0]?.owner).toBe(IMAGE_VIEWER_PLUGIN_ID);
    expect(workspaces[0]?.exclusive).toBe(true);
  });

  it("编辑器扩展装入后让位，卸载后重新接管", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    // 模拟 PhotoCraft 一类图片编辑器装入（同 kind，不同 id）。
    const removeEditor = harness.slots.register("canvas.focus-workspace", {
      id: "photocraft-focus",
      owner: "photocraft",
      kind: "image",
      exclusive: true,
      render: () => null
    });
    expect(harness.slots.list("canvas.focus-workspace").map((entry) => entry.id)).toEqual(["photocraft-focus"]);
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
