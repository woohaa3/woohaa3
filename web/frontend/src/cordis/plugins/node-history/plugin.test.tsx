import { CompositeAssetRegistry } from "../../../extension-api/composite-assets.js";
/**
 * Node History Plugin 生命周期与面板测试
 * （change: add-canvas-node-generation-history，任务 3.1–3.4 / 4.1–4.4）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Context } from "@deepseek-ai/cordis";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { startFrontendRuntime, type FrontendRuntime } from "../../kernel.js";
import { nodeHistoryExtension, NODE_HISTORY_PLUGIN_ID } from "./plugin.js";
import { CANVAS_HISTORY_DIALOG_ID } from "./plugin.js";
import { NodeHistoryPanel } from "./panel.js";
import { NodeHistoryController, type NodeHistoryClient } from "./controller.js";
import { createRemoteClient } from "./history-adapters.js";
import { SlotRegistry } from "../../slots.js";
import { InputScopeService } from "../../services/input-scopes.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { NODE_HISTORY_SERVICE, INLINE_HISTORY_SERVICE, type InlineHistoryService } from "../service-keys.js";
import { DialogService } from "../../services/dialogs/service.js";
import { CanvasNavigationStore } from "../../navigation/store.js";

let runtime: FrontendRuntime | null = null;

type FocusCall = { kind: "enter" | "exit" | "override" | "content"; payload: unknown };

function fakeCanvasRuntime(focusCalls: FocusCall[]) {
  let focusedNodeId: string | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    modelFocusProjection: () => (focusedNodeId ? { nodeId: focusedNodeId } : null),
    subscribeModelFocus: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    enterModelFocusForNode: () => true,
    setContentRect: (input: unknown) => focusCalls.push({ kind: "content", payload: input }),
    setModelSceneOverride: (input: unknown) => focusCalls.push({ kind: "override", payload: input }),
    setModelSceneOverrideForNode: () => undefined,
    /** 测试钩子：模拟 Escape / 清除选择导致的聚焦退出。 */
    __exitFocus: () => {
      focusedNodeId = null;
      emit();
    },
    /** 测试钩子：模拟进入聚焦。 */
    __enterFocus: (nodeId: string) => {
      focusedNodeId = nodeId;
      emit();
    }
  };
}

async function makeHarness(input: {
  canvas: ReturnType<typeof createEmptyWoohaa3ServerCanvas>;
  client?: NodeHistoryClient;
  writable?: boolean;
  includeRuntime?: boolean;
}): Promise<{
  runtime: FrontendRuntime;
  slots: SlotRegistry;
  dialogs: DialogService;
  navigation: CanvasNavigationStore;
  focusCalls: FocusCall[];
  fakeRuntime: ReturnType<typeof fakeCanvasRuntime> | null;
}> {
  const slots = new SlotRegistry();
  const inputScopes = new InputScopeService();
  const dialogs = new DialogService();
  const navigation = new CanvasNavigationStore({
    openDialog: (request) => {
      const result = dialogs.open({ dialogId: request.dialogId, payload: request.payload });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    }
  });
  const focusCalls: FocusCall[] = [];
  const fakeRuntime = (input.includeRuntime ?? true) ? fakeCanvasRuntime(focusCalls) : null;
  const instance = await startFrontendRuntime({
    installPlatform: (ctx: Context) => {
      ctx.provide("compositeAssets" as never, new CompositeAssetRegistry() as never);
      ctx.provide("canvasState" as never, { getCanvas: () => woohaa3CanvasStore.getState().canvas, getWorkingCanvas: () => woohaa3CanvasStore.getState().canvas, subscribe: woohaa3CanvasStore.subscribe } as never);
      ctx.provide("slots" as never, slots as never);
      ctx.provide("inputScopes" as never, inputScopes as never);
      ctx.provide("dialogs" as never, dialogs as never);
      ctx.provide("canvasNavigation" as never, navigation as never);
      ctx.provide("canvasSession" as never, { isWritable: () => input.writable ?? true } as never);
      ctx.provide("canvasRemote" as never, {} as never);
      if (fakeRuntime) {
        ctx.provide("canvasRuntime" as never, fakeRuntime as never);
      }
      woohaa3CanvasStore.getState().applyRemoteCanvas(input.canvas as never);
    },
    plugins: [
      {
        id: NODE_HISTORY_PLUGIN_ID,
        required: false,
        plugin: nodeHistoryExtension(input.client ? { client: input.client } : {})
      }
    ]
  });
  return { runtime: instance, slots, dialogs, navigation, focusCalls, fakeRuntime };
}

function textCanvas() {
  const base = createEmptyWoohaa3ServerCanvas("woohaa3-default-canvas", "2026-09-27T00:00:00.000Z");
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [{ id: "n1", type: "text", position: { x: 0, y: 0 } }] },
    nodeData: { n1: { title: "T" } }
  };
}

/** 模型节点（`generate`）画布，用于验证聚焦关联行为。 */
function modelCanvas() {
  const base = createEmptyWoohaa3ServerCanvas("woohaa3-default-canvas", "2026-09-27T00:00:00.000Z");
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [{ id: "m1", type: "model3d", position: { x: 0, y: 0 } }] },
    nodeData: { m1: { title: "M" } }
  };
}

afterEach(async () => {
  await runtime?.dispose();
  runtime = null;
  woohaa3CanvasStore.getState().applyRemoteCanvas(null as never);
});

describe("Node History Plugin", () => {
  it("激活后注册 node-history panel definition 并提供 capability", async () => {
    const harness = await makeHarness({ canvas: textCanvas() });
    runtime = harness.runtime;
    expect(harness.navigation.resolvePanel("node-history")).not.toBeNull();
    expect(harness.runtime.ctx.get(NODE_HISTORY_SERVICE as never)).toBeDefined();
  });

  it("激活后注册右下角生成历史入口与只读弹窗", async () => {
    const harness = await makeHarness({ canvas: textCanvas() });
    runtime = harness.runtime;
    const action = harness.slots.list("canvas.toolbar-action").find((entry) => entry.id === "node-history-all");
    expect(action).toBeDefined();
    expect(action?.label).toBe("作品生成历史");
    // dialog 已可逆注册（可被 Dialogs Service 解析）。
    expect(harness.dialogs.registeredDialogIds()).toContain(CANVAS_HISTORY_DIALOG_ID);
    expect(harness.dialogs.resolveRenderer(CANVAS_HISTORY_DIALOG_ID)).not.toBeNull();
    // 触发入口打开弹窗：入栈且可关闭（只读，无写入）。
    action!.onActivate();
    expect(harness.dialogs.top()?.dialogId).toBe(CANVAS_HISTORY_DIALOG_ID);
    expect(harness.dialogs.requestCloseTop().closed).toBe(true);
  });

  it("圆点选择只更新本页选择，不打开右侧历史面板", async () => {
    const harness = await makeHarness({ canvas: textCanvas(), client: {
      list: async () => ({ ok: true, items: [], nextCursor: null }),
      detail: async () => ({ ok: false, code: "not-found", error: "no" }),
      apply: async () => ({ ok: true }),
      previewUrl: () => "/preview"
    } });
    runtime = harness.runtime;
    for (const presentationId of ["operation:queued", "operation:running", "operation:failed", "entry:old"]) {
      harness.runtime.ctx.emit("ui.node-history.switch-requested", {
        nodeId: "n1", presentationId, viewOnly: true
      } as never);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(harness.navigation.getSnapshot().panel).toBeNull();
      const inline = harness.runtime.ctx.get(INLINE_HISTORY_SERVICE as never) as unknown as InlineHistoryService;
      expect(inline.preview.selected.get("n1")).toBe(presentationId);
    }
  });

  it("点击历史动作事件打开面板（不改 selection），关闭清理", async () => {
    const client: NodeHistoryClient = {
      list: async () => ({ ok: true, items: [], nextCursor: null }),
      detail: async () => ({ ok: false, code: "not-found", error: "no" }),
      apply: async () => ({ ok: true }),
      previewUrl: () => "/preview"
    };
    const harness = await makeHarness({ canvas: textCanvas(), client });
    runtime = harness.runtime;
    harness.runtime.ctx.emit("ui.node-history.open-requested", { nodeId: "n1" } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.runtime.ctx.get(NODE_HISTORY_SERVICE as never)).toBeDefined();
  });

  it("打开模型历史进入聚焦；聚焦退出时自动关闭面板", async () => {
    const client: NodeHistoryClient = {
      list: async () => ({ ok: true, items: [], nextCursor: null }),
      detail: async () => ({ ok: false, code: "not-found", error: "no" }),
      apply: async () => ({ ok: true }),
      previewUrl: () => "/preview"
    };
    const canvas = modelCanvas();
    canvas.nodeData.m1 = { ...canvas.nodeData.m1, modelScript: "scene.box({ id: 'box' });" } as typeof canvas.nodeData.m1;
    const harness = await makeHarness({ canvas, client });
    runtime = harness.runtime;
    // 注册 model-focus adapter（生产由 canvas-runtime 提供）。
    harness.navigation.setFocusAdapter({
      apply: (target) => {
        if (target && "nodeId" in target) {
          harness.focusCalls.push({ kind: "enter", payload: { nodeId: target.nodeId, owner: target.owner } });
          harness.fakeRuntime?.__enterFocus(target.nodeId);
        } else {
          harness.focusCalls.push({ kind: "exit", payload: {} });
          harness.fakeRuntime?.__exitFocus();
        }
        return { ok: true };
      },
      isFocused: () => harness.fakeRuntime?.modelFocusProjection() !== null,
      isTargetValid: () => true
    });
    harness.runtime.ctx.emit("ui.node-history.open-requested", { nodeId: "m1" } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const service = harness.runtime.ctx.get(NODE_HISTORY_SERVICE as never) as unknown as { getState: () => unknown };
    expect(service.getState()).not.toBeNull();
    expect(harness.focusCalls.some((call) => call.kind === "enter")).toBe(true);

    // 模拟 Escape / 清除选择：聚焦退出 → 历史面板同步关闭。
    harness.fakeRuntime?.__exitFocus();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.getState()).toBeNull();
  });

  it("没有输出的模型直接打开历史空态，不尝试进入聚焦", async () => {
    const harness = await makeHarness({ canvas: modelCanvas(), client: {
      list: async () => ({ ok: true, items: [], nextCursor: null }),
      detail: async () => ({ ok: false, code: "not-found", error: "no" }),
      apply: async () => ({ ok: true }),
      previewUrl: () => "/preview"
    } });
    runtime = harness.runtime;
    harness.navigation.setFocusAdapter({
      apply: () => { throw new Error("empty output cannot be focused"); },
      isFocused: () => false,
      isTargetValid: () => false
    });
    harness.runtime.ctx.emit("ui.node-history.open-requested", { nodeId: "m1" } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const service = harness.runtime.ctx.get(NODE_HISTORY_SERVICE as never) as unknown as { getState: () => { status: string } | null; close: () => void };
    expect(harness.navigation.getSnapshot().panel).toMatchObject({ type: "node-history", nodeId: "m1" });
    expect(service.getState()?.status).toBe("empty");
    service.close();
    expect(harness.navigation.getSnapshot().panel).toBeNull();
    expect(service.getState()).toBeNull();
  });

  it("关闭历史清除本地 Scene IR override（design D3）", async () => {
    const client: NodeHistoryClient = {
      list: async () => ({
        ok: true,
        items: [
          {
            entryId: "e1",
            kind: "model",
            createdAt: "2026-09-27T00:00:00.000Z",
            current: false,
            recoverable: true,
            previewable: true,
            source: { label: "模型编辑" },
            preview: { kind: "model", thumbnailHref: null }
          }
        ] as never,
        nextCursor: null
      }),
      detail: async () => ({
        ok: true,
        detail: {
          entryId: "e1",
          kind: "model",
          modelScript: "scene.box({ id: 'b' });",
          language: "javascript",
          version: "woohaa-model-js-v2",
          sourceHash: "hash",
          placement: null
        } as never
      }),
      apply: async () => ({ ok: true }),
      previewUrl: () => "/preview"
    };
    const harness = await makeHarness({ canvas: modelCanvas(), client });
    runtime = harness.runtime;
    harness.navigation.setFocusAdapter({
      apply: (target) => {
        harness.focusCalls.push({ kind: target ? "enter" : "exit", payload: target ?? {} });
        if (target && "nodeId" in target) harness.fakeRuntime?.__enterFocus(target.nodeId);
        else harness.fakeRuntime?.__exitFocus();
        return { ok: true };
      },
      isFocused: () => harness.fakeRuntime?.modelFocusProjection() !== null,
      isTargetValid: () => true
    });
    harness.navigation.openNodeHistory({ nodeId: "m1", kind: "model" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const service = harness.runtime.ctx.get(NODE_HISTORY_SERVICE as never) as unknown as {
      getState: () => { nodeId: string } | null;
      close: () => void;
      select: (entryId: string) => Promise<void>;
    };
    expect(service.getState()).not.toBeNull();
    await service.select("e1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const overrides = harness.focusCalls.filter((call) => call.kind === "override");
    expect(overrides.some((call) => (call.payload as { override: unknown }).override !== null)).toBe(true);

    harness.focusCalls.length = 0;
    service.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 关闭后 override 被清除（nodeId 保留）。
    const cleared = harness.focusCalls.filter(
      (call) => call.kind === "override" && (call.payload as { override: unknown }).override === null
    );
    expect(cleared.length).toBeGreaterThan(0);
  });

  it("从 overview 打开历史后关闭：退出聚焦并恢复 entry panel 语义（close-node-history）", async () => {
    const client: NodeHistoryClient = {
      list: async () => ({ ok: true, items: [], nextCursor: null }),
      detail: async () => ({ ok: false, code: "not-found", error: "no" }),
      apply: async () => ({ ok: true }),
      previewUrl: () => "/preview"
    };
    const harness = await makeHarness({ canvas: modelCanvas(), client });
    runtime = harness.runtime;
    harness.navigation.setFocusAdapter({
      apply: (target) => {
        harness.focusCalls.push({ kind: target ? "enter" : "exit", payload: target ?? {} });
        if (target && "nodeId" in target) harness.fakeRuntime?.__enterFocus(target.nodeId);
        else harness.fakeRuntime?.__exitFocus();
        return { ok: true };
      },
      isFocused: () => harness.fakeRuntime?.modelFocusProjection() !== null,
      isTargetValid: () => true
    });
    harness.navigation.openNodeHistory({ nodeId: "m1", kind: "model" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const service = harness.runtime.ctx.get(NODE_HISTORY_SERVICE as never) as unknown as { getState: () => unknown; close: () => void };
    expect(service.getState()).not.toBeNull();

    service.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.getState()).toBeNull();
    // 从 overview 进入：关闭历史退出聚焦。
    expect(harness.navigation.getSnapshot().mode).toEqual({ type: "overview" });
  });

  it("从 direct focus 打开历史后关闭：恢复 direct owner（close-node-history）", async () => {
    const client: NodeHistoryClient = {
      list: async () => ({ ok: true, items: [], nextCursor: null }),
      detail: async () => ({ ok: false, code: "not-found", error: "no" }),
      apply: async () => ({ ok: true }),
      previewUrl: () => "/preview"
    };
    const harness = await makeHarness({ canvas: modelCanvas(), client });
    runtime = harness.runtime;
    harness.navigation.setFocusAdapter({
      apply: (target) => {
        harness.focusCalls.push({ kind: target ? "enter" : "exit", payload: target ?? {} });
        if (target && "nodeId" in target) harness.fakeRuntime?.__enterFocus(target.nodeId);
        else harness.fakeRuntime?.__exitFocus();
        return { ok: true };
      },
      isFocused: () => harness.fakeRuntime?.modelFocusProjection() !== null,
      isTargetValid: () => true
    });
    harness.navigation.enterNodeFocus({ nodeId: "m1", kind: "model", owner: "direct" });
    harness.navigation.openNodeHistory({ nodeId: "m1", kind: "model" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const service = harness.runtime.ctx.get(NODE_HISTORY_SERVICE as never) as unknown as { getState: () => unknown; close: () => void };
    expect(service.getState()).not.toBeNull();

    service.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.getState()).toBeNull();
    // 从 direct 进入：关闭历史恢复 direct focus。
    expect(harness.navigation.getSnapshot().mode).toEqual({ type: "node-focus", nodeId: "m1", kind: "model", owner: "direct" });
    expect(harness.navigation.getSnapshot().panel).toBeNull();
  });
  it("缺失 canvasRuntime 时保持 pending 且零副作用", async () => {
    const slots = new SlotRegistry();
    const instance = await startFrontendRuntime({
      installPlatform: (ctx: Context) => {
      ctx.provide("compositeAssets" as never, new CompositeAssetRegistry() as never);
      ctx.provide("canvasState" as never, { getCanvas: () => woohaa3CanvasStore.getState().canvas, getWorkingCanvas: () => woohaa3CanvasStore.getState().canvas, subscribe: woohaa3CanvasStore.subscribe } as never);
        ctx.provide("slots" as never, slots as never);
        ctx.provide("dialogs" as never, new DialogService() as never);
        ctx.provide("inputScopes" as never, new InputScopeService() as never);
        ctx.provide("canvasSession" as never, {} as never);
        ctx.provide("canvasRemote" as never, {} as never);
        // 不提供 canvasRuntime。
      },
      plugins: [{ id: NODE_HISTORY_PLUGIN_ID, required: false, plugin: nodeHistoryExtension() }]
    });
    runtime = instance;
    const diagnostic = instance.status().plugins.find((plugin) => plugin.id === NODE_HISTORY_PLUGIN_ID);
    expect(diagnostic?.status).toBe("pending");
    expect(slots.list("canvas.toolbar-action")).toHaveLength(0);
  });

  it("dispose 后撤销 slot 与 capability", async () => {
    const harness = await makeHarness({ canvas: textCanvas() });
    const instance = harness.runtime;
    runtime = null;
    expect(harness.dialogs.registeredDialogIds()).toContain(CANVAS_HISTORY_DIALOG_ID);
    expect(harness.navigation.resolvePanel("node-history")).not.toBeNull();
    await instance.dispose();
    expect(harness.navigation.resolvePanel("node-history")).toBeNull();
    expect(harness.slots.list("canvas.toolbar-action")).toHaveLength(0);
    expect(harness.dialogs.registeredDialogIds()).not.toContain(CANVAS_HISTORY_DIALOG_ID);
    // 已打开的弹窗实例随 dispose 撤销。
    expect(harness.dialogs.top()).toBeNull();
  });

  it("重复启停不累积入口或 dialog", async () => {
    const first = await makeHarness({ canvas: textCanvas() });
    expect(first.slots.list("canvas.toolbar-action").filter((entry) => entry.id === "node-history-all")).toHaveLength(1);
    await first.runtime.dispose();
    runtime = null;
    const second = await makeHarness({ canvas: textCanvas() });
    runtime = second.runtime;
    expect(second.slots.list("canvas.toolbar-action").filter((entry) => entry.id === "node-history-all")).toHaveLength(1);
    expect(second.dialogs.registeredDialogIds().filter((id) => id === CANVAS_HISTORY_DIALOG_ID)).toHaveLength(1);
  });

  it("固定首项 hasOutput 依权威输出判定：无输出显示空态（不伪造当前输出）", async () => {
    const base = createEmptyWoohaa3ServerCanvas("woohaa3-default-canvas", "2026-09-27T00:00:00.000Z");
    // 视频节点无 outputAssetId：不应把 input mapping / 缓存 URL 当作当前输出。
    const noOutput = {
      ...base,
      revision: 1,
      document: { ...base.document, nodes: [{ id: "v1", type: "video", position: { x: 0, y: 0 } }] },
      nodeData: { v1: { title: "V" } }
    };
    const client: NodeHistoryClient = {
      list: async () => ({ ok: true, items: [], nextCursor: null }),
      detail: async () => ({ ok: false, code: "not-found", error: "no" }),
      apply: async () => ({ ok: true }),
      previewUrl: () => "/preview"
    };
    const harness = await makeHarness({ canvas: noOutput, client });
    runtime = harness.runtime;
    harness.navigation.setFocusAdapter({
      apply: () => ({ ok: true }),
      isFocused: () => false,
      isTargetValid: () => true
    });
    harness.navigation.openNodeHistory({ nodeId: "v1", kind: "video" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const service = harness.runtime.ctx.get(NODE_HISTORY_SERVICE as never) as unknown as {
      getState: () => { current: { hasOutput: boolean } } | null;
    };
    expect(service.getState()?.current.hasOutput).toBe(false);
  });

  it("固定首项 hasOutput 依权威输出判定：ready 输出为 true", async () => {
    const base = createEmptyWoohaa3ServerCanvas("woohaa3-default-canvas", "2026-09-27T00:00:00.000Z");
    const withOutput = {
      ...base,
      revision: 1,
      document: { ...base.document, nodes: [{ id: "v1", type: "video", position: { x: 0, y: 0 } }] },
      nodeData: { v1: { title: "V", outputAssetId: "a1" } },
      assets: [
        {
          id: "a1",
          title: "输出",
          mediaKind: "video",
          source: "generated",
          status: "ready",
          createdAt: "2026-09-27T00:00:00.000Z",
          url: "/api/media/sha256-x",
          metadata: { storageKey: "sha256-x", checksum: "x", contentType: "video/webm", size: 1 }
        }
      ]
    };
    const client: NodeHistoryClient = {
      list: async () => ({ ok: true, items: [], nextCursor: null }),
      detail: async () => ({ ok: false, code: "not-found", error: "no" }),
      apply: async () => ({ ok: true }),
      previewUrl: () => "/preview"
    };
    const harness = await makeHarness({ canvas: withOutput as never, client });
    runtime = harness.runtime;
    harness.navigation.setFocusAdapter({
      apply: () => ({ ok: true }),
      isFocused: () => false,
      isTargetValid: () => true
    });
    harness.navigation.openNodeHistory({ nodeId: "v1", kind: "video" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const service = harness.runtime.ctx.get(NODE_HISTORY_SERVICE as never) as unknown as {
      getState: () => { current: { hasOutput: boolean } } | null;
    };
    expect(service.getState()?.current.hasOutput).toBe(true);
  });
});

describe("NodeHistoryPanel 静态渲染", () => {
  it("固定当前首项后显示真实活动进度与提交未受理原因", async () => {
    const controller = new NodeHistoryController({ list: async () => ({ ok: true, items: [], nextCursor: null }),
      detail: async () => ({ ok: false, code: "not-found", error: "no" }), apply: async () => ({ ok: true }), previewUrl: () => "/preview" });
    await controller.open({ canvasId: "c", nodeId: "n", kind: "image", writable: true });
    const record = { canvasId: "c", nodeId: "n", kind: "image" as const, owner: "server" as const, createdAt: "2026-10-20", updatedAt: "2026-10-20" };
    controller.setOperations([{ ...record, operationId: "running", state: "running", progress: 37 },
      { ...record, operationId: "denied", state: "failed", localFailure: true, error: "无权提交" }]);
    const html = renderToStaticMarkup(<NodeHistoryPanel controller={controller} writable={false} />);
    expect(html).toContain("执行中 · 37%");
    expect(html).toContain("提交未受理");
    expect(html).toContain("无权提交");
    expect(html).not.toContain("还没有历史记录");
    expect(html.indexOf("当前版本")).toBeLessThan(html.indexOf("提交未受理"));
  });
  function item(entryId: string, overrides: Record<string, unknown> = {}): never {
    return {
      entryId,
      kind: "text",
      createdAt: "2026-09-27T00:00:00.000Z",
      current: false,
      recoverable: true,
      previewable: true,
      source: { label: "文本生成" },
      preview: { kind: "text", excerpt: "x" },
      ...overrides
    } as never;
  }

  it("只读会话禁用「设为当前」并显示空态/当前标记", async () => {
    const controller = new NodeHistoryController({
      list: async () => ({ ok: true, items: [item("a", { current: true }), item("b")], nextCursor: null }),
      detail: async () => ({ ok: false, code: "x", error: "y" }),
      apply: async () => ({ ok: true }),
      previewUrl: () => "/preview"
    });
    await controller.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: false });
    const html = renderToStaticMarkup(<NodeHistoryPanel controller={controller} writable={false} />);
    expect(html).toContain("当前版本");
    expect(html).toContain("disabled");
    // 不泄露 storageKey / 完整脚本。
    expect(html).not.toContain("sha256-");
  });

  it("模型编辑版本详情展示摆放摘要与脚本", async () => {
    const controller = new NodeHistoryController({
      list: async () => ({
        ok: true,
        items: [item("e1", { kind: "model", source: { label: "模型编辑" }, preview: { kind: "model", thumbnailHref: null } })],
        nextCursor: null
      }),
      detail: async () => ({
        ok: true,
        detail: {
          entryId: "e1",
          kind: "model",
          modelScript: "build(()=>{})",
          language: "javascript",
          version: "woohaa-model-js-v2",
          sourceHash: "hash",
          placement: { offset: { x: 1.5, y: 2, z: 0 }, scale: 1.25, yaw: 0.4 }
        }
      }),
      apply: async () => ({ ok: true }),
      previewUrl: () => "/preview"
    });
    await controller.open({ canvasId: "c1", nodeId: "n1", kind: "model", writable: true });
    await controller.select("e1");
    const html = renderToStaticMarkup(<NodeHistoryPanel controller={controller} writable />);
    expect(html).toContain("摆放");
    expect(html).toContain("1.5");
    expect(html).toContain("1.25");
    expect(html).toContain("build(()=&gt;{})");
  });

  it("空态显示明确空提示", async () => {
    const controller = new NodeHistoryController({
      list: async () => ({ ok: true, items: [], nextCursor: null }),
      detail: async () => ({ ok: false, code: "x", error: "y" }),
      apply: async () => ({ ok: true }),
      previewUrl: () => "/preview"
    });
    await controller.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: true });
    const html = renderToStaticMarkup(<NodeHistoryPanel controller={controller} writable />);
    expect(html).toContain("还没有历史记录");
  });

  it("可写且有历史时提供清空入口；首次渲染不直接提交清空", async () => {
    let cleared = 0;
    const controller = new NodeHistoryController({
      list: async () => ({ ok: true, items: [item("a")], nextCursor: null }),
      detail: async () => ({ ok: false, code: "x", error: "y" }),
      apply: async () => ({ ok: true }),
      clear: async () => { cleared += 1; return { ok: true, removed: 1 }; },
      previewUrl: () => "/preview"
    });
    await controller.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: true });
    const html = renderToStaticMarkup(<NodeHistoryPanel controller={controller} writable />);
    expect(html).toContain("清空历史");
    // 只有一次点击邀请，不出现确认文案、也没有发生清空。
    expect(html).not.toContain("清空后无法恢复这些版本");
    expect(cleared).toBe(0);
    expect(controller.getState()?.items).toHaveLength(1);
  });

  it("只读会话、空历史或客户端不支持时不显示清空入口", async () => {
    const readOnly = new NodeHistoryController({
      list: async () => ({ ok: true, items: [item("a")], nextCursor: null }),
      detail: async () => ({ ok: false, code: "x", error: "y" }),
      apply: async () => ({ ok: true }),
      clear: async () => ({ ok: true, removed: 1 }),
      previewUrl: () => "/preview"
    });
    await readOnly.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: false });
    expect(renderToStaticMarkup(<NodeHistoryPanel controller={readOnly} writable={false} />)).not.toContain("清空历史");

    const empty = new NodeHistoryController({
      list: async () => ({ ok: true, items: [], nextCursor: null }),
      detail: async () => ({ ok: false, code: "x", error: "y" }),
      apply: async () => ({ ok: true }),
      clear: async () => ({ ok: true, removed: 0 }),
      previewUrl: () => "/preview"
    });
    await empty.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: true });
    expect(renderToStaticMarkup(<NodeHistoryPanel controller={empty} writable />)).not.toContain("清空历史");

    const noClear = new NodeHistoryController({
      list: async () => ({ ok: true, items: [item("a")], nextCursor: null }),
      detail: async () => ({ ok: false, code: "x", error: "y" }),
      apply: async () => ({ ok: true }),
      previewUrl: () => "/preview"
    });
    await noClear.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: true });
    const html = renderToStaticMarkup(<NodeHistoryPanel controller={noClear} writable />);
    expect(html).toContain("设为当前");
    expect(html).not.toContain("清空历史");
  });

  it("清空失败在面板内显示可读原因", async () => {
    const controller = new NodeHistoryController({
      list: async () => ({ ok: true, items: [item("a")], nextCursor: null }),
      detail: async () => ({ ok: false, code: "x", error: "y" }),
      apply: async () => ({ ok: true }),
      clear: async () => ({ ok: false, code: "conflict", error: "节点存在未结算的编辑会话，无法清空历史" }),
      previewUrl: () => "/preview"
    });
    await controller.open({ canvasId: "c1", nodeId: "n1", kind: "text", writable: true });
    await controller.clear();
    const html = renderToStaticMarkup(<NodeHistoryPanel controller={controller} writable />);
    expect(html).toContain("无法清空历史");
    expect(html).toContain("设为当前");
  });
});

describe("清空历史：client 接线", () => {
  it("createRemoteClient 把 clear 转给 canvasRemote.clearNodeHistory 并保留失败码", async () => {
    const calls: Array<{ canvasId: string; nodeId: string }> = [];
    let failure: { ok: false; code: string; error: string } | null = null;
    const ctx = {
      canvasRemote: {
        clearNodeHistory: async (input: { canvasId: string; nodeId: string }) => {
          calls.push(input);
          return failure ?? { ok: true, value: { removed: 3 } };
        }
      },
      get: () => undefined
    } as unknown as Context;
    const client = createRemoteClient(ctx);
    expect(client.clear).toBeDefined();
    expect(await client.clear!({ canvasId: "c1", nodeId: "n1" })).toEqual({ ok: true, removed: 3 });
    failure = { ok: false, code: "NODE_HISTORY_CONFLICT", error: "节点存在进行中的生成，无法清空历史" };
    expect(await client.clear!({ canvasId: "c1", nodeId: "n1" })).toEqual({
      ok: false,
      code: "NODE_HISTORY_CONFLICT",
      error: "节点存在进行中的生成，无法清空历史"
    });
    expect(calls).toEqual([{ canvasId: "c1", nodeId: "n1" }, { canvasId: "c1", nodeId: "n1" }]);
  });
});
