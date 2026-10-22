/**
 * Plugin Manager Plugin 生命周期与数据层测试
 * （change: add-frontend-plugin-manager，任务 4.1–4.3；
 *   change: 2026-10-16-consolidate-canvas-settings-entries：画布不再注册入口与弹窗）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { startFrontendRuntime, type FrontendRuntime } from "../../kernel.js";
import { extensionManagerPlugin, EXTENSION_MANAGER_ID } from "./plugin.js";
import { SlotRegistry } from "../../slots.js";
import { DialogService } from "../../services/dialogs/service.js";
import { CanvasNavigationStore } from "../../navigation/store.js";
import { sourceCanvasCatalogMetadata } from "../../test-support/source-extensions.js";
import type { PreferenceStorage } from "../../services/extension-preferences/codec.js";

let runtime: FrontendRuntime | null = null;

const CATALOG = sourceCanvasCatalogMetadata();
const IDS = CATALOG.filter((entry) => entry.configurable).map((entry) => entry.id);

function memoryStorage(): PreferenceStorage & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    }
  };
}

async function makeHarness(options: {
  assembled?: Record<string, boolean>;
  failed?: ReadonlySet<string>;
  storage?: PreferenceStorage;
  reload?: () => void;
  /** 站点插件状态 Service 替身（验证站点开关提交）。 */
  statusService?: unknown;
} = {}): Promise<{
  runtime: FrontendRuntime;
  slots: SlotRegistry;
  dialogs: DialogService;
  navigation: CanvasNavigationStore;
  facade: import("./contract.js").ExtensionManagerFacade;
}> {
  const slots = new SlotRegistry();
  const dialogs = new DialogService();
  const navigation = new CanvasNavigationStore({
    openDialog: (request) => {
      const result = dialogs.open({ dialogId: request.dialogId, payload: request.payload });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    }
  });
  const instance = await startFrontendRuntime({
    installPlatform: (ctx: Context) => {
      ctx.provide("slots" as never, slots as never);
      ctx.provide("dialogs" as never, dialogs as never);
      ctx.provide("canvasNavigation" as never, navigation as never);
    },
    plugins: [
      {
        id: EXTENSION_MANAGER_ID,
        required: true,
        plugin: extensionManagerPlugin({
          catalog: CATALOG,
          ids: IDS,
          assembled: options.assembled ?? {},
          ...(options.failed ? { failed: options.failed } : {}),
          storage: options.storage ?? memoryStorage(),
          reload: options.reload ?? (() => undefined),
          ...(options.statusService ? { site: { statusService: options.statusService as never, canManageSite: true } } : {})
        })
      }
    ]
  });
  return {
    runtime: instance,
    slots,
    dialogs,
    navigation,
    facade: instance.ctx.get("extensionManager" as never) as never
  };
}

afterEach(async () => {
  await runtime?.dispose();
  runtime = null;
});

describe("Plugin Manager Plugin", () => {
  it("激活后只提供 capability，不再注册画布入口或管理弹窗", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    expect(harness.slots.list("canvas.toolbar-action")).toHaveLength(0);
    expect(harness.dialogs.registeredDialogIds()).toEqual([]);
    expect(harness.facade).toBeDefined();
  });

  it("清单只投影可配置 optional，required 不出现", async () => {
    const harness = await makeHarness();
    runtime = harness.runtime;
    const view = harness.facade.getSnapshot();
    expect(view.rows.map((row) => row.id)).toEqual(
      CATALOG.filter((entry) => entry.configurable).map((entry) => entry.id)
    );
    expect(view.rows.every((row) => row.configurable && !row.required)).toBe(true);
    expect(view.rows.some((row) => row.id === "paste-import" || row.id === "model-editor")).toBe(false);
  });

  it("启动加载失败的可选入口显示「启动失败」而非「已启用」（任务 5.7）", async () => {
    const harness = await makeHarness({ failed: new Set(["prompt-snippets"]) });
    runtime = harness.runtime;
    const view = harness.facade.getSnapshot();
    const failed = view.rows.find((row) => row.id === "prompt-snippets");
    expect(failed?.status).toBe("failed");
    // 未失败的其它行仍为 active。
    expect(view.rows.find((row) => row.id === "node-history")?.status).toBe("active");
  });

  it("浏览器本地开关写本地偏好，站点开关提交服务端配置", async () => {
    const storage = memoryStorage();
    const writeConfig = vi.fn(async (_input: { extensionId: string; enabled: boolean }) => ({ ok: true as const, revision: 1, status: { extensionId: "game-furnace" } }));
    const harness = await makeHarness({ storage, statusService: { writeConfig, getSnapshot: () => ({ revision: 1, catalog: [], plugins: [], error: null, loading: false }), subscribe: () => () => undefined, refresh: async () => undefined } });
    runtime = harness.runtime;
    harness.facade.setEnabled("prompt-snippets", false);
    // 只写偏好：本次装配不变（行变为「待停用」），偏好留待下次启动读取。
    expect(harness.facade.getSnapshot().rows.find(row => row.id === "prompt-snippets")?.status).toBe("pending-disable");
    expect(harness.facade.getSnapshot().error).toBeNull();
    expect(Object.keys(storage.data)).toHaveLength(1);
    expect(storage.data["woohaa:frontend-extensions:v1"]).toContain('"prompt-snippets":false');
    expect(harness.facade.getSnapshot().pending).toBe(true);

    harness.facade.setSiteEnabled("game-furnace", false);
    expect(harness.facade.getSnapshot().error).toBeNull();
    await vi.waitFor(() => expect(writeConfig).toHaveBeenCalledTimes(1));
    expect(writeConfig.mock.calls[0]![0]).toMatchObject({ extensionId: "game-furnace", enabled: false });
  });

  it("refresh 触发一次注入的 reload adapter", async () => {
    const reload = vi.fn();
    const harness = await makeHarness({ reload });
    runtime = harness.runtime;
    harness.facade.refresh();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("dispose 后 capability 撤销且无遗留 contribution", async () => {
    const harness = await makeHarness();
    const current = harness.runtime;
    runtime = null;
    await current.dispose();
    expect(harness.slots.list("canvas.toolbar-action")).toHaveLength(0);
    expect(harness.dialogs.registeredDialogIds()).toEqual([]);
  });

  it("独立 Context 重新激活后 capability 可用且没有重复 contribution", async () => {
    const first = await makeHarness();
    runtime = first.runtime;
    expect(first.facade).toBeDefined();
    expect(first.slots.list("canvas.toolbar-action")).toHaveLength(0);
    await first.runtime.dispose();
    runtime = null;

    const second = await makeHarness();
    runtime = second.runtime;
    expect(second.facade).toBeDefined();
    expect(second.slots.list("canvas.toolbar-action")).toHaveLength(0);
    expect(second.dialogs.registeredDialogIds()).toEqual([]);
  });
});
