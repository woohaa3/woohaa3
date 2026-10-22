/**
 * Prompt Snippets Plugin 生命周期测试（extension 前端 owner）
 * （change: add-prompt-snippet-library，任务 4.1/4.4/6.5；
 *   change: 2026-10-10-extract-optional-feature-extensions，任务 4.1：由宿主
 *   `cordis/plugins/prompt-snippets/plugin.test.ts` 迁入独立包。独立包测试不依赖宿主
 *   Vite 扫描器或宿主 service 实现：这里用**显式注入的公开 capability 替身**驱动 plugin，
 *   并以最小 harness 模拟 Cordis 的 `inject` 门禁与 apply 失败回滚。
 */
import { describe, expect, it } from "vitest";
import type { Plugin } from "@deepseek-ai/cordis";
import { PROMPT_SNIPPET_SOURCE } from "@woohaa3/frontend/extension-api";
import { promptSnippetsExtension, SAVE_SNIPPET_MENU_ID } from "../src/frontend/plugin.js";
import {
  SNIPPET_DELETE_DIALOG_ID,
  SNIPPET_EDITOR_DIALOG_ID,
  SNIPPET_LIBRARY_DIALOG_ID,
  SNIPPET_TAG_DELETE_DIALOG_ID
} from "../src/frontend/dialogs.js";

type Disposer = () => void;

/** 最小 slot registry 替身（只覆盖 plugin 使用的 register/list 语义）。 */
function fakeSlots() {
  const contributions = new Map<string, Array<{ id: string; [key: string]: unknown }>>();
  return {
    list(slot: string) {
      return contributions.get(slot) ?? [];
    },
    register(slot: string, contribution: { id: string }) {
      const list = contributions.get(slot) ?? [];
      list.push(contribution);
      contributions.set(slot, list);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const current = contributions.get(slot) ?? [];
        contributions.set(slot, current.filter((entry) => entry !== contribution));
      };
    }
  };
}

/** 最小 dialog service 替身。 */
function fakeDialogs() {
  const registered = new Map<string, unknown>();
  return {
    registeredDialogIds: () => [...registered.keys()],
    registerDialog(dialogId: string, registration: unknown) {
      if (registered.has(dialogId)) throw new Error(`dialog 冲突：${dialogId}`);
      registered.set(dialogId, registration);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        registered.delete(dialogId);
      };
    },
    open: () => ({ ok: true }),
    close: () => undefined
  };
}

function fakeCanvasRemote() {
  return {
    listSnippets: async () => ({ ok: true, value: { items: [], nextCursor: null, total: 0 } }),
    listSnippetTags: async () => ({ ok: true, value: [] }),
    getSnippet: async () => ({ ok: false, code: "SNIPPET_NOT_FOUND", error: "no" }),
    resolveSnippetMaterial: async () => ({ ok: false, code: "unauthorized", error: "no" })
  };
}

/**
 * 最小 Cordis Context 替身：支持 `provide/get`、`effect`、`inject` 门禁与 apply 失败回滚。
 *
 * `apply(plugin)` 模拟 Cordis Fiber：注入服务缺失时不进入 plugin（等价 pending），
 * apply 抛错时运行已注册 effect 的清理（等价 fiber dispose 回滚）。
 */
function makeHarness(options: { canvasRemote?: boolean } = {}) {
  const slots = fakeSlots();
  const dialogs = fakeDialogs();
  const provided = new Map<string, unknown>();
  const disposers: Disposer[] = [];
  const ctx: Record<string, unknown> = {
    slots,
    dialogs,
    mediaRemote: { urlFor: (k: string) => `/api/media/${k}`, isAllowedUrl: () => true },
    canvasScope: { canvasId: () => "c1" },
    canvasState: { getCanvas: () => null, getWorkingCanvas: () => null, subscribe: () => () => undefined },
    effect: (factory: () => Disposer) => {
      disposers.push(factory());
    },
    provide: (name: string, value: unknown) => provided.set(name, value),
    get: (name: string) => provided.get(name)
  };
  if (options.canvasRemote !== false) ctx.canvasRemote = fakeCanvasRemote();

  const dispose = () => {
    for (const disposeEffect of disposers.splice(0)) disposeEffect();
  };
  const apply = (plugin: Plugin.Function<void>) => {
    const inject = (plugin as { inject?: readonly string[] }).inject ?? [];
    for (const name of inject) {
      if (!(name in ctx)) throw new Error(`cannot get property ${name} without inject`);
    }
    try {
      plugin(ctx as never);
    } catch (error) {
      dispose();
      throw error;
    }
  };
  return { ctx, slots, dialogs, provided, apply, dispose };
}

describe("Prompt Snippets Plugin", () => {
  it("激活后注册 library/editor/delete dialogs、提供 snippetCatalog 与 promptSnippetSource、注册节点右键保存项", () => {
    const harness = makeHarness();
    harness.apply(promptSnippetsExtension());
    expect([...harness.dialogs.registeredDialogIds()].sort()).toEqual(
      [SNIPPET_LIBRARY_DIALOG_ID, SNIPPET_EDITOR_DIALOG_ID, SNIPPET_DELETE_DIALOG_ID, SNIPPET_TAG_DELETE_DIALOG_ID].sort()
    );
    expect(harness.provided.get("snippetCatalog")).toBeDefined();
    // `#` 引用来源 capability（design D10 修订）。
    expect(harness.provided.get(PROMPT_SNIPPET_SOURCE)).toBeDefined();
    // 节点右键菜单提供「保存为片段」项。
    const menu = harness.slots.list("canvas.context-menu");
    expect(menu).toHaveLength(1);
    const items = (menu[0] as unknown as { items: (c: unknown) => Array<{ id: string }> }).items({
      nodeId: "n1",
      screen: { x: 0, y: 0 },
      world: { x: 0, y: 0 },
      writable: true
    });
    expect(items.map((item) => item.id)).toContain(SAVE_SNIPPET_MENU_ID);
    // 右下角控件面板的「提示词片段管理」图标动作。
    expect(harness.slots.list("canvas.toolbar-action").map((entry) => entry.id)).toContain("prompt-snippets-library");
  });

  it("缺失 canvasRemote 时 inject 未满足、零部分贡献", () => {
    const harness = makeHarness({ canvasRemote: false });
    expect(() => harness.apply(promptSnippetsExtension())).toThrow();
    // 未进入 plugin：无 dialog / slot / capability 残留。
    expect(harness.dialogs.registeredDialogIds()).toEqual([]);
    expect(harness.slots.list("canvas.context-menu")).toHaveLength(0);
    expect(harness.provided.get(PROMPT_SNIPPET_SOURCE)).toBeUndefined();
  });

  it("dispose 后撤销 dialogs、slot 与 catalog subscription", () => {
    const harness = makeHarness();
    harness.apply(promptSnippetsExtension());
    harness.dispose();
    expect(harness.dialogs.registeredDialogIds()).toEqual([]);
    expect(harness.slots.list("canvas.context-menu")).toHaveLength(0);
    expect(harness.slots.list("canvas.toolbar-action")).toHaveLength(0);
  });

  it("启动失败（dialog 冲突）时回滚已注册 slot/dialog，不残留", () => {
    const harness = makeHarness();
    // 预先占用 editor dialog ID，使 Plugin apply 中途抛错。
    harness.dialogs.registerDialog(SNIPPET_EDITOR_DIALOG_ID, { definition: { validatePayload: () => ({ ok: true, payload: {} }) } });
    expect(() => harness.apply(promptSnippetsExtension())).toThrow();
    // 已注册的 slot 在失败回滚中被撤销。
    expect(harness.slots.list("canvas.context-menu")).toHaveLength(0);
    // 失败前已注册的 library dialog 也被回滚（只剩我们预占用的 editor）。
    expect(harness.dialogs.registeredDialogIds()).toEqual([SNIPPET_EDITOR_DIALOG_ID]);
  });
});
