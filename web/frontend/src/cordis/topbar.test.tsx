/**
 * 顶部栏在聚焦状态的呈现
 * （fix: 聚焦时仍保留顶部栏；Tauri 横栏右侧只有一个合并读数——同步/连接状态 + FPS/DC，
 *   悬停气泡向下展开，右下角工具栏不再重复显示同步状态）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Context } from "@deepseek-ai/cordis";
import { RuntimeProvider } from "./react.js";
import { startFrontendRuntime, type FrontendRuntime } from "./kernel.js";
import { SlotRegistry } from "./slots.js";
import { CanvasToolbarHost, CanvasTopBarHost } from "./host.js";
import type { SyncStatusView } from "./sync-status.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let runtime: FrontendRuntime | null = null;

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  await runtime?.dispose();
  runtime = null;
  delete (globalThis as unknown as { __WOOHAA_DESKTOP__?: unknown }).__WOOHAA_DESKTOP__;
  document.body.innerHTML = "";
});

const SYNC: SyncStatusView = { tone: "ok", label: "已同步", detail: "已同步 · revision 7", pinned: false };

async function mount(slots: SlotRegistry, ui: "topbar" | "toolbar" = "topbar") {
  runtime = await startFrontendRuntime({
    installPlatform: (ctx: Context) => {
      ctx.provide("slots" as never, slots as never);
    },
    plugins: []
  });
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => {
    root!.render(
      <RuntimeProvider runtime={runtime!}>
        {ui === "topbar"
          ? <CanvasTopBarHost revision={0} writable overview={false} sync={SYNC} />
          : <CanvasToolbarHost revision={0} writable sync={SYNC} />}
      </RuntimeProvider>
    );
  });
  return el;
}

function browserSlots() {
  const slots = new SlotRegistry();
  slots.register("canvas.topbar", {
    id: "canvas-switcher-trigger",
    owner: "canvas-switcher",
    render: () => <span data-testid="switcher">画布</span>
  });
  return slots;
}

function stubDesktop() {
  (globalThis as unknown as { __WOOHAA_DESKTOP__?: unknown }).__WOOHAA_DESKTOP__ = {
    protocol: "woohaa-window-v1",
    token: "test"
  };
}

/** 与 dev-performance 相同的贡献形态：用宿主 renderStatus 装配气泡。 */
function registerReadout(slots: SlotRegistry) {
  slots.register("canvas.topbar-status", {
    id: "dev-performance.topbar",
    owner: "dev-performance",
    wrapsStatus: true,
    render: ({ renderStatus }) => renderStatus(
      <span data-testid="fps-dc">FPS 60 DC 12</span>,
      <span data-testid="details">FPS 60.25 帧/秒；Draw Call 12.5 次/帧</span>
    )
  });
}

describe("顶部栏在聚焦状态的呈现", () => {
  it("浏览器：聚焦时让位给聚焦标题栏，不重复浮动顶栏", async () => {
    const el = await mount(browserSlots());
    expect(el.querySelector(".canvas-topbar")).toBeNull();
  });

  it("Tauri：聚焦（overview=false）仍渲染窗口横栏与窗口按钮", async () => {
    stubDesktop();
    const el = await mount(browserSlots());
    expect(el.querySelector(".desktop-canvas-bar")).not.toBeNull();
    expect(el.querySelector('[data-testid="switcher"]')).not.toBeNull();
    expect(el.querySelector('button[aria-label="最小化"]')).not.toBeNull();
  });

  it("Tauri：没有性能扩展时，横栏右侧仍显示同步状态", async () => {
    stubDesktop();
    const el = await mount(browserSlots());
    const trailing = el.querySelector(".desktop-canvas-bar__trailing");
    expect(trailing).not.toBeNull();
    const status = trailing!.querySelector(".canvas-control-panel__status")!;
    expect(status.getAttribute("data-placement")).toBe("down");
    expect(trailing!.querySelector('[role="tooltip"]')!.textContent).toContain("revision 7");
  });

  it("Tauri：同步状态与 FPS/DC 合并在同一个读数气泡里，靠右且位于窗口按钮之前", async () => {
    stubDesktop();
    const slots = browserSlots();
    registerReadout(slots);
    const el = await mount(slots);
    const trailing = el.querySelector(".desktop-canvas-bar__trailing")!;
    const statuses = trailing.querySelectorAll(".canvas-control-panel__status");
    // 只有一个合并读数，而不是同步一个、性能一个。
    expect(statuses).toHaveLength(1);
    const status = statuses[0]!;
    // 紧凑内容显示 FPS/DC。
    expect(status.querySelector('[data-testid="fps-dc"]')).not.toBeNull();
    // 气泡同时包含性能详情与同步详情。
    const bubble = status.querySelector('[role="tooltip"]')!;
    expect(bubble.textContent).toContain("60.25 帧/秒");
    expect(bubble.textContent).toContain("Draw Call 12.5 次/帧");
    expect(bubble.textContent).toContain("revision 7");
    expect(status.querySelector('[title]')).toBeNull();
    // 不在 flex:1 的左侧内容区，且在窗口按钮之前。
    expect(el.querySelector(".desktop-canvas-bar__content")!.contains(trailing)).toBe(false);
    const actions = el.querySelector(".desktop-canvas-bar__actions")!;
    expect(actions.compareDocumentPosition(trailing) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it("Tauri：右下角工具栏不再重复渲染同步状态", async () => {
    stubDesktop();
    const slots = browserSlots();
    slots.register("canvas.toolbar", {
      id: "canvas-zoom",
      owner: "canvas-shell",
      render: () => <span data-testid="zoom">zoom</span>
    });
    const el = await mount(slots, "toolbar");
    expect(el.querySelector('[data-testid="zoom"]')).not.toBeNull();
    expect(el.querySelector(".canvas-control-panel__status")).toBeNull();
  });

  it("浏览器：工具栏仍保留同步状态与向上气泡", async () => {
    const slots = browserSlots();
    slots.register("canvas.toolbar", {
      id: "canvas-zoom",
      owner: "canvas-shell",
      render: () => <span data-testid="zoom">zoom</span>
    });
    const el = await mount(slots, "toolbar");
    const status = el.querySelector(".canvas-control-panel__status");
    expect(status).not.toBeNull();
    expect(status!.getAttribute("data-placement")).toBe("up");
    expect(el.querySelector('[role="tooltip"]')!.textContent).toContain("revision 7");
  });

  it("浏览器：不渲染顶栏读数与顶栏气泡", async () => {
    const slots = browserSlots();
    registerReadout(slots);
    const el = await mount(slots);
    expect(el.querySelector(".desktop-canvas-bar__trailing")).toBeNull();
    expect(el.querySelector('[data-testid="fps-dc"]')).toBeNull();
  });
});
