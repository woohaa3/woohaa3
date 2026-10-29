/**
 * 布局所有权覆盖顺序（change: default-image-focus-viewer）。
 *
 * 公共宿主同时有两个配置来源：slot 上的静态 `layout`（`useFocusLayoutSource`）与工作区内部的
 * `useFocusLayout`。两者都写同一个 FocusLayoutContext，后提交者胜。本测试锁住**当前真实行为**，
 * 并说明为什么工作区不得再声明静态 layout：静态配置会清掉工作区上报的 player/panel。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RuntimeProvider } from "../react.js";
import { startFrontendRuntime, type FrontendRuntime } from "../kernel.js";
import { FocusWorkspace, useFocusLayout, useFocusLayoutSource } from "./workspace.js";
import type { CanvasPresentationSnapshot } from "../navigation/contracts.js";
import type { CanvasRuntimeService } from "../contract/canvas-runtime.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let runtime: FrontendRuntime | null = null;

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  await runtime?.dispose();
  runtime = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const PRESENTATION: CanvasPresentationSnapshot = {
  mode: { type: "node-focus", nodeId: "n1", kind: "image", owner: "direct" },
  panel: null,
  menu: null
};

async function mountWorkspace(child: ReactNode): Promise<void> {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const service = { setFocusContentRect: () => undefined };
  const surface = document.createElement("div");
  surface.getBoundingClientRect = () => ({ width: 1440, height: 1000, x: 0, y: 0, top: 0, left: 0, right: 1440, bottom: 1000, toJSON: () => ({}) }) as DOMRect;
  runtime = await startFrontendRuntime({
    installPlatform: (ctx) => {
      ctx.provide("slots" as never, { list: () => [], subscribe: () => () => undefined, version: () => 0, register: () => () => undefined, owners: () => [] } as never);
      ctx.provide("canvasNavigation" as never, { subscribe: () => () => undefined, getSnapshot: () => PRESENTATION, resolvePanel: () => null } as never);
    },
    plugins: []
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <RuntimeProvider runtime={runtime!}>
        <FocusWorkspace presentation={PRESENTATION} runtime={service as unknown as CanvasRuntimeService} surfaceRef={{ current: surface }}>
          {child}
        </FocusWorkspace>
      </RuntimeProvider>
    );
  });
}

describe("聚焦布局的所有权", () => {
  it("工作区上报的配置生效（静态 layout 缺席时）", async () => {
    function Viewer() { useFocusLayout({ player: 48 }); return null; }
    await mountWorkspace(<Viewer />);
    const style = document.querySelector(".app")!.getAttribute("style") ?? "";
    expect(style).toContain("--focus-player-height: 48px");
    expect(style).toContain("--focus-footer: 92px");
  });

  it("静态 layout 在子组件之后提交：它会把工作区上报的 player 清成 0（回归根因）", async () => {
    function Viewer() { useFocusLayout({ player: 48 }); return null; }
    function StaticLayout() { return <Viewer />; }
    // 模拟 slot 上声明静态 layout：公共宿主在子树之后调用 useFocusLayoutSource。
    function HostWithStaticLayout() {
      useFocusLayoutSource({ chromeOwner: "host" });
      return <StaticLayout />;
    }
    await mountWorkspace(<HostWithStaticLayout />);
    const style = document.querySelector(".app")!.getAttribute("style") ?? "";
    // 覆盖后 player 归零：底部控制条高度为 0，子元素向下溢出到画布底边。
    expect(style).toContain("--focus-player-height: 0px");
    expect(style).toContain("--focus-footer: 44px");
  });
});
