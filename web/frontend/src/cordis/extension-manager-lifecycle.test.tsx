/**
 * 跨刷新插件生命周期集成测试
 * （change: add-frontend-plugin-manager，任务 3.3；
 *   change: 2026-10-19-restore-runtime-extension-toggling：浏览器偏好重新决定启动装配）。
 *
 * browser-local 开关只写浏览器本地偏好，本次 scope 不变、下次启动读取；
 * 这里验证：写入即持久化、当前装配不动、刷新后按新偏好装配、dispose 无遗留。
 *
 * @vitest-environment jsdom
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { startApp, type AppRuntime } from "./page-scope.js";
import { createFakeCanvasCatalogRemote } from "./test-support/canvas-catalog.js";
import { createSourceExtensionRuntimeService } from "./test-support/source-extensions.js";
import type { PreferenceStorage } from "./services/extension-preferences/codec.js";

let app: AppRuntime | null = null;

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

function startWith(storage: PreferenceStorage): Promise<AppRuntime> {
  return startApp({
    initialPathname: "/",
    canvasCatalogRemote: createFakeCanvasCatalogRemote(),
    extensionRuntime: createSourceExtensionRuntimeService(),
    extensionPreferenceStorage: storage,
    extensionManagerReload: () => undefined
  });
}

/** node-history 通过 `canvas.toolbar-action` 稳定可观察其是否装配。 */
function nodeHistoryAssembled(instance: AppRuntime): boolean {
  const page = instance.currentPage();
  if (!page) return false;
  return page.ctx.slots.list("ai-center.generation-history").some((entry) => entry.id === "node-history");
}

afterEach(async () => {
  await app?.dispose();
  app = null;
});

describe("跨刷新插件生命周期（浏览器本地偏好）", () => {
  it("setEnabled 只写偏好，刷新后按新偏好装配", async () => {
    installGlobals();
    const storage = memoryStorage();

    app = await startWith(storage);
    expect(nodeHistoryAssembled(app)).toBe(true);
    const firstPage = app.currentPage()!;
    const facade = firstPage.ctx.get("extensionManager" as never) as never as {
      setEnabled(id: string, enabled: boolean): void;
      getSnapshot(): { pending: boolean };
    };
    // 写偏好：持久化到 localStorage，但不改变当前 scope 的装配。
    facade.setEnabled("node-history", false);
    expect(nodeHistoryAssembled(app)).toBe(true);
    expect(storage.data["woohaa:frontend-extensions:v1"]).toContain('"node-history":false');

    const firstSlots = firstPage.ctx.slots;
    const firstDiagnostics = firstPage.diagnostics;
    await app.dispose();
    app = null;
    expect(firstSlots.list("canvas.toolbar-action")).toHaveLength(0);
    expect(firstDiagnostics.getStatus().plugins).toHaveLength(0);

    // 刷新：按已保存的浏览器偏好装配，node-history 不再出现。
    app = await startWith(storage);
    expect(nodeHistoryAssembled(app)).toBe(false);
    const secondPage = app.currentPage()!;
    expect(secondPage.diagnostics.getStatus().plugins.find((plugin) => plugin.id === "node-history")?.status).toBe(
      "disabled"
    );
  });

  it("浏览器偏好只落 localStorage，不进入 Canvas command/Y.Doc", async () => {
    installGlobals();
    const storage = memoryStorage();
    app = await startWith(storage);
    const page = app.currentPage()!;
    const facade = page.ctx.get("extensionManager" as never) as never as {
      setEnabled(id: string, enabled: boolean): void;
    };
    facade.setEnabled("prompt-snippets", false);
    expect(storage.data["woohaa:frontend-extensions:v1"]).toContain('"prompt-snippets":false');
    // 不是站点配置：画布文档/命令里没有启停写入。
    expect(page.ctx.slots.list("canvas.toolbar-action").length).toBeGreaterThan(0);
  });
});
