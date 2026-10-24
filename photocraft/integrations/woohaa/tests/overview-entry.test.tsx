/** @vitest-environment jsdom */
/**
 * 画布入口回归
 * （change: 2026-10-21-add-photocraft-document-workspace，design D2）。
 *
 * PhotoCraft **不**在画布工具栏（`canvas.toolbar-action`）提供入口：
 * 进入编辑器走图片节点，独立文件的「打开文件…」只在工作区「文件」菜单里。
 * 本用例锁住这条边界，避免入口又回到右下角控件面板。
 */
import { afterEach, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { imageEditorExtension } from "../src/image-editor-plugin.js";
import { woohaa3CanvasStore } from "@woohaa3/frontend/plugin-api";

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

type SlotContribution = { id: string; label?: string; onActivate?: () => void };

/** 极简 Context 替身：记录 slot 注册，供断言入口位置。 */
function harness(mode: { type: string; [key: string]: unknown }) {
  const actions = new Map<string, SlotContribution>();
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
      register: (slot: string, contribution: SlotContribution & { render?: unknown }) => {
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
  return { actions, listeners, registeredSlots };
}

const OVERVIEW = { type: "overview" };

it("概览不注册画布工具栏入口（PhotoCraft 入口不属于右下角控件面板）", () => {
  const h = harness(OVERVIEW);
  expect(h.actions.size).toBe(0);
  expect(h.registeredSlots).not.toContain("canvas.toolbar-action");
});

it("仍注册聚焦工作区与独立文档工作区两个 slot 贡献", () => {
  const h = harness(OVERVIEW);
  expect(h.registeredSlots).toContain("canvas.focus-workspace");
  expect(h.registeredSlots).toContain("canvas.document-workspace");
});

it("图片聚焦工作区在任何文档打开前就可用（A8：不再先闪「工作区不可用」）", () => {
  // 回归：贡献曾以「至少一个文档已打开」为 available，双击后的第一帧文档还没打开，
  // 解析就当它不存在，先渲染「此节点的工作区不可用 / 请检查对应扩展是否已启用」，等异步
  // 打开完成才换回编辑器（2026-10-24 审片 A8，几乎每条镜头开头都有）。
  const contributions = new Map<string, { available?: () => boolean; kind?: string }>();
  const listeners = new Set<() => void>();
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
      getSnapshot: () => ({ mode: OVERVIEW, panel: null, menu: null }),
      requestEnterNodeFocus: async () => ({ ok: true }),
      requestEnterDocumentWorkspace: async () => ({ ok: true }),
      exitNodeFocus: vi.fn(),
      invalidateNodeFocus: vi.fn()
    },
    canvasRemote: { editBegin: vi.fn(async () => ({ ok: true, value: { baselineContentIdentity: "media:x" } })) },
    focusExit: { register: () => () => {}, registerSwitchGate: () => () => {} },
    pageLeave: { register: () => () => {}, hasUnsaved: () => false, settle: async () => ({ ok: true as const }) },
    slots: {
      register: (slot: string, contribution: { id: string; kind?: string; available?: () => boolean }) => {
        if (slot === "canvas.focus-workspace") contributions.set(contribution.id, contribution);
        return () => { contributions.delete(contribution.id); };
      }
    },
    provide: () => undefined,
    get: () => undefined,
    effect: (effect: () => () => void) => { cleanups.push(effect()); }
  } as unknown as Context;
  imageEditorExtension({ canvasId: "c" })(ctx, undefined);
  const workspace = [...contributions.values()].find((entry) => entry.kind === "image");
  expect(workspace).toBeDefined();
  // 没有任何文档时也必须解析成「可用」：工作区自己呈现准备中/加载中/失败。
  expect(workspace?.available?.()).toBe(true);
});
