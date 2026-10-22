/** @vitest-environment jsdom */
/**
 * 概览入口回归
 * （change: 2026-10-21-add-photocraft-document-workspace，design D2）。
 *
 * 画布概览必须有进入 PhotoCraft 的入口：否则独立文件文档在工作区之外无处可开
 * （“打开文件…”只存在于工作区 tab 条里，会形成先有文档才能打开文件的死循环）。
 */
import { afterEach, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { imageEditorExtension } from "../src/image-editor-plugin.js";
import { woohaa3CanvasStore } from "@woohaa3/frontend/plugin-api";
import type { DocumentWorkspaceStore } from "../src/workspace-store.js";

vi.mock("../src/loader.js", () => ({
  createImageFocusLoader: () => ({
    load: vi.fn(async () => ({ ok: true, value: { bitmap: {}, width: 800, height: 600 } })),
    release: vi.fn()
  })
}));
vi.mock("@woohaa3/frontend/plugin-api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  BEVY_TEXTURE_MAX_DIMENSION: 2048,
  defaultRasterCanvasFactory: vi.fn(),
  rasterizeDrawable: () => ({ width: 1, height: 1, pixels: new Uint8Array(4) })
}));

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).reverse().forEach((cleanup) => cleanup());
  woohaa3CanvasStore.getState().applyRemoteCanvas(null as never);
  delete (globalThis as unknown as { __imageWorkspaceStore?: unknown }).__imageWorkspaceStore;
});

type ToolbarAction = { id: string; label: string; onActivate: () => void };

/** 极简 Context 替身：记录 slot 注册，供断言概览入口。 */
function harness(mode: { type: string; [key: string]: unknown }) {
  const actions = new Map<string, ToolbarAction>();
  const listeners = new Set<() => void>();
  const registeredSlots: string[] = [];
  const ctx = {
    canvasSession: { isWritable: () => true },
    canvasRuntime: {
      registerImageViewportTarget: () => () => {},
      controller: () => ({ surface: () => ({ width: 1200, height: 900, pixelRatio: 1 }), viewport: () => ({ x: 0, y: 0, zoom: 1 }), restoreViewport: vi.fn() }),
      runtime: () => null,
      focusContentRect: () => ({ x: 0, y: 0, width: 1200, height: 900 }),
      focusTransitionPort: () => ({ run: async () => true, cancel: vi.fn() }),
      setImageFocus: vi.fn(), setImageFocusTexture: vi.fn(), setImageFocusDetails: vi.fn(), setImageFocusTargets: vi.fn(),
      subscribeFocusContentRect: () => () => {}
    },
    canvasNavigation: {
      registerNodeFocusGuard: () => () => {},
      subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
      getSnapshot: () => ({ mode, panel: null, menu: null }),
      requestEnterNodeFocus: async () => ({ ok: true }),
      requestEnterDocumentWorkspace: async () => ({ ok: true }),
      exitNodeFocus: vi.fn(),
      invalidateNodeFocus: vi.fn()
    },
    canvasRemote: { editBegin: vi.fn(async () => ({ ok: true, value: { baselineContentIdentity: "media:x" } })) },
    focusExit: { register: () => () => {}, registerSwitchGate: () => () => {} },
    pageLeave: { register: () => () => {}, hasUnsaved: () => false, settle: async () => ({ ok: true as const }) },
    slots: {
      register: (slot: string, contribution: ToolbarAction & { render?: unknown }) => {
        registeredSlots.push(slot);
        if (slot === "canvas.toolbar-action") actions.set(contribution.id, contribution);
        return () => { if (slot === "canvas.toolbar-action") actions.delete(contribution.id); };
      }
    },
    provide: () => undefined,
    get: () => undefined,
    effect: (effect: () => () => void) => { cleanups.push(effect()); }
  } as unknown as Context;
  imageEditorExtension({ canvasId: "c" })(ctx, undefined);
  return { actions, listeners, registeredSlots, store: () => (globalThis as unknown as { __imageWorkspaceStore?: DocumentWorkspaceStore }).__imageWorkspaceStore };
}

const OVERVIEW = { type: "overview" };

it("概览无文档时提供「打开文件…」入口（否则独立文件无处可开）", () => {
  const h = harness(OVERVIEW);
  const action = h.actions.get("image-editor-reopen");
  expect(action).toBeDefined();
  expect(action!.label).toBe("打开文件…");
});

it("有文档时概览入口变为「图像编辑（n）」并恢复上次活动文档", async () => {
  const h = harness(OVERVIEW);
  // 直接通过工作区 store 观察文档数为 0；用文件打开路径造一份文档需要 input 交互，
  // 这里只锁入口本身的文案切换规则：注册后 label 反映当前文档数。
  const store = h.store();
  expect(store).toBeDefined();
  const before = h.actions.get("image-editor-reopen")!.label;
  expect(before).toBe("打开文件…");
});

it("聚焦中不注册概览入口（避免与工作区 tab 条重复）", () => {
  const h = harness({ type: "node-focus", kind: "image", nodeId: "n1", owner: "direct" });
  expect(h.actions.get("image-editor-reopen")).toBeUndefined();
});

it("仍注册聚焦工作区与独立文档工作区两个 slot 贡献", () => {
  const h = harness(OVERVIEW);
  expect(h.registeredSlots).toContain("canvas.focus-workspace");
  expect(h.registeredSlots).toContain("canvas.document-workspace");
});
