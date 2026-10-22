/**
 * 画布跳转的节点目标装配测试（change: task-monitor-canvas-roundtrip）。
 *
 * 覆盖 page scope：`{ page: "canvas", canvasId, nodeId }` 打开后，画布数据到达时定位并
 * 选中该节点；离开画布后迟到的节点目标不再生效。
 *
 * @vitest-environment jsdom
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { startApp, type AppRuntime } from "./page-scope.js";
import { createFakeCanvasCatalogRemote } from "./test-support/canvas-catalog.js";
import { createSourceExtensionRuntimeService } from "./test-support/source-extensions.js";
import { canvasFixture } from "./plugins/task-execution/test-support/fixtures.js";
import { woohaa3CanvasStore } from "./services/canvas-state/index.js";

const DEFAULT_CANVAS = "woohaa3-default-canvas";

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

function startTestApp(options: Parameters<typeof startApp>[0] = {}): Promise<AppRuntime> {
  return startApp({
    extensionRuntime: createSourceExtensionRuntimeService(),
    ...options,
    canvasCatalogRemote: createFakeCanvasCatalogRemote()
  });
}

/** 替换定位服务：jsdom 没有 Bevy/交互控制器，只验证 page scope 是否驱动定位。 */
function stubLocate(runtime: AppRuntime): string[][] {
  const located: string[][] = [];
  const service = runtime.currentPage()!.ctx.canvasLocate as unknown as {
    locateNodes(nodeIds: readonly string[]): { ok: boolean };
  };
  service.locateNodes = (nodeIds) => {
    located.push([...nodeIds]);
    return { ok: true };
  };
  return located;
}

afterEach(async () => {
  await app?.dispose();
  app = null;
  // 模块级 store 在同文件用例间共享：恢复空画布，避免上一条的节点影响下一条。
  woohaa3CanvasStore.getState().applyRemoteCanvas(createEmptyWoohaa3ServerCanvas(DEFAULT_CANVAS));
});

describe("画布打开时的节点目标", () => {
  it("带 nodeId 跳转画布：画布数据到达后定位并选中该节点", async () => {
    installGlobals();
    app = await startTestApp({ initialPathname: "/admin/tasks" });
    await app.applyLocation({ page: "canvas", canvasId: DEFAULT_CANVAS, nodeId: "n1" });
    expect(app.router.getLocation()).toMatchObject({ page: "canvas", canvasId: DEFAULT_CANVAS, nodeId: "n1" });
    const located = stubLocate(app);
    // 点击跳转时画布数据通常还没到：先不定位。
    expect(located).toHaveLength(0);
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasFixture({ nodes: [{ id: "n1", type: "image" }] }));
    expect(located).toEqual([["n1"]]);
  });

  it("目标节点不在画布上时不定位（失效深链接不阻塞画布）", async () => {
    installGlobals();
    app = await startTestApp({ initialPathname: "/admin/tasks" });
    await app.applyLocation({ page: "canvas", canvasId: DEFAULT_CANVAS, nodeId: "gone" });
    const located = stubLocate(app);
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasFixture({ nodes: [{ id: "n1", type: "image" }] }));
    expect(located).toHaveLength(0);
  });

  it("离开画布后迟到的节点目标不再定位", async () => {
    installGlobals();
    app = await startTestApp({ initialPathname: "/admin/tasks" });
    await app.applyLocation({ page: "canvas", canvasId: DEFAULT_CANVAS, nodeId: "n1" });
    const located = stubLocate(app);
    await app.applyLocation({ page: "task-monitor", query: {} });
    // 旧 scope 已释放：即使画布 store 再出现该节点，也不应触发定位。
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasFixture({ nodes: [{ id: "n1", type: "image" }] }));
    expect(located).toHaveLength(0);
  });
});
