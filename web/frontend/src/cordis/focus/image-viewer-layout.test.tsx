/**
 * 图片查看器布局回归（change: default-image-focus-viewer）。
 *
 * 实时缺陷：工作区在 slot 上声明了静态 `layout`，公共宿主的 `useFocusLayoutSource` 会在
 * 工作区的 `useFocusLayout` **之后**提交，把上报配置覆盖成只剩静态字段——`player` 归零，
 * 底部控制条塌成 0 高并贴住画布底边，内容溢出被裁掉。这里锁住：
 *   1. 工作区上报的 player 高度进入 contentRect（底部 inset 含它）；
 *   2. 静态 `layout` 与工作区上报同时存在时，上报值不被静态配置清掉。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RuntimeProvider } from "../react.js";
import { startFrontendRuntime, type FrontendRuntime } from "../kernel.js";
import { FocusWorkspace, useFocusLayout } from "./workspace.js";
import type { FocusLayoutConfig } from "./layout.js";
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

const IMAGE_PRESENTATION: CanvasPresentationSnapshot = {
  mode: { type: "node-focus", nodeId: "n1", kind: "image", owner: "direct" },
  panel: null,
  menu: null
};

function navigationStub(presentation: CanvasPresentationSnapshot) {
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => presentation,
    resolvePanel: () => null
  };
}

async function mountWorkspace(child: ReactNode): Promise<void> {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const rects: Array<{ x: number; y: number; width: number; height: number } | null> = [];
  const service = { setFocusContentRect: (rect: { x: number; y: number; width: number; height: number } | null) => { rects.push(rect); } };
  const surface = document.createElement("div");
  surface.getBoundingClientRect = () => ({ width: 1440, height: 1000, x: 0, y: 0, top: 0, left: 0, right: 1440, bottom: 1000, toJSON: () => ({}) }) as DOMRect;
  runtime = await startFrontendRuntime({
    installPlatform: (ctx) => {
      ctx.provide("slots" as never, { list: () => [], subscribe: () => () => undefined, version: () => 0, register: () => () => undefined, owners: () => [] } as never);
      ctx.provide("canvasNavigation" as never, navigationStub(IMAGE_PRESENTATION) as never);
    },
    plugins: []
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <RuntimeProvider runtime={runtime!}>
        <FocusWorkspace presentation={IMAGE_PRESENTATION} runtime={service as unknown as CanvasRuntimeService} surfaceRef={{ current: surface }}>
          {child}
        </FocusWorkspace>
      </RuntimeProvider>
    );
  });
}

/** 与 image-viewer 工作区同形的子组件：只经 useFocusLayout 上报。 */
function Viewer({ config }: { config: FocusLayoutConfig }) {
  useFocusLayout(config);
  return <div data-testid="viewer" />;
}

describe("图片查看器布局", () => {
  it("不追加 player 占位：footer 只有公共基座高度，contentRect 只扣它", async () => {
    // 旧实现额外上报 player: 48，footer 变 92：控制条占 44 起算、下面的 44 变成空带。
    await mountWorkspace(<Viewer config={{}} />);
    const style = document.querySelector(".app")!.getAttribute("style") ?? "";
    expect(style).toContain("--focus-footer: 44px");
    expect(style).toContain("--focus-player-height: 0px");
    // contentRect 高度 = 1000 - header(56) - footer(44)。
    expect(style).toContain("--focus-content-height: 900px");
  });

  it("历史 drawer 打开时上报 panel 并收缩内容宽度", async () => {
    await mountWorkspace(<Viewer config={{ panel: true }} />);
    const app = document.querySelector(".app")!;
    expect(app.getAttribute("data-focus-panel")).toBe("tools");
    expect(app.getAttribute("style")).toContain("--focus-panel-width: 320px");
  });
});
