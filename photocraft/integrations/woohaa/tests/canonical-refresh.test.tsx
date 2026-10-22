/** @vitest-environment jsdom */
// 像素读取与解码用替身；验证真实插件的回执、权威回流及文档内容刷新。
import { afterEach, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { imageEditorExtension } from "../src/image-editor-plugin.js";
import { createRemoteClient } from "@woohaa3/frontend/plugin-api";
import { woohaa3CanvasStore } from "@woohaa3/frontend/plugin-api";
import { IMAGE_EDIT_SERVICE } from "@woohaa3/frontend/plugin-api";
import type { ImageEditService } from "@woohaa3/frontend/plugin-api";
import type { DocumentWorkspaceStore, WorkspaceUiState } from "../src/workspace-store.js";
import type { ImageFocusWorkspace } from "../src/workspace.js";

vi.mock("../src/loader.js", () => ({ createImageFocusLoader: () => ({
  load: vi.fn(async () => ({ ok: true, value: { bitmap: {}, width: 800, height: 600 } })),
  release: vi.fn()
}) }));
vi.mock("@woohaa3/frontend/plugin-api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  BEVY_TEXTURE_MAX_DIMENSION: 2048, defaultRasterCanvasFactory: vi.fn(),
  rasterizeDrawable: () => ({ width: 1, height: 1, pixels: new Uint8Array(4) })
}));
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); woohaa3CanvasStore.getState().applyRemoteCanvas(null as never); });

function canvas(revision: number, output: string) {
  const value = createEmptyWoohaa3ServerCanvas("c", "2026-10-17T00:00:00Z");
  value.revision = revision;
  value.document.nodes.push({ id: "image", type: "image", position: { x: 300, y: 400 }, width: 248, height: 232 });
  value.nodeData.image = { outputAssetId: output };
  value.assets.push({ id: output, status: "ready", mediaKind: "image", url: `/api/media/${output}.png`,
    metadata: { storageKey: `${output}.png`, width: 800, height: 600 } } as never);
  return value;
}

/** 构造真实插件的最小 Context 替身；返回工作区 store 与导航通知。 */
function harness(begin: ReturnType<typeof vi.fn>, onSlot: (contribution: { render: (props: unknown) => unknown }) => void) {
  let notifyNavigation: () => void = () => {};
  let service: ImageEditService;
  const mode = { type: "node-focus", kind: "image", nodeId: "image", owner: "direct" };
  const controller = { surface: () => ({ width: 1200, height: 900, pixelRatio: 1 }), viewport: () => ({ x: 10, y: 20, zoom: 0.8 }), restoreViewport: vi.fn() };
  const runtime = {
    registerImageViewportTarget: () => () => {}, controller: () => controller, runtime: () => null,
    focusContentRect: () => ({ x: 52, y: 152, width: 1000, height: 700 }),
    focusTransitionPort: () => ({ run: async (request: { apply: (view: unknown, progress: number) => void; to: unknown }) => { request.apply(request.to, 1); return true; }, cancel: vi.fn() }),
    setImageFocus: vi.fn(), setImageFocusTexture: vi.fn(), setImageFocusDetails: vi.fn(), setImageFocusTargets: vi.fn(),
    subscribeFocusContentRect: () => () => {}
  };
  const ctx = {
    // 真实 Context 由平台注入该服务；这里是可写会话的替身。
    canvasSession: { isWritable: () => true },
    canvasRuntime: runtime,
    canvasNavigation: {
      registerNodeFocusGuard: () => () => {},
      subscribe: (fn: () => void) => { notifyNavigation = fn; return () => {}; },
      getSnapshot: () => ({ mode }),
      requestEnterNodeFocus: async () => ({ ok: true, snapshot: { mode, panel: null, menu: null } }),
      requestEnterDocumentWorkspace: async () => ({ ok: true }),
      enterNodeFocus: vi.fn(),
      exitNodeFocus: vi.fn(),
      invalidateNodeFocus: vi.fn()
    },
    canvasRemote: { editBegin: begin, applyNodeHistory: async () => ({ ok: true, value: { revision: 2 } }) },
    focusExit: { register: () => () => {}, registerSwitchGate: () => () => {} },
    pageLeave: { register: () => () => {}, hasUnsaved: () => false, settle: async () => ({ ok: true as const }) },
    slots: { register: (_: unknown, contribution: { render: (props: unknown) => unknown }) => { onSlot(contribution); return () => {}; } },
    provide: (_: unknown, value: ImageEditService) => { service = value; },
    // 只有图片编辑服务由本插件提供；运行态服务未注册时必须安全降级。
    get: (key: unknown) => key === IMAGE_EDIT_SERVICE ? service : undefined,
    effect: (effect: () => () => void) => { cleanups.push(effect()); }
  } as unknown as Context;
  imageEditorExtension({ canvasId: "c" })(ctx, undefined);
  return {
    notify: () => notifyNavigation(),
    service: () => service,
    // 工作区 store 从插件暴露的排障镜像读取（开发构建）。
    workspace: () => (globalThis as unknown as { __imageWorkspaceStore?: DocumentWorkspaceStore }).__imageWorkspaceStore
  };
}

it.each([true, false])("设为当前更新正在编辑的图片；回流早于回执=%s", async (early) => {
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas(1, "old"));
  const begin = vi.fn(async () => ({ ok: true, value: { baselineContentIdentity: "media:new.png" } }));
  let captured: { render: (props: unknown) => unknown } | null = null;
  const h = harness(begin, (contribution) => { captured = contribution; });
  h.notify();
  await vi.waitFor(() => expect(begin).toHaveBeenCalled());
  // 插件在打开文档时已经 capture 了活动绑定；这里直接读 store 的活动呈现。
  const store = h.workspace();
  expect(store).toBeDefined();
  void captured;
  const active = store!.getSnapshot().active;
  expect(active).not.toBeNull();
  const workspace = active!.view as ImageFocusWorkspace;
  const direct = { x: 30, y: -20, zoom: 1.4 };
  workspace.setViewport(direct);
  if (early) woohaa3CanvasStore.getState().applyRemoteCanvas(canvas(2, "new"));
  const result = await createRemoteClient(createCtxStub(h.service())).apply({ canvasId: "c", nodeId: "image", entryId: "version" });
  expect(result.ok).toBe(true);
  if (!early) {
    expect(workspace.contentRevisionState()).toBe(0);
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas(2, "new"));
  }
  await vi.waitFor(() => expect(workspace.loadedImage()).not.toBeNull());
  expect(store!.getSnapshot().active?.view).toBe(workspace);
  expect(workspace.contentRevisionState()).toBe(1);
  expect(workspace.baseAsset()).toMatchObject({ id: "new" });
  expect(workspace.focus.viewportState()).toEqual(direct);
  // 后续普通画布更新不能再次重开编辑内容。
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas(3, "new"));
  expect(workspace.contentRevisionState()).toBe(1);
});

/** `createRemoteClient` 只需要 imageEdit 服务与 applyNodeHistory。 */
function createCtxStub(service: ImageEditService) {
  return {
    canvasSession: { isWritable: () => true },
    // `get` 按服务 key 分派：run state 不注册（运行中门禁按缺省放行），imageEdit 由插件提供。
    get: (key: unknown) => key === IMAGE_EDIT_SERVICE ? service : undefined,
    canvasRemote: { applyNodeHistory: async () => ({ ok: true, value: { revision: 2 } }) }
  } as unknown as Context;
}

it.each(["failure", "other-node"])("恢复失败或其它节点的恢复不替换当前草稿：%s", async (reason) => {
  const refreshFromCanonical = vi.fn();
  const ctx = { canvasSession: { isWritable: () => true },
    get: () => ({ isActive: () => true, nodeId: () => "image", isBusy: () => false, draftState: () => "saved", refreshFromCanonical }),
    canvasRemote: { applyNodeHistory: async () => reason === "failure" ? { ok: false, code: "conflict", error: "冲突" } : { ok: true, value: { revision: 2 } } }
  } as unknown as Context;
  await createRemoteClient(ctx).apply({ canvasId: "c", nodeId: reason === "other-node" ? "other" : "image", entryId: "version" });
  expect(refreshFromCanonical).not.toHaveBeenCalled();
});

void (null as unknown as WorkspaceUiState);
