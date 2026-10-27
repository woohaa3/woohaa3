/**
 * 右下角统一控件面板渲染测试
 * （change: unify-canvas-corner-controls）。
 *
 * 断言概览区（`canvas.minimap` + `canvas.minimap-side`）、唯一工具行
 * （`canvas.toolbar` 视图控件 + `canvas.toolbar-action` 图标按钮）与状态读数
 * 聚合到同一个 `.canvas-control-panel` 容器，而不是各自浮动。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Context } from "@deepseek-ai/cordis";
import { SlotRegistry } from "./slots.js";
import { AuthoringGenerateHost, CanvasToolbarHost, CanvasTopBarHost } from "./host.js";
import { RuntimeProvider } from "./react.js";
import { startFrontendRuntime, type FrontendRuntime } from "./kernel.js";
import { rememberAssistantPreference } from "./services/assistant-execution/selection.js";

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
  localStorage.clear();
});

async function makeRuntime(slots: SlotRegistry): Promise<FrontendRuntime> {
  return startFrontendRuntime({
    installPlatform: (ctx: Context) => {
      ctx.provide("slots" as never, slots as never);
    },
    plugins: []
  });
}

function renderHost(
  instance: FrontendRuntime,
  sync?: import("./sync-status.js").SyncStatusView,
  onReconnect?: () => void
) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => {
    root!.render(
      <RuntimeProvider runtime={instance}>
        <CanvasToolbarHost revision={0} writable {...(sync ? { sync } : {})} {...(onReconnect ? { onReconnect } : {})} />
      </RuntimeProvider>
    );
  });
  return el;
}

/** 渲染桌面横栏（Tauri 分支）；同步状态合并进右侧读数气泡。 */
function renderTopBar(
  instance: FrontendRuntime,
  sync?: import("./sync-status.js").SyncStatusView,
  onReconnect?: () => void
) {
  (globalThis as unknown as { __WOOHAA_DESKTOP__?: unknown }).__WOOHAA_DESKTOP__ = {
    protocol: "woohaa-window-v1",
    token: "test"
  };
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => {
    root!.render(
      <RuntimeProvider runtime={instance}>
        <CanvasTopBarHost revision={0} writable overview={false} {...(sync ? { sync } : {})} {...(onReconnect ? { onReconnect } : {})} />
      </RuntimeProvider>
    );
  });
  return el;
}

/** 断线态的冻结展示模型：气泡常驻，并带未置灰的「重新连接」动作。 */
const OFFLINE_SYNC: import("./sync-status.js").SyncStatusView = {
  tone: "danger",
  label: "网络已断开，画布只读",
  detail: "网络已断开，画布只读。",
  pinned: true,
  action: { kind: "reconnect", label: "重新连接", busy: false }
};

/** 在给定容器里找气泡内的「重新连接」按钮。 */
function reconnectButton(scope: ParentNode): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "重新连接");
}

const panel = () => document.querySelector(".canvas-control-panel");

describe("CanvasToolbarHost 统一面板", () => {
  it("小地图与右侧缩放同处概览区，动作与撤销同处唯一工具行", async () => {
    const slots = new SlotRegistry();
    slots.register("canvas.minimap", {
      id: "canvas-minimap",
      owner: "canvas-shell",
      render: () => <span data-testid="minimap">map</span>
    });
    slots.register("canvas.minimap-side", {
      id: "canvas-zoom",
      owner: "canvas-shell",
      position: "right",
      render: () => <span data-testid="zoom">zoom</span>
    });
    slots.register("canvas.toolbar", {
      id: "canvas-undo",
      owner: "canvas-shell",
      render: () => <span data-testid="undo">undo</span>
    });
    slots.register("canvas.toolbar-action", {
      id: "prompt-snippets-library",
      owner: "prompt-snippets",
      label: "提示词片段管理",
      icon: () => <svg data-testid="snippet-icon" />,
      onActivate: () => undefined
    });
    runtime = await makeRuntime(slots);
    const el = renderHost(runtime);
    const overview = el.querySelector(".canvas-control-panel__overview")!;
    const rows = el.querySelectorAll(".canvas-control-panel__row");
    // 底部只剩一条工具行。
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    const minimap = overview.querySelector('[data-testid="minimap"]')!;
    const zoom = overview.querySelector('[data-testid="zoom"]')!;
    expect(minimap).not.toBeNull();
    expect(zoom).not.toBeNull();
    // 小地图在前，侧栏内容在后。
    expect(minimap.compareDocumentPosition(zoom) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 概览区在工具行上方。
    expect(overview.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.querySelector('button[aria-label="提示词片段管理"]')).not.toBeNull();
    expect(row.querySelector('[data-testid="undo"]')).not.toBeNull();
  });

  it("无 contribution 时不渲染面板", async () => {
    runtime = await makeRuntime(new SlotRegistry());
    renderHost(runtime);
    expect(panel()).toBeNull();
  });

  it("小地图悬停收起后，工具行上方保留缩放条与展开按钮", async () => {
    const slots = new SlotRegistry();
    slots.register("canvas.minimap", {
      id: "canvas-minimap",
      owner: "canvas-shell",
      render: ({ onCollapse }) => (
        <button type="button" data-testid="minimap-collapse" onClick={() => onCollapse?.()}>
          map
        </button>
      )
    });
    slots.register("canvas.minimap-side", {
      id: "canvas-zoom",
      owner: "canvas-shell",
      position: "right",
      render: () => <span data-testid="zoom">zoom</span>
    });
    slots.register("canvas.toolbar-action", {
      id: "minimap-test-action",
      owner: "canvas-shell",
      label: "测试动作",
      icon: () => <svg data-testid="test-icon" />,
      onActivate: () => undefined
    });
    runtime = await makeRuntime(slots);
    const el = renderHost(runtime);
    expect(el.querySelector(".canvas-control-panel__overview")).not.toBeNull();
    // 不显示「小地图」三个字：收起按钮只给图标与悬停说明。
    expect(el.textContent).not.toContain("小地图");
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="minimap-collapse"]')!.click());
    expect(el.querySelector(".canvas-control-panel__overview")).toBeNull();
    expect(el.querySelector('[data-testid="minimap-collapse"]')).toBeNull();
    // 收起后工具行上方保留一条窄条：横向缩放条 + 展开小地图。
    const bar = el.querySelector(".canvas-control-panel__collapsed-bar")!;
    expect(bar).not.toBeNull();
    expect(bar.querySelector('[data-testid="zoom"]')).not.toBeNull();
    const expand = bar.querySelector<HTMLButtonElement>('button[aria-label="展开小地图"]');
    expect(expand).not.toBeNull();
    // 动作仍在工具行，不在收起条里。
    expect(bar.querySelector('[data-testid="test-icon"]')).toBeNull();
    expect(el.querySelector('[data-testid="test-icon"]')).not.toBeNull();
    const row = el.querySelector(".canvas-control-panel__row")!;
    expect(bar.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => expand!.click());
    expect(el.querySelector(".canvas-control-panel__overview")).not.toBeNull();
    expect(el.querySelector(".canvas-control-panel__collapsed-bar")).toBeNull();
  });

  it("缩放条与多个功能图标（含生成历史）同处一个面板，只有一条工具行", async () => {
    const slots = new SlotRegistry();
    slots.register("canvas.minimap-side", {
      id: "canvas-zoom",
      owner: "canvas-shell",
      position: "right",
      render: () => <span data-testid="zoom">zoom</span>
    });
    slots.register("canvas.toolbar-action", {
      id: "prompt-snippets-library",
      owner: "prompt-snippets",
      label: "提示词片段管理",
      icon: () => <svg data-testid="snippet-icon" />,
      onActivate: () => undefined
    });
    slots.register("canvas.toolbar-action", {
      id: "node-history-all",
      owner: "node-history",
      label: "生成历史",
      icon: () => <svg data-testid="history-icon" />,
      onActivate: () => undefined
    });
    runtime = await makeRuntime(slots);
    renderHost(runtime);
    const el = panel();
    expect(el).not.toBeNull();
    const rows = el!.querySelectorAll(".canvas-control-panel__row");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.querySelector('button[aria-label="提示词片段管理"]')).not.toBeNull();
    expect(row.querySelector('button[aria-label="生成历史"] [data-testid="history-icon"]')).not.toBeNull();
    expect(el!.querySelector('.canvas-control-panel__overview [data-testid="zoom"]')).not.toBeNull();
  });

  it("图标动作 tone=primary 时用强调色实底并保持注册顺序", async () => {
    const slots = new SlotRegistry();
    slots.register("canvas.toolbar-action", {
      id: "agent-assistant",
      owner: "agent-assistant",
      priority: 0,
      label: "AI 助手",
      icon: () => <svg data-testid="assistant-icon" />,
      tone: "primary",
      onActivate: () => undefined
    });
    slots.register("canvas.toolbar-action", {
      id: "prompt-snippets-library",
      owner: "prompt-snippets",
      priority: 10,
      label: "提示词片段管理",
      icon: () => <svg data-testid="snippet-icon" />,
      onActivate: () => undefined
    });
    runtime = await makeRuntime(slots);
    renderHost(runtime);
    const buttons = [...panel()!.querySelectorAll<HTMLButtonElement>(".canvas-control-panel__actions button")];
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["AI 助手", "提示词片段管理"]);
    expect(buttons[0]!.className).toContain("canvas-control-panel__icon--primary");
    expect(buttons[1]!.className).not.toContain("canvas-control-panel__icon--primary");
  });

  it("图标动作 available=false 时整个面板不渲染（可用性过滤）", async () => {
    const slots = new SlotRegistry();
    slots.register("canvas.toolbar-action", {
      id: "prompt-snippets-library",
      owner: "prompt-snippets",
      label: "提示词片段管理",
      icon: () => <svg />,
      onActivate: () => undefined,
      available: () => false
    });
    runtime = await makeRuntime(slots);
    renderHost(runtime);
    // slot.list() 会过滤 unavailable contribution；无可渲染内容时不出现面板。
    expect(panel()).toBeNull();
  });

  it("同步状态：无性能贡献时显示小字入口，hover 气泡含 revision", async () => {
    runtime = await makeRuntime(new SlotRegistry());
    renderHost(runtime, {
      tone: "ok",
      label: "已同步",
      detail: "已同步 · revision 7",
      pinned: false
    });
    const el = panel();
    expect(el).not.toBeNull();
    // 只有状态时也算有内容，面板仍渲染。
    const icon = el!.querySelector('.canvas-control-panel__status-readout');
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute("aria-label")).toBe("已同步");
    expect(icon!.textContent).toBe("状态");
    expect(icon!.querySelector("svg")).toBeNull();
    // 稳态不常驻文案（旧的一行字已移除）。
    expect(el!.querySelector(".canvas-control-panel__status-text")).toBeNull();
    // 气泡存在、非 pinned，且含 revision。
    const bubble = el!.querySelector(".canvas-control-panel__status-bubble");
    expect(bubble).not.toBeNull();
    expect(bubble!.getAttribute("data-pinned")).toBeNull();
    expect(bubble!.textContent).toContain("revision 7");
  });

  it("同步状态与功能图标同处唯一工具行：功能靠左、状态靠右", async () => {
    const slots = new SlotRegistry();
    slots.register("canvas.toolbar-action", {
      id: "prompt-snippets-library",
      owner: "prompt-snippets",
      label: "提示词片段管理",
      icon: () => <svg data-testid="snippet-icon" />,
      onActivate: () => undefined
    });
    runtime = await makeRuntime(slots);
    renderHost(runtime, { tone: "ok", label: "已同步", detail: "已同步 · revision 7", pinned: false });
    const el = panel();
    const actionRow = el!.querySelector(".canvas-control-panel__row");
    expect(actionRow).not.toBeNull();
    // 同一行同时包含功能图标与状态图标。
    expect(actionRow!.querySelector(".canvas-control-panel__actions button")).not.toBeNull();
    expect(actionRow!.querySelector(".canvas-control-panel__status-readout")).not.toBeNull();
    // 功能组在 DOM 中先于状态组（靠左）。
    const actions = actionRow!.querySelector(".canvas-control-panel__actions")!;
    const status = actionRow!.querySelector(".canvas-control-panel__status")!;
    expect(actions.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("性能读数进入原同步入口，保留同步异常详情，卸载后恢复状态小字", async () => {
    const slots = new SlotRegistry();
    const remove = slots.register("canvas.toolbar-status", {
      id: "performance", owner: "test",
      wrapsStatus: true,
      render: ({ renderStatus }) => renderStatus(
        <svg><text>FPS 60</text><text>DC 120</text></svg>,
        <span>FPS 60.25 帧/秒；Draw Call 120.75 次/帧</span>
      )
    });
    runtime = await makeRuntime(slots);
    renderHost(runtime, { tone: "danger", label: "画布只读", detail: "网络已断开，画布只读", pinned: true });
    const readout = panel()!.querySelector(".canvas-control-panel__status-readout")!;
    expect(readout.textContent).toBe("FPS 60DC 120");
    expect(panel()!.querySelectorAll("svg")).toHaveLength(1);
    expect(panel()!.querySelector('[data-pinned="true"]')?.textContent).toContain("网络已断开");
    expect(panel()!.querySelector('[role="tooltip"]')?.textContent).toContain("FPS 60.25 帧/秒；Draw Call 120.75 次/帧");
    expect(panel()!.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    await act(async () => remove());
    expect(panel()!.querySelector(".canvas-control-panel__status-readout")?.textContent).toBe("状态");
    expect(panel()!.querySelector('[role="tooltip"]')?.textContent).not.toContain("Draw Call");
  });

  it("HMR 后仍加载旧版 SVG 贡献时，宿主继续提供 hover 气泡", async () => {
    const slots = new SlotRegistry();
    slots.register("canvas.toolbar-status", {
      id: "legacy-performance", owner: "test",
      render: () => <svg><text>FPS 60</text><text>DC 120</text></svg>
    });
    runtime = await makeRuntime(slots);
    renderHost(runtime, { tone: "ok", label: "已同步", detail: "已同步 · revision 7", pinned: false });
    expect(panel()!.querySelector(".canvas-control-panel__status-readout")?.textContent).toBe("FPS 60DC 120");
    expect(panel()!.querySelector('[role="tooltip"]')?.textContent).toContain("revision 7");
  });

  it("同步状态：异常态气泡常驻展开，不再另起一行文案，且只含同步信息", async () => {
    runtime = await makeRuntime(new SlotRegistry());
    renderHost(runtime, {
      tone: "danger",
      label: "网络已断开，画布只读",
      detail: "网络已断开，画布只读",
      pinned: true
    });
    const el = panel();
    // 旧的一行常驻文案已移除；异常态改由气泡承载。
    expect(el!.querySelector(".canvas-control-panel__status-text")).toBeNull();
    const bubble = el!.querySelector(".canvas-control-panel__status-bubble");
    expect(bubble).not.toBeNull();
    expect(bubble!.getAttribute("data-pinned")).toBe("true");
    expect(bubble!.textContent).toContain("网络已断开，画布只读");
    // MCP 指引已移到 AI 面板 MCP tab（change: move-mcp-guide-to-bottom-hint）。
    expect(bubble!.textContent).not.toContain("MCP");
    expect(el!.querySelector(".canvas-control-panel__status.is-danger")).not.toBeNull();
  });

  it("同步状态气泡不再渲染 MCP 复制入口", async () => {
    runtime = await makeRuntime(new SlotRegistry());
    renderHost(runtime, {
      tone: "ok",
      label: "已同步",
      detail: "已同步 · revision 1",
      pinned: false
    });
    expect(panel()!.querySelector(".canvas-control-panel__status-copy")).toBeNull();
  });
});

describe("状态气泡的显式重连入口（change 2026-10-21-recover-canvas-connection-explicitly）", () => {
  it("断线态气泡常驻，含「重新连接」按钮且点击触发 onReconnect", async () => {
    let reconnects = 0;
    runtime = await makeRuntime(new SlotRegistry());
    renderHost(runtime, OFFLINE_SYNC, () => { reconnects += 1; });
    const bubble = panel()!.querySelector(".canvas-control-panel__status-bubble")!;
    expect(bubble.getAttribute("data-pinned")).toBe("true");
    const button = reconnectButton(bubble);
    expect(button).not.toBeUndefined();
    expect(button!.disabled).toBe(false);
    await act(async () => button!.click());
    expect(reconnects).toBe(1);
  });

  it("重建中（busy）时按钮置灰且点击无效", async () => {
    let reconnects = 0;
    runtime = await makeRuntime(new SlotRegistry());
    renderHost(runtime, {
      tone: "warning",
      label: "正在重新连接…",
      detail: "正在重新连接画布服务…",
      pinned: true,
      action: { kind: "reconnect", label: "重新连接", busy: true }
    }, () => { reconnects += 1; });
    const button = reconnectButton(panel()!.querySelector(".canvas-control-panel__status-bubble")!);
    expect(button).not.toBeUndefined();
    expect(button!.disabled).toBe(true);
    await act(async () => button!.click());
    expect(reconnects).toBe(0);
  });

  it("稳态气泡不带动作按钮", async () => {
    runtime = await makeRuntime(new SlotRegistry());
    renderHost(runtime, { tone: "ok", label: "已同步", detail: "已同步 · revision 7", pinned: false });
    expect(reconnectButton(panel()!)).toBeUndefined();
  });

  it("性能读数的新旧两种包裹分支都保留重连按钮", async () => {
    for (const wrapsStatus of [true, false]) {
      const slots = new SlotRegistry();
      slots.register("canvas.toolbar-status", {
        id: `performance-${wrapsStatus}`,
        owner: "test",
        ...(wrapsStatus ? { wrapsStatus: true } : {}),
        render: wrapsStatus
          ? ({ renderStatus }) => renderStatus(<span>FPS 60</span>, <span>FPS 60.25 帧/秒</span>)
          : () => <span>FPS 60</span>
      });
      runtime = await makeRuntime(slots);
      let reconnects = 0;
      renderHost(runtime, OFFLINE_SYNC, () => { reconnects += 1; });
      const button = reconnectButton(panel()!.querySelector('[role="tooltip"]')!);
      expect(button).not.toBeUndefined();
      await act(async () => button!.click());
      expect(reconnects).toBe(1);
      // 清理本轮挂载，进入下一分支（复用一个测试体避免重复样板）。
      act(() => root?.unmount());
      root = null;
      await runtime.dispose();
      runtime = null;
      document.body.innerHTML = "";
    }
  });

  it("桌面顶栏（Tauri 横栏）的状态气泡同样提供重连按钮", async () => {
    let reconnects = 0;
    runtime = await makeRuntime(new SlotRegistry());
    renderTopBar(runtime, OFFLINE_SYNC, () => { reconnects += 1; });
    const status = document.querySelector(".desktop-canvas-bar__trailing .canvas-control-panel__status")!;
    expect(status.getAttribute("data-placement")).toBe("down");
    const button = reconnectButton(status.querySelector('[role="tooltip"]')!);
    expect(button).not.toBeUndefined();
    await act(async () => button!.click());
    expect(reconnects).toBe(1);
  });
});

describe("AuthoringGenerateHost 宿主内置生成面板（change 2026-10-16，任务 9.1/9.4 / design D10）", () => {
  /** 注册来源贡献（只声明 sourceId/sourceLabel），并注入按 adapter 返回连接的会话 service。 */
  async function renderAuthoring(options: {
    contributions?: Array<{ id: string; sourceId?: string; sourceLabel?: string }>;
    mode?: "model3d" | "camera" | "film-set";
    delivery?: import("./contract/authoring.js").AssistantDeliveryTarget;
    connectionsFor?: (adapterId?: string) => Array<{ connectionId: string; name: string; ready: boolean; authMode?: "api-key" | "oauth" | "local-login"; adapterId?: string; reason?: string | null }>;
    findConversationForTarget?: () => Promise<unknown>;
    serviceOverrides?: Partial<import("./contract/agent-conversation.js").AgentConversationService>;
  }) {
    const slots = new SlotRegistry();
    const removeContributions = new Map<string, () => void>();
    if (options.delivery) slots.register("authoring.delivery", { id: "conversion", owner: "film-set", resolve: () => options.delivery! });
    for (const entry of options.contributions ?? []) {
      const remove = slots.register("authoring.generate", {
        id: entry.id,
        owner: entry.id,
        ...(entry.sourceId ? { sourceId: entry.sourceId } : {}),
        ...(entry.sourceLabel ? { sourceLabel: entry.sourceLabel } : {})
      });
      removeContributions.set(entry.id, remove);
    }
    const stableSnapshot = { conversations: [], active: null, detail: null, mcp: null, loading: false, error: null, contextRevision: 0 };
    const listedAdapters: Array<string | undefined> = [];
    const fakeService = {
      subscribe: () => () => undefined,
      getSnapshot: () => stableSnapshot,
      findConversationForTarget: options.findConversationForTarget ?? (async () => ({ ok: true, value: { conversation: null } })),
      listConnections: async (adapterId?: string) => {
        listedAdapters.push(adapterId);
        return { ok: true, value: (options.connectionsFor ?? (() => []))(adapterId).map((entry) => ({ ...entry, adapterId: entry.adapterId ?? options.contributions?.[0]?.sourceId ?? options.contributions?.[0]?.id })) };
      },
      navigateToDetail: () => undefined,
      ...options.serviceOverrides
    };
    runtime = await startFrontendRuntime({
      installPlatform: (ctx: Context) => {
        ctx.provide("slots" as never, slots as never);
        ctx.provide("agentConversationService" as never, fakeService as never);
      },
      plugins: []
    });
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => {
      root!.render(
        <RuntimeProvider runtime={runtime!}>
          <AuthoringGenerateHost canvasId="cv" nodeId="n1" mode={options.mode ?? "model3d"} writable />
        </RuntimeProvider>
      );
      // 等待真实按需模块加载；两个微任务不足以覆盖动态 import。
      await import("./plugins/task-execution/authoring-model-generate-panel.js");
      await import("./plugins/task-execution/authoring-generate-panel.js");
    });
    return { el, listedAdapters, slots, removeContributions };
  }

  it.each([false, true])("全局连接用于新目标，已有会话优先恢复自己的连接（history=%s）", async hasHistory => {
    rememberAssistantPreference("page", { sourceId: "local", connectionId: "second" });
    const { el } = await renderAuthoring({
      contributions: [{ id: "local", sourceId: "local" }],
      connectionsFor: () => [{ connectionId: "first", name: "节点原助手", ready: true, authMode: "local-login" }, { connectionId: "second", name: "全局助手", ready: true, authMode: "local-login" }],
      serviceOverrides: { findConversationForTarget: async input => ({ ok: true, value: { conversation: hasHistory && !input.connectionId ? { connectionId: "first" } as never : null } }) }
    });
    expect(el.querySelector('button[aria-label="选择助手"]')?.textContent).toContain(hasHistory ? "节点原助手" : "全局助手");
  });

  it.each(["running", "failed", "unknown", "cancelled"] as const)("片场 %s 交付仍渲染原执行面板与工具栏", async status => {
    const { el } = await renderAuthoring({ mode: "film-set", delivery: { status, stage: "转换状态", query: async () => ({ ok: true }) } });
    const panel = el.querySelector('[data-testid="authoring-generate"]');
    expect(panel?.classList.contains("mc-panel")).toBe(true);
    expect(panel?.getAttribute("data-presentation")).toBe("dock");
    expect(panel?.textContent).toContain("转换状态");
    expect(el.querySelector("textarea")?.disabled).toBe(true);
    expect(panel?.querySelector(".assistant-toolbar")).not.toBeNull();
  });

  it("无任何来源扩展时仍渲染内置面板并提示配置来源（MUST NOT 隐藏生成入口）", async () => {
    const { el } = await renderAuthoring({ contributions: [] });
    expect(el.querySelector('[data-testid="authoring-generate"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="authoring-generate-empty"]')?.textContent).toContain("连接一个助手即可开始");
  });

  it("没有来源时仍区分目录读取失败与尚未配置助手", async () => {
    const { el } = await renderAuthoring({ contributions: [], serviceOverrides: {
      listConnections: async () => ({ ok: false, code: "unavailable", error: "连接读取失败，请重试" }),
    } });
    expect(el.querySelector('[data-testid="authoring-generate-empty"]')).toBeNull();
    expect(el.textContent).toContain("连接读取失败，请重试");
    expect([...el.querySelectorAll("button")].some(button => button.textContent === "配置助手")).toBe(false);
  });

  it("日常列表查询全部已配置连接，没有技术来源预选层", async () => {
    const { el, listedAdapters } = await renderAuthoring({
      contributions: [{ id: "sdk", sourceId: "openai-responses", sourceLabel: "OpenAI" }, { id: "oauth", sourceId: "chatgpt", sourceLabel: "ChatGPT" }],
      connectionsFor: () => [{ connectionId: "c1", adapterId: "openai-responses", name: "OpenAI", ready: true }, { connectionId: "c2", adapterId: "chatgpt", name: "我的账号", ready: true }]
    });
    expect(el.querySelector('button[aria-label="来源"]')).toBeNull();
    expect(el.querySelector('button[aria-label="选择助手"]')).not.toBeNull();
    expect(listedAdapters).toEqual([undefined]);
  });

  it("单连接隐式选定，API 仍要求明确选择模型", async () => {
    const { el } = await renderAuthoring({
      contributions: [{ id: "sdk-generate", sourceId: "openai-responses", sourceLabel: "OpenAI" }],
      connectionsFor: () => [{ connectionId: "c1", name: "OpenAI", ready: true }]
    });
    const panelEl = el.querySelector('[data-testid="authoring-generate"]')!;
    expect(panelEl.querySelector('button[aria-label="来源"]')).toBeNull();
    expect(panelEl.querySelector('button[aria-label="连接"]')).toBeNull();
    expect(panelEl.querySelector('[data-testid="authoring-generate-empty"]')).toBeNull();
    const button = Array.from(panelEl.querySelectorAll("button")).find((entry) => entry.textContent === "生成") as HTMLButtonElement | undefined;
    expect(button).not.toBeUndefined();
    expect(button!.disabled).toBe(true);
    const prompt = panelEl.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "生成一盏台灯");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button!.disabled).toBe(true);
  });

  it("已安装工具可明确跟随工具设置，不要求填写模型", async () => {
    const { el } = await renderAuthoring({
      contributions: [{ id: "sdk-generate", sourceId: "openai-responses", sourceLabel: "OpenAI" }],
      connectionsFor: () => [{ connectionId: "c1", name: "本机工具", ready: true, authMode: "local-login" }]
    });
    const panelEl = el.querySelector('[data-testid="authoring-generate"]')!;
    expect(panelEl.querySelector('button[aria-label="来源"]')).toBeNull();
    expect(panelEl.querySelector('button[aria-label="连接"]')).toBeNull();
    expect(panelEl.querySelector('[data-testid="authoring-generate-empty"]')).toBeNull();
    const button = Array.from(panelEl.querySelectorAll("button")).find((entry) => entry.textContent === "生成") as HTMLButtonElement | undefined;
    expect(button).not.toBeUndefined();
    expect(button!.disabled).toBe(true);
    const prompt = panelEl.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "生成一盏台灯");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button!.disabled).toBe(false);
  });

  it("切换来源调用宿主切换协议，保留草稿；来源停用不静默换源", async () => {
    const switched: string[] = [];
    const { el, removeContributions } = await renderAuthoring({
      contributions: [{ id: "first", sourceId: "first", sourceLabel: "来源一" }, { id: "second", sourceId: "second", sourceLabel: "来源二" }],
      connectionsFor: () => [{ connectionId: "first-connection", adapterId: "first", name: "连接一", ready: true }, { connectionId: "second-connection", adapterId: "second", name: "连接二", ready: true }],
      serviceOverrides: { switchConnection: async input => { switched.push(input.connectionId); return { ok: true, value: { cleared: 1 } }; } }
    });
    const field = el.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "保留这段构思"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="选择助手"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(option => option.textContent === "连接二")!.click());
    expect(switched).toEqual(["second-connection"]);
    expect(el.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("保留这段构思");
    await act(async () => removeContributions.get("second")!());
    expect(el.querySelector('[data-testid="authoring-generate"]')!.getAttribute("data-source-id")).toBe("second");
    expect(el.textContent).toContain("先前使用的来源已停用");
  });

  it("助手返回只应用当前目标且保留草稿，owner 校验失败不改连接，关闭不执行", async () => {
    const switched: string[] = [];
    let authorized = false;
    let submitted = 0;
    const { el } = await renderAuthoring({
      contributions: [{ id: "sdk", sourceId: "sdk" }],
      connectionsFor: () => [{ connectionId: "first", name: "第一条", ready: true }, { connectionId: "second", name: "第二条", ready: true }],
      serviceOverrides: {
        switchConnection: async ({ connectionId }) => { switched.push(connectionId); return authorized ? { ok: true, value: { cleared: 1 } } : { ok: false, code: "unauthorized", error: "连接不存在或无权访问" }; },
        submitTurn: async () => { submitted++; return { ok: false, code: "fixture", error: "unexpected" }; }
      }
    });
    const field = el.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "保留草稿"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    const choose = (nodeId: string) => globalThis.dispatchEvent(new CustomEvent("woohaa3-agent-assistant-selection", { detail: { canvasId: "cv", nodeId, connectionId: "second" } }));
    await act(async () => { choose("deleted-other-node"); });
    expect(switched).toEqual([]);
    await act(async () => { choose("n1"); });
    expect(el.textContent).toContain("连接不存在或无权访问");
    expect(field.value).toBe("保留草稿");
    authorized = true;
    await act(async () => { choose("n1"); });
    expect(switched).toEqual(["second", "second"]);
    expect(field.value).toBe("保留草稿");
    expect(submitted).toBe(0);
    await act(async () => root!.unmount()); root = null;
    choose("n1");
    expect(switched).toHaveLength(2);
  });

  it("未声明 sourceId 的贡献仍渲染面板（以贡献 id 作为来源身份）", async () => {
    const { el } = await renderAuthoring({ contributions: [{ id: "legacy-generate" }] });
    expect(el.querySelector('[data-testid="authoring-generate"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="authoring-generate-empty"]')).not.toBeNull();
  });

  it("镜头与片场目标复用同一宿主内置面板（仅目标身份不同）", async () => {
    for (const mode of ["camera", "film-set"] as const) {
      const { el } = await renderAuthoring({ mode, contributions: [{ id: "sdk-generate", sourceId: "openai-responses" }] });
      const panelEl = el.querySelector('[data-testid="authoring-generate"]')!;
      expect(panelEl.getAttribute("data-mode")).toBe(mode);
    }
  });
});
