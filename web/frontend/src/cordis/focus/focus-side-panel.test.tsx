/**
 * 聚焦侧栏 panel 渲染回归
 * （change: 2026-10-12-add-agent-conversation-panel，design D6a）。
 *
 * 覆盖实时缺陷：聚焦态（node-focus）没有任何宿主渲染声明
 * `focusPresentation: "sidebar"` 的详情 panel（“点了没反应”）；公共容器还需把该 panel 记为
 * 唯一侧栏（`data-focus-panel="detail"` 并预留宽度），与工作区检查器互斥、不并列。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Context } from "@deepseek-ai/cordis";
import { RuntimeProvider } from "../react.js";
import { startFrontendRuntime, type FrontendRuntime } from "../kernel.js";
import { CanvasPanelHost, CanvasFocusNodeHistoryHost, CanvasFocusSidePanelHost } from "../host.js";
import { FocusWorkspace, useFocusLayout } from "./workspace.js";
import type { FocusLayoutConfig } from "./layout.js";
import type { CanvasPanelDefinition, CanvasPanelRoute, CanvasPresentationSnapshot } from "../navigation/contracts.js";
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

const DETAIL_ROUTE: CanvasPanelRoute = { type: "agent-conversation", conversationId: "conv-1", requestId: "req-1" };
const HISTORY_ROUTE: CanvasPanelRoute = { type: "node-history", nodeId: "m1" };

/** 聚焦态导航 stub：返回 node-focus snapshot 并解析注册的 panel definition。 */
function navigationStub(definitions: Record<string, CanvasPanelDefinition>, route: CanvasPanelRoute | null = DETAIL_ROUTE) {
  const listeners = new Set<() => void>();
  let snapshot = {
    mode: { type: "node-focus" as const, nodeId: "m1", kind: "model" as const, owner: "direct" as const },
    panel: route,
    menu: null
  };
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    // 稳定 snapshot 引用：useSyncExternalStore 依赖同一对象（否则每次读取都判为变化形成死循环）。
    getSnapshot: () => snapshot,
    resolvePanel: (type: string) => definitions[type] ?? null,
    setRoute: (next: CanvasPanelRoute | null) => {
      snapshot = { ...snapshot, panel: next };
      for (const listener of listeners) listener();
    }
  };
}

async function mount(node: ReactNode, navigation: unknown): Promise<void> {
  runtime = await startFrontendRuntime({
    installPlatform: (ctx: Context) => { ctx.provide("canvasNavigation" as never, navigation as never); },
    plugins: []
  });
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => { root!.render(<RuntimeProvider runtime={runtime!}>{node}</RuntimeProvider>); });
}

describe("CanvasFocusSidePanelHost 聚焦侧栏渲染", () => {
  it.each([CanvasPanelHost, CanvasFocusSidePanelHost])("reopening the same conversation retries a previous render failure", async Host => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let broken = true;
    const navigation = navigationStub({
      "agent-conversation": {
        type: "agent-conversation", owner: "task-execution", focusPresentation: "sidebar",
        render: () => {
          if (broken) throw new Error("temporary detail failure");
          return <span data-testid="recovered-detail">detail</span>;
        }
      }
    });
    try {
      await mount(<Host writable />, navigation);
      expect(document.body.textContent).toContain("temporary detail failure");
      broken = false;
      act(() => navigation.setRoute({ ...DETAIL_ROUTE }));
      expect(document.querySelector('[data-testid="recovered-detail"]')).not.toBeNull();
    } finally { errors.mockRestore(); }
  });

  it("渲染声明 focusPresentation=\"sidebar\" 的 panel（放在公共侧栏容器内）", async () => {
    const definitions: Record<string, CanvasPanelDefinition> = {
      "agent-conversation": {
        type: "agent-conversation",
        owner: "task-execution",
        focusPresentation: "sidebar",
        render: () => <span data-testid="agent-detail">detail</span>
      }
    };
    await mount(<CanvasFocusSidePanelHost writable />, navigationStub(definitions));
    const wrapper = document.querySelector('[data-focus-side-panel="true"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.classList.contains("focus-workspace__panel")).toBe(true);
    expect(wrapper!.querySelector('[data-testid="agent-detail"]')).not.toBeNull();
  });

  it("不渲染未声明聚焦侧栏的 panel（如 node-history 由工作区自行处理）", async () => {
    const definitions: Record<string, CanvasPanelDefinition> = {
      "node-history": {
        type: "node-history",
        owner: "node-history",
        render: () => <span data-testid="history">history</span>
      }
    };
    await mount(<CanvasFocusSidePanelHost writable />, navigationStub(definitions, HISTORY_ROUTE));
    expect(document.querySelector('[data-focus-side-panel="true"]')).toBeNull();
    expect(document.querySelector('[data-testid="history"]')).toBeNull();
  });

  it("聚焦态单独渲染 node-history drawer（由工作区检查器位承载）", async () => {
    const definitions: Record<string, CanvasPanelDefinition> = {
      "node-history": {
        type: "node-history",
        owner: "node-history",
        render: () => <span data-testid="history">history</span>
      }
    };
    await mount(<CanvasFocusNodeHistoryHost writable />, navigationStub(definitions, HISTORY_ROUTE));
    expect(document.querySelector('[data-testid="history"]')).not.toBeNull();
    // 不套通用侧栏容器（该容器在 data-focus-panel="history" 下被隐藏）。
    expect(document.querySelector('[data-focus-side-panel="true"]')).toBeNull();
  });

  it("非 node-history route 时 node-history 宿主不渲染", async () => {
    const definitions: Record<string, CanvasPanelDefinition> = {
      "node-history": {
        type: "node-history",
        owner: "node-history",
        render: () => <span data-testid="history">history</span>
      }
    };
    await mount(<CanvasFocusNodeHistoryHost writable />, navigationStub(definitions, null));
    expect(document.querySelector('[data-testid="history"]')).toBeNull();
  });

  it("无 active route 时不渲染", async () => {
    const definitions: Record<string, CanvasPanelDefinition> = {
      "agent-conversation": {
        type: "agent-conversation",
        owner: "task-execution",
        focusPresentation: "sidebar",
        render: () => <span data-testid="agent-detail">detail</span>
      }
    };
    await mount(<CanvasFocusSidePanelHost writable />, navigationStub(definitions, null));
    expect(document.querySelector('[data-focus-side-panel="true"]')).toBeNull();
  });
});

describe("FocusWorkspace 聚焦侧栏占位（与检查器互斥）", () => {
  function stubRuntime() {
    const rects: Array<{ x: number; y: number; width: number; height: number } | null> = [];
    const service = { setFocusContentRect: (rect: { x: number; y: number; width: number; height: number } | null) => { rects.push(rect); } };
    return { rects, service: service as unknown as CanvasRuntimeService };
  }

  async function mountWorkspace(options: { sidePanel?: boolean; panel: CanvasPanelRoute | null; layout?: FocusLayoutConfig }) {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    const stub = stubRuntime();
    const surface = document.createElement("div");
    surface.getBoundingClientRect = () => ({ width: 1440, height: 1000, x: 0, y: 0, top: 0, left: 0, right: 1440, bottom: 1000, toJSON: () => ({}) }) as DOMRect;
    const presentation: CanvasPresentationSnapshot = {
      mode: { type: "node-focus", nodeId: "m1", kind: "model", owner: "direct" },
      panel: options.panel,
      menu: null
    };
    function Child({ layout }: { layout?: FocusLayoutConfig }) {
      // 缺省空配置与公共默认布局一致；显式配置用于自绘 chrome 用例。
      useFocusLayout(layout ?? {});
      return <div data-testid="workspace">workspace</div>;
    }
    await mount(
      <FocusWorkspace presentation={presentation} runtime={stub.service} surfaceRef={{ current: surface }} sidePanel={options.sidePanel}>
        <Child {...(options.layout ? { layout: options.layout } : {})} />
      </FocusWorkspace>,
      navigationStub({})
    );
    return stub;
  }

  it("侧栏 panel 打开时记为 detail 并预留宽度（不与检查器并列）", async () => {
    const stub = await mountWorkspace({ sidePanel: true, panel: DETAIL_ROUTE });
    const app = document.querySelector(".app")!;
    expect(app.getAttribute("data-focus-panel")).toBe("detail");
    // 侧栏宽度被预留（宽屏非 narrow）。
    expect(app.getAttribute("style")).toContain("--focus-panel-width: 320px");
    // contentRect 右侧 inset 因侧栏而收缩。
    const rect = stub.rects.at(-1);
    expect(rect).not.toBeNull();
    expect(rect!.x + rect!.width).toBeLessThan(1440);
  });

  it("无侧栏 panel 时不记为 detail", async () => {
    await mountWorkspace({ sidePanel: false, panel: null });
    expect(document.querySelector(".app")!.getAttribute("data-focus-panel")).toBe("closed");
  });

  it("自绘 chrome 的工作区把 header/footer 归零，并让历史 drawer 收缩内容宽度", async () => {
    const stub = await mountWorkspace({
      sidePanel: false,
      panel: HISTORY_ROUTE,
      layout: { chromeOwner: "workspace" }
    });
    const app = document.querySelector(".app")!;
    const style = app.getAttribute("style")!;
    expect(app.getAttribute("data-focus-panel")).toBe("history");
    expect(style).toContain("--focus-header: 0px");
    expect(style).toContain("--focus-footer: 0px");
    expect(style).toContain("--focus-panel-width: 320px");
    expect(style).toContain("--focus-content-width: 1120px");
    expect(style).toContain("--focus-content-height: 1000px");
    expect(stub.rects.at(-1)).toEqual({ x: 0, y: 0, width: 1120, height: 1000 });
  });
});
