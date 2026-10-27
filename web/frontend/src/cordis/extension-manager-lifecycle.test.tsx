/**
 * 插件启停生命周期（配置文件是事实来源）
 *
 * 验证：启停目标状态从宿主配置投影，写入转发给宿主设置 API，不再是浏览器 localStorage；
 * 配置变化时画布 scope 内热装/热卸，而不是「下次启动生效」。
 *
 * @vitest-environment jsdom
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { startApp, type AppRuntime } from "./page-scope.js";
import { createFakeCanvasCatalogRemote } from "./test-support/canvas-catalog.js";
import { createSourceExtensionRuntimeService } from "./test-support/source-extensions.js";
import type { PreferenceStorage } from "./services/extension-preferences/codec.js";
import type { SettingsRemote } from "./services/settings-remote.js";

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

/** 旧版浏览器偏好：只用于验证一次性迁移读取，store 不再写它。 */
function legacyStorage(initial: Record<string, string> = {}): PreferenceStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (key) => data[key] ?? null };
}

function settingsRemote(overrides: {
  extensionToggles?: Record<string, boolean>;
  setExtensionToggle?: SettingsRemote["setExtensionToggle"];
} = {}): SettingsRemote & { calls: Array<[string, boolean]> } {
  const calls: Array<[string, boolean]> = [];
  const snapshot = (): Record<string, unknown> => ({
    settings: [],
    plugins: [],
    extensionToggles: overrides.extensionToggles ?? {},
    files: { config: "/tmp/woohaa.config.yml", secrets: "/tmp/woohaa.secrets.yml" }
  });
  return {
    calls,
    fetchSnapshot: async () => ({ ok: true, snapshot: snapshot() as never }),
    write: async () => ({ ok: true, snapshot: snapshot() as never }),
    setExtensionToggle:
      overrides.setExtensionToggle ??
      (async (extensionId: string, enabled: boolean) => {
        calls.push([extensionId, enabled]);
        return { ok: true, snapshot: snapshot() as never };
      })
  };
}

function startWith(options: {
  storage?: PreferenceStorage | null;
  remote?: SettingsRemote;
} = {}): Promise<AppRuntime> {
  return startApp({
    initialPathname: "/",
    canvasCatalogRemote: createFakeCanvasCatalogRemote(),
    extensionRuntime: createSourceExtensionRuntimeService(),
    extensionPreferenceStorage: options.storage ?? null,
    settingsRemote: options.remote ?? settingsRemote(),
    extensionManagerReload: () => undefined
  });
}

/** node-history 通过 ai-center.generation-history 稳定可观察其是否装配。 */
function nodeHistoryAssembled(instance: AppRuntime): boolean {
  const page = instance.currentPage();
  if (!page) return false;
  return page.ctx.slots.list("ai-center.generation-history").some((entry) => entry.id === "node-history");
}

let app: AppRuntime | null = null;

afterEach(async () => {
  await app?.dispose();
  app = null;
});

describe("插件启停（宿主配置文件是事实来源）", () => {
  it("启用状态来自宿主配置，不再读浏览器存储", async () => {
    installGlobals();
    app = await startWith({
      remote: settingsRemote({ extensionToggles: { "node-history": false } })
    });
    expect(nodeHistoryAssembled(app)).toBe(false);
    const page = app.currentPage()!;
    expect(page.diagnostics.getStatus().plugins.find((plugin) => plugin.id === "node-history")?.status).toBe("disabled");
  });

  it("setEnabled 写宿主设置，不写浏览器 localStorage", async () => {
    installGlobals();
    const storage = legacyStorage();
    const remote = settingsRemote();
    app = await startWith({ storage, remote });
    const page = app.currentPage()!;
    const facade = page.ctx.get("extensionManager" as never) as never as {
      setEnabled(id: string, enabled: boolean): void;
    };
    facade.setEnabled("node-history", false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(remote.calls).toEqual([["node-history", false]]);
    // 旧版键没有被写入（迁移路径之外的写入一律走宿主配置）。
    expect(storage.data["woohaa:frontend-extensions:v1"]).toBeUndefined();
  });

  it("配置热变化时在当前 scope 内卸下插件", async () => {
    installGlobals();
    const remote = settingsRemote({ extensionToggles: {} });
    app = await startWith({ remote });
    expect(nodeHistoryAssembled(app)).toBe(true);
    const page = app.currentPage()!;
    const facade = page.ctx.get("extensionManager" as never) as never as {
      setEnabled(id: string, enabled: boolean): void;
    };
    facade.setEnabled("node-history", false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 同一 page scope 内立即卸下：fiber 被释放，贡献消失。
    expect(nodeHistoryAssembled(app)).toBe(false);
    expect(page.diagnostics.getStatus().plugins.find((plugin) => plugin.id === "node-history")).toBeUndefined();
  });

  it("热插拔后面板不出现 pending：启停是立即生效的", async () => {
    installGlobals();
    const remote = settingsRemote({ extensionToggles: {} });
    app = await startWith({ remote });
    const page = app.currentPage()!;
    const facade = page.ctx.get("extensionManager" as never) as never as {
      setEnabled(id: string, enabled: boolean): void;
      getSnapshot(): { rows: Array<{ id: string; status: string }>; pending: boolean };
    };
    expect(facade.getSnapshot().rows.find((row) => row.id === "node-history")?.status).toBe("active");

    facade.setEnabled("node-history", false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 面板读的是实时装配状态：卸下后直接是 disabled，不能停在 pending-disable。
    const after = facade.getSnapshot();
    expect(after.rows.find((row) => row.id === "node-history")?.status).toBe("disabled");
    expect(after.pending).toBe(false);

    facade.setEnabled("node-history", true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const restored = facade.getSnapshot();
    expect(restored.rows.find((row) => row.id === "node-history")?.status).toBe("active");
    expect(restored.pending).toBe(false);
  });
});
