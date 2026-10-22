/**
 * AppRoot 渲染与 RuntimeProvider 嵌套回归
 * （change: unify-canvas-presentation-navigation，design D1）。
 *
 * 锁定的缺陷：`AppRoot` 自身在返回 `RuntimeProvider` 之前调用 `useService`，导致
 * 「缺少 RuntimeProvider」抛错、整棵 React 树无法挂载（进而 `<canvas id="bevy-canvas">`
 * 不存在，Bevy 起来即 panic）。测试用真实 App + Canvas page scope 渲染，断言 canvas 元素
 * 确实挂载且无抛错。
 *
 * @vitest-environment jsdom
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AppRoot } from "./app-host.js";
import { startApp, type AppRuntime } from "./page-scope.js";
import { createFakeCanvasCatalogRemote } from "./test-support/canvas-catalog.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
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

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  await app?.dispose();
  app = null;
  document.body.innerHTML = "";
});

function render(el: HTMLElement, runtime: AppRuntime): void {
  root = createRoot(el);
  act(() => {
    root!.render(<AppRoot app={runtime} />);
  });
}

describe("AppRoot RuntimeProvider 嵌套", () => {
  it("Canvas 页面渲染挂载 DOM canvas 且不抛缺少 RuntimeProvider", async () => {
    installGlobals();
    app = await startApp({ initialPathname: "/", canvasCatalogRemote: createFakeCanvasCatalogRemote() });
    const el = document.createElement("div");
    document.body.appendChild(el);
    // 若 useService 在 Provider 之外调用，这里会抛错。
    expect(() => render(el, app!)).not.toThrow();
    expect(document.querySelector("canvas#bevy-canvas")).not.toBeNull();
  });

  it("Task History 页面渲染独立 route（无 canvas）", async () => {
    installGlobals();
    app = await startApp({ initialPathname: "/task-history", canvasCatalogRemote: createFakeCanvasCatalogRemote() });
    const el = document.createElement("div");
    document.body.appendChild(el);
    expect(() => render(el, app!)).not.toThrow();
    expect(document.querySelector("canvas#bevy-canvas")).toBeNull();
  });
});
