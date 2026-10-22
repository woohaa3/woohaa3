/**
 * 真实平台 + 清单集成测试
 * （change: adopt-frontend-cordis-plugin-runtime，design D2/D5/D10）。
 *
 * 用 fake IndexedDB / WebSocket / fetch 启动真实 `installPlatform` + `createCanvasExtensionManifest`，
 * 断言 required 启动完成、dialog/slot 贡献可见、dispose 后归零。
 *
 * @vitest-environment jsdom
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { startFrontendRuntime, startFrontendScope, type FrontendRuntime } from "./kernel.js";
import type { Context } from "@deepseek-ai/cordis";
import { installAppServices, installCanvasPageServices, installExtensionPageServices } from "./install-services.js";
import { createSourceCanvasExtensionManifest } from "./test-support/source-extensions.js";
import { createAppPageRegistry } from "./extension-entry/app-pages.js";
import { createFakeExtensionPageEntry } from "./test-support/app-pages.js";
import { ALERT_DIALOG_ID } from "./services/dialogs/alert-dialog.js";
import { MEDIA_PREVIEW_DIALOG_ID } from "./plugins/media-preview/media-preview.js";
import { PASTE_REPLACE_DIALOG_ID } from "./plugins/paste-import/replace-dialog.js";
import { VIDEO_EDIT_DIALOG_ID, VIDEO_FRAME_CAPTURE_DIALOG_ID } from "./plugins/video-capture/ids.js";
import { CANVAS_HISTORY_DIALOG_ID } from "./plugins/node-history/plugin.js";
import { CANVAS_SWITCHER_DIALOG_ID } from "./plugins/canvas-switcher/chrome.js";
import { GENERATION_TRACE_DIALOG_ID } from "./plugins/task-execution/generation-trace-dialog.js";
import { AGENT_ASSISTANT_DIALOG_ID } from "./plugins/agent-assistant/plugin.js";
import { SETTINGS_DIALOG_ID } from "./plugins/settings/workspace/settings-dialog-chrome.js";
import {
  SNIPPET_DELETE_DIALOG_ID,
  SNIPPET_EDITOR_DIALOG_ID,
  SNIPPET_LIBRARY_DIALOG_ID,
  SNIPPET_TAG_DELETE_DIALOG_ID
} from "@woohaa3/extension-prompt-snippets/frontend";
import { PROMPT_SNIPPET_SOURCE } from "./plugins/service-keys.js";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { woohaa3CanvasStore } from "./services/canvas-state/index.js";
import { canvasFixture } from "./plugins/task-execution/test-support/fixtures.js";
import type { FunctionComponent, ReactElement } from "react";
import type { CanvasPanelRenderProps } from "./navigation/contracts.js";

let runtime: FrontendRuntime | null = null;

class FakeWebSocket {
  static OPEN = 1;
  readyState = 1;
  binaryType = "";
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

function installGlobals(): void {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  (globalThis as unknown as { fetch: unknown }).fetch = async () => new Response("{}", { status: 200 });
}

afterEach(async () => {
  await runtime?.dispose();
  runtime = null;
});

/** 一次安装 App + Canvas 服务（测试内联 helper，替代已删除的 installPlatform 包装）。 */
async function installFullPlatform(ctx: Context): Promise<void> {
  installAppServices(ctx, { testHooks: false });
  await installCanvasPageServices(ctx, { testHooks: false });
}

describe("真实平台 + 静态清单", () => {
  it("启动 required plugins 并注册 media-preview/alert dialog", async () => {
    installGlobals();
    runtime = await startFrontendRuntime({
      installPlatform: installFullPlatform,
      plugins: createSourceCanvasExtensionManifest()
    });
    expect(runtime.status().phase).toBe("ready");
    const dialogs = runtime.ctx.dialogs;
    expect(dialogs.registeredDialogIds()).toEqual(
      [
        ALERT_DIALOG_ID,
        CANVAS_HISTORY_DIALOG_ID,
        CANVAS_SWITCHER_DIALOG_ID,
        MEDIA_PREVIEW_DIALOG_ID,
        PASTE_REPLACE_DIALOG_ID,
        AGENT_ASSISTANT_DIALOG_ID,
        SNIPPET_LIBRARY_DIALOG_ID,
        SNIPPET_EDITOR_DIALOG_ID,
        SNIPPET_DELETE_DIALOG_ID,
        SNIPPET_TAG_DELETE_DIALOG_ID,
        GENERATION_TRACE_DIALOG_ID,
        SETTINGS_DIALOG_ID,
        VIDEO_FRAME_CAPTURE_DIALOG_ID,
        VIDEO_EDIT_DIALOG_ID
      ].sort()
    );
    expect(dialogs.resolveRenderer(MEDIA_PREVIEW_DIALOG_ID)).not.toBeNull();
    expect(dialogs.resolveRenderer(CANVAS_HISTORY_DIALOG_ID)).not.toBeNull();
    expect(dialogs.resolveRenderer(VIDEO_EDIT_DIALOG_ID)).not.toBeNull();
    expect(dialogs.resolveRenderer(VIDEO_FRAME_CAPTURE_DIALOG_ID)).not.toBeNull();
  });

  it("Agent detail registered by the real plugin can resolve its target without undeclared service access", async () => {
    installGlobals();
    runtime = await startFrontendRuntime({
      installPlatform: ctx => { installAppServices(ctx, { testHooks: false }); },
      plugins: []
    });
    const page = await startFrontendScope(runtime.ctx, {
      install: async ctx => {
        await installCanvasPageServices(ctx, { testHooks: false });
      },
      plugins: createSourceCanvasExtensionManifest(),
      isolate: ["canvasState", "canvasSession", "canvasNavigation", "agentConversationService"]
    });
    try {
      const route = { type: "agent-conversation" as const, conversationId: "conv-group", requestId: "request-group", nodeId: "group" };
      const definition = page.ctx.canvasNavigation.resolvePanel(route.type)!;
      const render = definition.render as FunctionComponent<CanvasPanelRenderProps>;
      const rendered = render({ route, writable: true }) as ReactElement<{ targetExecution: () => unknown }>;
      expect(rendered.props.targetExecution()).toBeNull();
    } finally { await page.dispose(); }
  });

  it("Canvas manifest 不再包含旧任务历史路由；node-execution panel definition 可见", async () => {
    installGlobals();
    runtime = await startFrontendRuntime({
      installPlatform: installFullPlatform,
      plugins: createSourceCanvasExtensionManifest()
    });
    const slots = runtime.ctx.slots;
    // 旧任务历史已移出核心；Canvas scope 不再注册任何 app.route。
    expect(slots.list("app.route")).toHaveLength(0);
    expect(runtime.ctx.canvasNavigation.resolvePanel("node-execution")).not.toBeNull();
    // canvas-menu 自身 + 片段插件的「保存为片段」项 + 任务执行的「查看生成溯源」项。
    expect(slots.list("canvas.context-menu")).toHaveLength(3);
  });

  it("通用 extension page scope 只注册自身 route，不装配 Canvas 能力（无核心业务分支）", async () => {
    installGlobals();
    const { entry, probe } = createFakeExtensionPageEntry({
      extensionId: "fake-monitor",
      pageId: "fake-monitor",
      path: "/admin/fake",
      legacyRedirectPaths: ["/fake-legacy"]
    });
    const history = await startFrontendRuntime({
      installPlatform: (ctx) => {
        // 生产：App scope 先提供 slots/dialogs/theme；extension page 只额外安装通用 remote。
        installAppServices(ctx, { testHooks: false, appPages: createAppPageRegistry([entry]) });
        installExtensionPageServices(ctx, { testHooks: false });
      },
      plugins: [{ id: "fake-monitor", required: true, plugin: entry.appPages![0]!.createPlugin!() }]
    });
    try {
      const slots = history.ctx.slots;
      expect(slots.list("app.route").map((route) => route.path)).toEqual(["/admin/fake"]);
      // 不创建 Canvas Session / Runtime / plugins。
      expect(history.ctx.get("canvasSession" as never)).toBeUndefined();
      expect(history.ctx.get("canvasRuntime" as never)).toBeUndefined();
      expect(history.ctx.get("canvasNavigation" as never)).toBeUndefined();
      expect(slots.list("canvas.context-menu")).toHaveLength(0);
      expect(probe.entered).toBe(1);
    } finally {
      await history.dispose();
    }
    expect(probe.disposed).toBe(1);
  });

  it("dispose 后 dialog 与 slot 贡献全部撤销，无残留", async () => {
    installGlobals();
    runtime = await startFrontendRuntime({
      installPlatform: installFullPlatform,
      plugins: createSourceCanvasExtensionManifest()
    });
    const ctx = runtime.ctx;
    const dialogs = ctx.dialogs;
    const slots = ctx.slots;
    const navigation = ctx.canvasNavigation;
    const current = runtime;
    runtime = null;
    await current.dispose();
    expect(dialogs.registeredDialogIds()).toEqual([]);
    expect(slots.list("app.route")).toHaveLength(0);
    expect(navigation.resolvePanel("node-execution")).toBeNull();
    expect(ctx.registry.size).toBe(0);
  });

  it("Canvas manifest 不注册旧任务历史路由，核心画布仍装配", async () => {
    installGlobals();
    runtime = await startFrontendRuntime({
      installPlatform: installFullPlatform,
      plugins: createSourceCanvasExtensionManifest()
    });
    const slots = runtime.ctx.slots;
    expect(slots.list("app.route")).toHaveLength(0);
    // 核心画布能力仍在。
    expect(runtime.ctx.canvasNavigation.resolvePanel("node-execution")).not.toBeNull();
    expect(runtime.ctx.canvasSession).toBeDefined();
  });

  it("optional paste-import / prompt-snippets 缺失时基础上传与 prompt 编辑仍可用", async () => {
    installGlobals();
    runtime = await startFrontendRuntime({
      installPlatform: installFullPlatform,
      plugins: createSourceCanvasExtensionManifest().filter(
        (definition) => definition.id !== "paste-import" && definition.id !== "prompt-snippets"
      )
    });
    const slots = runtime.ctx.slots;
    // paste/drop 与片段右键保存项不出现；片段来源 capability 缺失（`#` 引用入口消失）。
    expect(slots.list("input.paste")).toHaveLength(0);
    expect(slots.list("input.drop")).toHaveLength(0);
    expect(slots.list("canvas.context-menu")).toHaveLength(2); // canvas-menu + 查看生成溯源
    expect(runtime.ctx.get(PROMPT_SNIPPET_SOURCE as never)).toBeUndefined();
    // 基础能力仍在：右键上传（importService）、节点面板、画布会话。
    expect(runtime.ctx.get("importService" as never)).toBeDefined();
    expect(runtime.ctx.canvasNavigation.resolvePanel("node-execution")).not.toBeNull();
    expect(runtime.ctx.canvasSession).toBeDefined();
  });

  it("paste-import / prompt-snippets dispose 后 slot 与 dialog 完全撤销", async () => {
    installGlobals();
    runtime = await startFrontendRuntime({
      installPlatform: installFullPlatform,
      plugins: createSourceCanvasExtensionManifest()
    });
    const ctx = runtime.ctx;
    const slots = ctx.slots;
    const dialogs = ctx.dialogs;
    expect(slots.list("input.paste")).toHaveLength(1);
    expect(slots.list("canvas.context-menu")).toHaveLength(3); // canvas-menu + 片段保存项 + 查看生成溯源
    const current = runtime;
    runtime = null;
    await current.dispose();
    expect(slots.list("input.paste")).toHaveLength(0);
    expect(slots.list("input.drop")).toHaveLength(0);
    expect(slots.list("canvas.context-menu")).toHaveLength(0);
    expect(dialogs.registeredDialogIds()).toEqual([]);
    expect(ctx.registry.size).toBe(0);
  });

  it("ui.video-frame-capture.open-requested 事件从最新 canonical canvas 解析节点自身输出并打开截帧 Dialog", async () => {    installGlobals();
    runtime = await startFrontendRuntime({
      installPlatform: installFullPlatform,
      plugins: createSourceCanvasExtensionManifest()
    });
    const ctx = runtime.ctx;
    const dialogs = ctx.dialogs;
    const storage = `sha256-${"d".repeat(64)}`;
    // 直接写入 canonical store（不经过网络）：ready video 输出。
    const canvas = {
      ...createEmptyWoohaa3ServerCanvas("c1"),
      revision: 1,
      document: {
        schemaVersion: "asset-canvas-v1",
        nodes: [{ id: "vid1", type: "video", position: { x: 0, y: 0 } }],
        edges: [],
        updatedAt: "2026-09-26T00:00:00.000Z"
      },
      nodeData: { vid1: { outputAssetId: "asset-v" } },
      assets: [
        {
          id: "asset-v",
          title: "v",
          mediaKind: "video",
          source: "generated",
          status: "ready",
          url: `/api/media/${storage}`,
          createdAt: "2026-09-26T00:00:00.000Z",
          metadata: { storageKey: storage, checksum: "d".repeat(64), contentType: "video/mp4", size: 4 }
        }
      ]
    };
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas as never);
    // 事件只带 nodeId。
    ctx.emit("ui.video-frame-capture.open-requested", { nodeId: "vid1" });
    const top = dialogs.top();
    expect(top?.dialogId).toBe(VIDEO_FRAME_CAPTURE_DIALOG_ID);
    // 未知节点不发实例。
    const instanceId = top?.instanceId ?? null;
    ctx.emit("ui.video-frame-capture.open-requested", { nodeId: "missing" });
    expect(dialogs.top()?.instanceId ?? null).toBe(instanceId);
  });

  /**
   * 生产 Dialog ID → 合法 payload（change: unify-canvas-presentation-navigation，任务 6.5）。
   * 参数化断言：任一已注册 Dialog 成功打开后 menu/panel 必为空，且关闭不恢复。
   */
  const VALID_DIALOG_PAYLOADS: Array<{ name: string; dialogId: string; payload: unknown }> = [
    { name: "Alert", dialogId: ALERT_DIALOG_ID, payload: { title: "T", description: "D" } },
    {
      name: "MediaPreview",
      dialogId: MEDIA_PREVIEW_DIALOG_ID,
      payload: { assetId: "a1", nodeId: "n1", title: "T" }
    },
    {
      name: "PasteReplace",
      dialogId: PASTE_REPLACE_DIALOG_ID,
      payload: { intentId: "i1", fileName: "f.png", nodeLabel: "n" }
    },
    { name: "SnippetLibrary", dialogId: SNIPPET_LIBRARY_DIALOG_ID, payload: { forInsert: true } },
    { name: "SnippetEditor", dialogId: SNIPPET_EDITOR_DIALOG_ID, payload: { mode: "create" } },
    { name: "SnippetDelete", dialogId: SNIPPET_DELETE_DIALOG_ID, payload: { snippetId: "s1", name: "n" } },
    { name: "SnippetTagDelete", dialogId: SNIPPET_TAG_DELETE_DIALOG_ID, payload: { tagId: "t1", name: "n" } },
    { name: "CanvasHistory", dialogId: CANVAS_HISTORY_DIALOG_ID, payload: {} },
    {
      name: "VideoFrameCapture",
      dialogId: VIDEO_FRAME_CAPTURE_DIALOG_ID,
      payload: {
        videoAssetId: "v1",
        videoStorageKey: `sha256-${"a".repeat(64)}`,
        videoUrl: "/api/media/x",
        targetNodeId: "n1"
      }
    },
    {
      name: "VideoEdit",
      dialogId: VIDEO_EDIT_DIALOG_ID,
      payload: {
        videoAssetId: "v1",
        videoStorageKey: `sha256-${"a".repeat(64)}`,
        videoUrl: "/api/media/x",
        targetNodeId: "n1"
      }
    }
  ];

  it.each(VALID_DIALOG_PAYLOADS)(
    "$name Dialog 入栈前清理 menu/panel，关闭后不恢复，Escape 只关顶部",
    async ({ dialogId, payload }) => {
      installGlobals();
      runtime = await startFrontendRuntime({
        installPlatform: installFullPlatform,
        plugins: createSourceCanvasExtensionManifest()
      });
      const ctx = runtime.ctx;
      const navigation = ctx.canvasNavigation;

      // 建立 panel + menu 活动状态。
      expect(navigation.openPanel({ type: "node-execution", nodeId: "n1" }).ok).toBe(true);
      expect(
        navigation.openMenu({
          type: "canvas-context",
          nodeId: null,
          screen: { x: 1, y: 2 },
          world: { x: 3, y: 4 }
        }).ok
      ).toBe(true);
      expect(navigation.getSnapshot().panel).not.toBeNull();
      expect(navigation.getSnapshot().menu).not.toBeNull();

      // 合法 Dialog 打开：入栈前清空 panel/menu。
      const opened = navigation.openDialog({ dialogId, payload });
      expect(opened.ok).toBe(true);
      expect(navigation.getSnapshot().panel).toBeNull();
      expect(navigation.getSnapshot().menu).toBeNull();

      // 一次 Escape（requestCloseTop）只关闭顶部 Dialog。
      const closed = ctx.dialogs.requestCloseTop();
      expect(closed.closed).toBe(true);
      expect(ctx.dialogs.top()).toBeNull();
      // 关闭后不恢复画布 surface。
      expect(navigation.getSnapshot().panel).toBeNull();
      expect(navigation.getSnapshot().menu).toBeNull();
    }
  );

  it("非法 Dialog 请求不清理现有 menu/panel（change: unify-canvas-presentation-navigation）", async () => {
    installGlobals();
    runtime = await startFrontendRuntime({
      installPlatform: installFullPlatform,
      plugins: createSourceCanvasExtensionManifest()
    });
    const ctx = runtime.ctx;
    const navigation = ctx.canvasNavigation;
    navigation.openPanel({ type: "node-execution", nodeId: "n1" });

    const rejected = ctx.dialogs.open({ dialogId: "unknown-dialog", payload: {} });
    expect(rejected.ok).toBe(false);
    // 现有 panel 保持原状，不被误清理。
    expect(navigation.getSnapshot().panel).toEqual({ type: "node-execution", nodeId: "n1", presentation: "compact" });
  });

  it("selection 驱动显式 panel route；远端删除后 reconcile 关闭（change: unify-canvas-presentation-navigation）", async () => {
    installGlobals();
    runtime = await startFrontendRuntime({
      installPlatform: installFullPlatform,
      plugins: createSourceCanvasExtensionManifest()
    });
    const ctx = runtime.ctx;
    const navigation = ctx.canvasNavigation;
    const canvas = {
      ...createEmptyWoohaa3ServerCanvas("c1"),
      revision: 1,
      document: {
        schemaVersion: "asset-canvas-v1",
        nodes: [{ id: "img1", type: "image", position: { x: 0, y: 0 } }],
        edges: [],
        updatedAt: "2026-09-26T00:00:00.000Z"
      }
    };
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas as never);
    // selection coordinator 显式导航到执行 panel。
    ctx.selection.setFromRuntime(
      { nodeIds: ["img1"], primaryNodeId: "img1", editingFocus: false },
      new Set(["img1"])
    );
    expect(navigation.getSnapshot().panel).toEqual({ type: "node-execution", nodeId: "img1", presentation: "compact" });

    // 远端删除节点 → reconcile 关闭 panel。
    woohaa3CanvasStore.getState().applyRemoteCanvas({
      ...(canvas as never as object),
      revision: 2,
      document: { ...(canvas as never as { document: object }).document, nodes: [] }
    } as never);
    expect(navigation.getSnapshot().panel).toBeNull();
  });

  it("待确认节点的面板不被无关 working 更新关闭，规范回流后无需重新选择", async () => {
    installGlobals();
    runtime = await startFrontendRuntime({
      installPlatform: installFullPlatform,
      plugins: createSourceCanvasExtensionManifest()
    });
    const ctx = runtime.ctx;
    ctx.selection.reset();
    const canonical = canvasFixture({ nodes: [] });
    const working = canvasFixture({ nodes: [{ id: "pending-image", type: "image" }] });
    woohaa3CanvasStore.getState().hydrate(canonical);
    woohaa3CanvasStore.getState().applyWorkingCanvas(working);
    ctx.selection.setFromRuntime(
      { nodeIds: ["pending-image"], primaryNodeId: "pending-image", editingFocus: false },
      new Set(["pending-image"])
    );
    const expected = { type: "node-execution", nodeId: "pending-image", presentation: "compact" };
    expect(ctx.canvasNavigation.getSnapshot().panel).toEqual(expected);
    // pending 参数更新时节点仍未进入 canonical，不能把它当作已删除。
    woohaa3CanvasStore.getState().applyWorkingCanvas({ ...working });
    expect(ctx.canvasNavigation.getSnapshot().panel).toEqual(expected);
    // 重基短暂发布 canonical，再发布含 pending 的 working。
    woohaa3CanvasStore.getState().applyRemoteCanvas({ ...canonical, revision: 1 });
    woohaa3CanvasStore.getState().applyWorkingCanvas({ ...working, revision: 1 });
    expect(ctx.canvasNavigation.getSnapshot().panel).toEqual(expected);
    woohaa3CanvasStore.getState().applyRemoteCanvas({ ...working, revision: 2 });
    expect(ctx.canvasNavigation.getSnapshot().panel).toEqual(expected);
  });

  it("选择先于节点数据到达时，数据到达后自动打开面板", async () => {
    installGlobals();
    runtime = await startFrontendRuntime({
      installPlatform: installFullPlatform,
      plugins: createSourceCanvasExtensionManifest()
    });
    const ctx = runtime.ctx;
    ctx.selection.reset();
    woohaa3CanvasStore.getState().hydrate(canvasFixture({ nodes: [] }));
    ctx.selection.setFromRuntime(
      { nodeIds: ["late-image"], primaryNodeId: "late-image", editingFocus: false },
      new Set(["late-image"])
    );
    expect(ctx.canvasNavigation.getSnapshot().panel).toBeNull();
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasFixture({ nodes: [{ id: "late-image", type: "image" }] }));
    expect(ctx.canvasNavigation.getSnapshot().panel).toEqual({ type: "node-execution", nodeId: "late-image", presentation: "compact" });
  });

  it("退出聚焦恢复面板后，数据回流不被聚焦期间的选择覆盖", async () => {
    installGlobals();
    runtime = await startFrontendRuntime({
      installPlatform: installFullPlatform,
      plugins: createSourceCanvasExtensionManifest()
    });
    const ctx = runtime.ctx;
    ctx.selection.reset();
    const canvas = canvasFixture({ nodes: [
      { id: "model-1", type: "model3d" },
      { id: "image-2", type: "image" }
    ] });
    woohaa3CanvasStore.getState().hydrate(canvas);
    let focused = false;
    ctx.canvasNavigation.setFocusAdapter({
      apply: (target) => { focused = target !== null; return { ok: true }; },
      isFocused: () => focused,
      isTargetValid: () => true
    });
    ctx.selection.setFromRuntime(
      { nodeIds: ["model-1"], primaryNodeId: "model-1", editingFocus: false },
      new Set(["model-1", "image-2"])
    );
    expect(ctx.canvasNavigation.enterNodeFocus({ nodeId: "model-1", kind: "model" }).ok).toBe(true);
    ctx.selection.setFromRuntime(
      { nodeIds: ["image-2"], primaryNodeId: "image-2", editingFocus: false },
      new Set(["model-1", "image-2"])
    );
    ctx.canvasNavigation.exitNodeFocus();
    const restored = { type: "model-node-editor", nodeId: "model-1" };
    expect(ctx.canvasNavigation.getSnapshot().panel).toEqual(restored);
    woohaa3CanvasStore.getState().applyWorkingCanvas({ ...canvas });
    expect(ctx.canvasNavigation.getSnapshot().panel).toEqual(restored);
  });

  it("展开/收起是同 identity 的受控 replace；合法 Dialog 关闭后不恢复（change: align-execution-reference-and-expansion）", async () => {
    installGlobals();
    runtime = await startFrontendRuntime({
      installPlatform: installFullPlatform,
      plugins: createSourceCanvasExtensionManifest()
    });
    const ctx = runtime.ctx;
    const navigation = ctx.canvasNavigation;

    navigation.openPanel({ type: "node-execution", nodeId: "n1" });
    expect(navigation.getSnapshot().panel).toEqual({ type: "node-execution", nodeId: "n1", presentation: "compact" });

    // 展开：同 identity 替换，不产生 close。
    const expanded = navigation.openPanel({ type: "node-execution", nodeId: "n1", presentation: "expanded" });
    expect(expanded.ok).toBe(true);
    expect(navigation.getSnapshot().panel).toEqual({ type: "node-execution", nodeId: "n1", presentation: "expanded" });

    // 收起：回到 compact。
    navigation.openPanel({ type: "node-execution", nodeId: "n1", presentation: "compact" });
    expect(navigation.getSnapshot().panel).toEqual({ type: "node-execution", nodeId: "n1", presentation: "compact" });

    // 非法 presentation 被 definition validator 拒绝，保持原 panel。
    const rejected = navigation.openPanel({
      type: "node-execution",
      nodeId: "n1",
      presentation: "huge" as never
    });
    expect(rejected.ok).toBe(false);
    expect(navigation.getSnapshot().panel).toEqual({ type: "node-execution", nodeId: "n1", presentation: "compact" });

    // expanded 状态下打开合法 Dialog：panel 被清理，关闭后不恢复。
    navigation.openPanel({ type: "node-execution", nodeId: "n1", presentation: "expanded" });
    const opened = navigation.openDialog({ dialogId: ALERT_DIALOG_ID, payload: { title: "T", description: "D" } });
    expect(opened.ok).toBe(true);
    expect(navigation.getSnapshot().panel).toBeNull();
    ctx.dialogs.requestCloseTop();
    expect(navigation.getSnapshot().panel).toBeNull();
  });

  it("关闭 panel 不重开：selection identity 未变化时 coordinator 不重新打开（change: align-execution-reference-and-expansion）", async () => {
    installGlobals();
    runtime = await startFrontendRuntime({
      installPlatform: installFullPlatform,
      plugins: createSourceCanvasExtensionManifest()
    });
    const ctx = runtime.ctx;
    const navigation = ctx.canvasNavigation;
    const canvas = {
      ...createEmptyWoohaa3ServerCanvas("c1"),
      revision: 1,
      document: {
        schemaVersion: "asset-canvas-v1",
        nodes: [{ id: "img1", type: "image", position: { x: 0, y: 0 } }],
        edges: [],
        updatedAt: "2026-09-26T00:00:00.000Z"
      }
    };
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas as never);
    // 选择是模块级单例：先重置，确保本次 setFromRuntime 一定产生通知（跨用例隔离）。
    ctx.selection.reset();
    ctx.selection.setFromRuntime(
      { nodeIds: ["img1"], primaryNodeId: "img1", editingFocus: false },
      new Set(["img1"])
    );
    expect(navigation.getSnapshot().panel).toEqual({ type: "node-execution", nodeId: "img1", presentation: "compact" });

    // 用户关闭 panel。
    navigation.closePanel("node-execution");
    expect(navigation.getSnapshot().panel).toBeNull();

    // 同节点参数/权威数据更新不应覆盖用户主动关闭的意图。
    woohaa3CanvasStore.getState().applyWorkingCanvas({ ...canvas } as never);
    expect(navigation.getSnapshot().panel).toBeNull();

    // selection 未变化（重复同一 identity）不应重开。
    ctx.selection.setFromRuntime(
      { nodeIds: ["img1"], primaryNodeId: "img1", editingFocus: false },
      new Set(["img1"])
    );
    expect(navigation.getSnapshot().panel).toBeNull();

    // 重新选择另一节点可再次打开。
    woohaa3CanvasStore.getState().applyRemoteCanvas({
      ...(canvas as never as object),
      revision: 2,
      document: {
        ...(canvas as never as { document: object }).document,
        nodes: [
          { id: "img1", type: "image", position: { x: 0, y: 0 } },
          { id: "img2", type: "image", position: { x: 0, y: 0 } }
        ]
      }
    } as never);
    ctx.selection.setFromRuntime(
      { nodeIds: ["img2"], primaryNodeId: "img2", editingFocus: false },
      new Set(["img1", "img2"])
    );
    expect(navigation.getSnapshot().panel).toEqual({ type: "node-execution", nodeId: "img2", presentation: "compact" });
  });
});
