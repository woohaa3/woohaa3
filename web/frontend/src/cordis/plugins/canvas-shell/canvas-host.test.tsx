import { CompositeAssetRegistry } from "../../../extension-api/composite-assets.js";
/**
 * CanvasHost：聚焦期间隐藏普通画布工具栏
 * （change: replace-model-node-focus-interactions，spec「聚焦查看隔离当前模型并可逆恢复」）。
 *
 * 右下角统一面板（缩放 + 生成历史等图标动作）在模型聚焦时不应渲染；退出聚焦后恢复。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Context } from "@deepseek-ai/cordis";
import { RuntimeProvider } from "../../react.js";
import { startFrontendRuntime, type FrontendRuntime } from "../../kernel.js";
import { SlotRegistry } from "../../slots.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { CanvasNavigationStore } from "../../navigation/store.js";
import { CanvasHost } from "./canvas-host.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;


let root: Root | null = null;
let runtime: FrontendRuntime | null = null;

afterEach(async () => {
  await act(async () => { await vi.dynamicImportSettled(); });
  act(() => root?.unmount());
  root = null;
  await runtime?.dispose();
  runtime = null;
  document.body.innerHTML = "";
  nodeSelectionStore.reset();
});

function focusRuntimeService() {
  let projection: { nodeId: string } | null = null;
  const state = {
    runtime: { phase: "ready", error: null },
    session: {
      phase: "ready",
      error: null,
      remote: { mode: "remote", phase: "synced", confirmedRevision: 1, pendingCount: 0, error: null }
    }
  };
  const focusListeners = new Set<() => void>();
  // 会话可写性：host 派生的通用 `writable` 传给所有 slot 贡献（含聚焦工作区）。
  let writable = true;
  // CanvasHost 的工具栏显隐读取 Navigation 权威 mode（change: unify-canvas-presentation-navigation）：
  // 因此聚焦切换必须同时更新 navigation snapshot，而非只改 runtime projection。
  let navSnapshot: { mode: { type: "overview" } | { type: "node-focus"; nodeId: string; kind: "model" | "extension"; owner: "direct" | "history" }; panel: null; menu: null } =
    { mode: { type: "overview" }, panel: null, menu: null };
  const navListeners = new Set<() => void>();
  const service = {
    subscribe: () => () => undefined,
    getStatus: () => state.runtime,
    subscribeMenu: () => () => undefined,
    menu: () => null,
    load: vi.fn(() => {
      const canvas = document.getElementById("bevy-canvas");
      expect(canvas?.isConnected).toBe(true);
      expect(canvas?.parentElement?.classList.contains("bevy-canvas-surface")).toBe(true);
      return Promise.resolve(undefined);
    }),
    attach: () => () => undefined,
    setFocusContentRect: () => undefined,
    // 节点操作横条消费唯一 runtime 屏幕投影与视口订阅（change: 2026-10-13-add-node-to-film-set-shortcut）。
    subscribeViewport: () => () => undefined,
    nodeScreenRect: () => null,
    modelFocusProjection: () => projection,
    subscribeModelFocus: (listener: () => void) => {
      focusListeners.add(listener);
      return () => focusListeners.delete(listener);
    }
  };
  // 选择集合：底部 MCP 指引的显隐依据（无选中节点才显示）。
  let selection = { nodeIds: [] as string[], primaryNodeId: null as string | null, editingFocus: false, keyboardActive: true };
  const selectionListeners = new Set<() => void>();
  // 模态门禁：CanvasHost 从 Dialog Service 派生通用 `modalActive`。
  let modalSnapshot = { stack: [] as unknown[], activeDialogId: null as string | null, isModalActive: false, scopePath: [] as string[] };
  const modalListeners = new Set<() => void>();
  return {
    service,
    session: {
      subscribe: () => () => undefined,
      getStatus: () => state.session,
      isWritable: () => writable,
      retry: async () => undefined
    },
    selection: {
      getSnapshot: () => selection,
      subscribe: (listener: () => void) => {
        selectionListeners.add(listener);
        return () => selectionListeners.delete(listener);
      },
      setFromRuntime: () => undefined,
      setKeyboardActive: () => undefined,
      reset: () => undefined
    },
    selectNode: (nodeId: string | null) => {
      nodeSelectionStore.setFromRuntime({ nodeIds: nodeId ? [nodeId] : [], primaryNodeId: nodeId, editingFocus: false }, new Set(nodeId ? [nodeId] : []));
      selection = { ...selection, nodeIds: nodeId ? [nodeId] : [], primaryNodeId: nodeId };
      nodeSelectionStore.setFromRuntime(selection,new Set(selection.nodeIds));
      for (const listener of selectionListeners) listener();
    },
    navigation: {
      subscribe: (listener: () => void) => {
        navListeners.add(listener);
        return () => navListeners.delete(listener);
      },
      getSnapshot: () => navSnapshot,
      resolvePanel: () => null,
      closeMenu: () => ({ ok: true, snapshot: navSnapshot })
    },
    dialogs: {
      subscribe: (listener: () => void) => {
        modalListeners.add(listener);
        return () => modalListeners.delete(listener);
      },
      getSnapshot: () => modalSnapshot,
      setModal: (open: boolean) => {
        modalSnapshot = { ...modalSnapshot, isModalActive: open };
        for (const listener of modalListeners) listener();
      }
    },
    enterFocus: (nodeId: string, kind: "model" | "extension" = "model") => {
      projection = { nodeId };
      navSnapshot = { mode: { type: "node-focus", nodeId, kind, owner: "direct" }, panel: null, menu: null };
      for (const listener of focusListeners) listener();
      for (const listener of navListeners) listener();
    },
    exitFocus: () => {
      projection = null;
      navSnapshot = { mode: { type: "overview" }, panel: null, menu: null };
      for (const listener of focusListeners) listener();
      for (const listener of navListeners) listener();
    },
    setWritable: (next: boolean) => {
      writable = next;
      // 新 snapshot 引用迫使订阅者重渲染并重新读取 isWritable()（session 的可写性由 host 派生）。
      navSnapshot = { ...navSnapshot };
      for (const listener of navListeners) listener();
    }
  };
}

async function render(navigationOverride?: unknown, extensionMatches?: (props: { focus?: { nodeId: string } | null }) => boolean, catalogSync?: "unlinked" | "synced"): Promise<ReturnType<typeof focusRuntimeService> & { focusProps: Array<{ modalActive?: boolean; writable?: boolean }>; slots: SlotRegistry }> {
  const focus = focusRuntimeService();
  const slots = new SlotRegistry();
  slots.register("canvas.toolbar", {
    id: "canvas-zoom",
    owner: "canvas-shell",
    render: () => <span data-testid="zoom">zoom</span>
  });
  slots.register("canvas.toolbar-action", {
    id: "node-history-all",
    owner: "node-history",
    label: "生成历史",
    icon: () => <svg data-testid="history-icon" />,
    onActivate: () => undefined
  });
  // 通用聚焦工作区贡献（kind "model"）：记录宿主派生的 props，供模态门禁断言。
  const focusProps: Array<{ modalActive?: boolean; writable?: boolean }> = [];
  slots.register("canvas.focus-workspace", {
    id: "probe-workspace",
    owner: "canvas-shell",
    kind: "model",
    render: (props) => {
      focusProps.push({ modalActive: props.modalActive, writable: props.writable });
      return <span data-testid="probe-workspace">workspace</span>;
    }
  });
  // 第二个通用聚焦工作区贡献（kind "extension"）：用于验证「普通模型 focus 与 [extension] 工作区互斥」。
  slots.register("canvas.focus-workspace", {
    id: "probe-extension-workspace",
    owner: "game-furnace",
    kind: "extension",
    matchesFocus: extensionMatches,
    render: () => <span data-testid="probe-extension-workspace">extension-workspace</span>
  });
  const instance = await startFrontendRuntime({
    installPlatform: (ctx: Context) => {
      ctx.provide("compositeAssets" as never, new CompositeAssetRegistry() as never);
      ctx.provide("canvasState" as never, { getWorkingCanvas: () => null, getCanvas: () => null } as never);
      ctx.provide("canvasRuntime" as never, focus.service as never);
      ctx.provide("canvasSession" as never, focus.session as never);
      ctx.provide("selection" as never, focus.selection as never);
      ctx.provide("slots" as never, slots as never);
      ctx.provide("dialogs" as never, focus.dialogs as never);
      // CanvasHost 按 Canvas Navigation snapshot 渲染菜单/面板（change: unify-canvas-presentation-navigation）。
      ctx.provide("canvasNavigation" as never, (navigationOverride ?? focus.navigation) as never);
      // 目录条目：CanvasHost 读当前画布的 sync 判断「属于远端但本机没有上游链路」。
      // getState 必须返回稳定引用：useSyncExternalStore 每次渲染都比较快照身份，
      // 每次新建对象会被判定为「一直在变」而无限重渲染。
      const catalogState = {
        status: "ready" as const,
        entries: [{
          id: "c1", title: "c1", revision: 1,
          updatedAt: "2026-10-26T00:00:00.000Z", createdAt: "2026-10-26T00:00:00.000Z",
          nodeCount: 0, assetCount: 0, sources: ["local", "remote"] as const,
          ...(catalogSync === undefined ? {} : { sync: catalogSync })
        }],
        total: 1, offset: 0, limit: 20, loadingMore: false, error: null
      };
      ctx.provide("canvasCatalog" as never, {
        getState: () => catalogState,
        subscribe: () => () => undefined,
        load: async () => ({ ok: true, entries: [], total: 0, offset: 0, limit: 20 }),
        loadMore: async () => undefined,
        create: async () => ({ ok: false, code: "unavailable", error: "unavailable" }),
        get: async () => ({ ok: false, code: "unavailable", error: "unavailable" }),
        invalidate: () => undefined,
        dispose: () => undefined
      } as never);
    },
    plugins: []
  });
  runtime = instance;
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => {
    root!.render(
      <RuntimeProvider runtime={instance}>
        <CanvasHost canvasId="c1" />
      </RuntimeProvider>
    );
  });
  return { ...focus, focusProps, slots };
}

const panel = () => document.querySelector(".canvas-control-panel");
const bottomHint = () => document.querySelector(".canvas-bottom-hint");

describe("CanvasHost 聚焦隐藏普通画布工具栏", () => {
  it("输入表面挂载后装载 renderer，普通重渲染不重复启动", async () => {
    const focus = await render();
    expect(focus.service.load).toHaveBeenCalledOnce();
    act(() => focus.enterFocus("m1"));
    expect(focus.service.load).toHaveBeenCalledOnce();
  });
  it("真实 Navigation invalidation 卸载 extension 工作区", async () => {
    const navigation = new CanvasNavigationStore();
    navigation.setFocusAdapter({
      apply: () => ({ ok: true }),
      isFocused: () => true,
      isTargetValid: () => true
    });
    await render(navigation);

    let entered = false;
    act(() => { entered = navigation.enterNodeFocus({ nodeId: "g1", kind: "extension" }).ok; });
    expect(entered).toBe(true);
    expect(document.querySelector('[data-testid="probe-extension-workspace"]')).not.toBeNull();

    act(() => { navigation.invalidateNodeFocus("focus-target-invalid"); });

    expect(navigation.getSnapshot().mode).toEqual({ type: "overview" });
    expect(document.querySelector('[data-testid="probe-extension-workspace"]')).toBeNull();
    expect(panel()).not.toBeNull();
  });

  it("非聚焦时渲染右下角面板与生成历史入口", async () => {
    await render();
    expect(panel()).not.toBeNull();
    expect(document.querySelector('button[aria-label="生成历史"]')).not.toBeNull();
  });

  /**
   * 2026-10-26 现场回归：浏览器↔宿主一切正常、目录说这张画布属于远端，但宿主→远端的上游
   * 链路没有建立。此前右下角气泡只表达前一段，于是显示「已同步」，把整条上传链路的缺失藏住。
   */
  const statusLabel = () => document.querySelector(".canvas-control-panel__status-readout")?.getAttribute("aria-label") ?? "";
  const statusBubble = () => document.querySelector(".canvas-control-panel__status-bubble-text")?.textContent ?? "";

  it("属于远端但本机没有上游链路：右下角气泡常驻「未同步到远端」", async () => {
    await render(undefined, undefined, "unlinked");
    expect(statusLabel()).toBe("未同步到远端");
    expect(statusBubble()).toContain("只保存在本机");
    expect(document.querySelector(".canvas-control-panel__status-bubble")?.getAttribute("data-pinned")).toBe("true");
  });

  it("链路正常时回到稳态「已同步」，不出现上游提示", async () => {
    await render(undefined, undefined, "synced");
    expect(statusLabel()).toBe("已同步");
    expect(statusBubble()).not.toContain("只保存在本机");
  });

  it("进入聚焦后隐藏整个普通画布工具栏；退出后恢复", async () => {
    const focus = await render();
    expect(panel()).not.toBeNull();
    act(() => focus.enterFocus("m1"));
    expect(panel()).toBeNull();
    act(() => focus.exitFocus());
    expect(panel()).not.toBeNull();
  });

  it("画布底部不显示 MCP 指引，选择和聚焦变化后也不恢复", async () => {
    const focus = await render();
    expect(bottomHint()).toBeNull();
    act(() => focus.selectNode("n1"));
    expect(bottomHint()).toBeNull();
    act(() => focus.selectNode(null));
    expect(bottomHint()).toBeNull();
    act(() => focus.enterFocus("m1"));
    expect(bottomHint()).toBeNull();
    act(() => focus.exitFocus());
    expect(bottomHint()).toBeNull();
  });

  it("聚焦工作区贡献收到宿主派生的通用 modalActive（打开/关闭同步，不产生第二状态源）", async () => {
    const focus = await render();
    act(() => focus.enterFocus("m1"));
    expect(document.querySelector('[data-testid="probe-workspace"]')).not.toBeNull();
    expect(focus.focusProps.at(-1)?.modalActive).toBe(false);
    act(() => focus.dialogs.setModal(true));
    expect(focus.focusProps.at(-1)?.modalActive).toBe(true);
    act(() => focus.dialogs.setModal(false));
    expect(focus.focusProps.at(-1)?.modalActive).toBe(false);
  });

  it("普通模型 focus 与 extension 工作区互斥：只渲染当前聚焦 kind 的工作区（任务 5.10）", async () => {
    const focus = await render();
    // 进入普通模型 focus：只渲染 model 工作区，extension 工作区不并行呈现。
    act(() => focus.enterFocus("m1", "model"));
    expect(document.querySelector('[data-testid="probe-workspace"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="probe-extension-workspace"]')).toBeNull();
    // 切到 extension 聚焦（双击炼丹炉节点）：只渲染 extension 工作区，模型工作区卸载并不再并行。
    act(() => focus.enterFocus("g1", "extension"));
    expect(document.querySelector('[data-testid="probe-extension-workspace"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="probe-workspace"]')).toBeNull();
    // 反向：从 extension 聚焦切回模型聚焦，游戏工作区同样卸载，不并行。
    act(() => focus.enterFocus("m1", "model"));
    expect(document.querySelector('[data-testid="probe-workspace"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="probe-extension-workspace"]')).toBeNull();
    // 退出聚焦：两个工作区都不呈现，回到普通画布（不产生并行 mode）。
    act(() => focus.exitFocus());
    expect(document.querySelector('[data-testid="probe-extension-workspace"]')).toBeNull();
    expect(document.querySelector('[data-testid="probe-workspace"]')).toBeNull();
    expect(panel()).not.toBeNull();
  });

  it("聚焦工作区贡献收到宿主派生的通用只读门禁 writable（任务 5.10）", async () => {
    const focus = await render();
    act(() => focus.enterFocus("m1", "model"));
    // 可写会话：贡献收到 writable=true。
    expect(focus.focusProps.at(-1)?.writable).toBe(true);
    // 会话切为只读：宿主派生并下发 writable=false（工作区据此门禁写操作）。
    act(() => focus.setWritable(false));
    expect(focus.focusProps.at(-1)?.writable).toBe(false);
  });
});


describe("扩展聚焦身份边界", () => {
  it("同 kind 的不同工作区按目标筛选", async () => {
    const focus = await render(undefined, (props) => props.focus?.nodeId === "owned");
    act(() => {
      focus.slots.register("canvas.focus-workspace", {
        id: "other-workspace", owner: "other", kind: "extension",
        matchesFocus: ({ focus }) => focus?.nodeId === "other",
        render: () => <span data-testid="other-workspace">other</span>
      });
      focus.enterFocus("other", "extension");
    });
    expect(document.querySelector('[data-testid="probe-extension-workspace"]')).toBeNull();
    expect(document.querySelector('[data-testid="other-workspace"]')).not.toBeNull();
    act(() => focus.enterFocus("owned", "extension"));
    expect(document.querySelector('[data-testid="probe-extension-workspace"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="other-workspace"]')).toBeNull();
  });

  it("未知扩展显示可返回的不可用状态", async () => {
    const navigation = new CanvasNavigationStore();
    navigation.setFocusAdapter({ apply: () => ({ ok: true }), isFocused: () => true, isTargetValid: () => true });
    await render(navigation, () => false);
    act(() => { navigation.enterNodeFocus({ nodeId: "unknown", kind: "extension" }); });
    expect(document.querySelector('[data-testid="probe-extension-workspace"]')).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toContain("此节点的工作区不可用");
    const back = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "返回画布");
    await act(async () => back!.click());
    expect(navigation.getSnapshot().mode.type).toBe("overview");
    expect(panel()).not.toBeNull();
  });
});
