/**
 * 画布切换器组件与触发器测试
 * （change: 2026-09-29-add-multi-canvas-workspace，任务 4.6）。
 *
 * 用静态渲染断言状态与可访问名称；交互（分页/创建/重命名/切换）通过直接调用注入回调验证。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { DialogService } from "../../services/dialogs/service.js";
import { DialogHost } from "../../services/dialogs/DialogHost.js";
import { SlotRegistry } from "../../slots.js";
import { CANVAS_SWITCHER_DIALOG_ID, canvasSwitcherDefinition } from "./chrome.js";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasCatalogStore } from "../../services/canvas-catalog-store.js";
import { createFakeCanvasCatalogRemote, makeSummary } from "../../test-support/canvas-catalog.js";
import { CanvasSwitcherTrigger, createCanvasSwitcherRenderer } from "./chrome.js";
import type { CanvasSwitcherDeps } from "./chrome.js";
import type { CanvasSummary } from "../../contract/canvas-catalog.js";
import type { CanvasSession } from "../../contract/session.js";
import type { CanvasNavigationService } from "../../navigation/index.js";
import type { CanvasCatalogItemActionProps } from "../../contracts.js";

function fakeSession(phase: "synced" | "offline" = "synced"): CanvasSession {
  return {
    getStatus: () => ({
      phase: "ready",
      error: null,
      hydrated: true,
      remote: {
        mode: phase === "synced" ? "remote" : "offline",
        phase,
        confirmedRevision: 1,
        pendingCount: 0,
        error: null
      }
    }),
    subscribe: () => () => undefined,
    retry: async () => undefined,
    requestHydrate: () => undefined,
    commandLifecycle: () => null,
    submitCommands: () => ({ ok: false, reason: "stub" }),
    isWritable: () => phase === "synced",
    shutdown: () => undefined
  } as unknown as CanvasSession;
}

const emptyInstance = {
  instanceId: "i1",
  dialogId: "canvas-switcher",
  payload: {},
  parentInstanceId: null,
  dismissible: true,
  busy: false
};

async function renderSwitcher(options: {
  currentCanvasId?: string;
  entries?: Array<[string, string]>;
  phase?: "synced" | "offline";
  create?: () => Promise<{ ok: boolean; error?: string; canvasId?: string }>;
  rename?: (title: string) => Promise<{ ok: boolean; error?: string }>;
  exportArchive?: (entry: CanvasSummary) => Promise<{ ok: boolean; error?: string }>;
  remove?: (canvasId: string) => Promise<{ ok: boolean; error?: string }>;
  switchTo?: (canvasId: string) => void;
  slots?: SlotRegistry;
} = {}): Promise<{ markup: string; deps: CanvasSwitcherDeps }> {
  const remote = createFakeCanvasCatalogRemote(
    (options.entries ?? [["a", "画布 A"], ["b", "画布 B"]]).map(([id, title]) => makeSummary(id, title))
  );
  const catalog = new CanvasCatalogStore({ remote });
  // 静态渲染不执行 effect：先加载，使 snapshot 与服务端一致。
  await catalog.load();
  const deps: CanvasSwitcherDeps = {
    catalog,
    selection: { getRecentCanvasId: () => null, setRecentCanvasId: () => undefined },
    session: fakeSession(options.phase),
    slots: options.slots ?? new SlotRegistry(),
    currentCanvasId: () => options.currentCanvasId ?? "a",
    switchTo: options.switchTo ?? (() => undefined),
    create: options.create ?? (async () => ({ ok: true, canvasId: "new" })),
    rename: options.rename ?? (async () => ({ ok: true })),
    exportArchive: options.exportArchive ?? (async () => ({ ok: true })),
    remove: options.remove ?? (async () => ({ ok: true }))
  };
  const Renderer = createCanvasSwitcherRenderer(deps);
  const markup = renderToStaticMarkup(
    <Renderer
      instance={emptyInstance}
      requestClose={() => undefined}
      setBusy={() => undefined}
      replace={() => undefined}
    />
  );
  return { markup, deps };
}

/**
 * 在真实 DialogHost 里打开切换器，用于验证「条目/动作点击」这类交互。
 * 静态渲染不执行 effect 与事件，交互断言必须挂到 DOM 上。
 */
async function mountSwitcher(
  slots: SlotRegistry,
  options: {
    switchTo?: (canvasId: string) => void;
    sources?: CanvasSwitcherDeps["sources"];
    remove?: (canvasId: string) => Promise<{ ok: boolean; error?: string }>;
  } = {}
): Promise<{ dialogs: DialogService; cleanup: () => Promise<void> }> {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const catalog = new CanvasCatalogStore({
    remote: createFakeCanvasCatalogRemote([makeSummary("a", "画布 A"), makeSummary("b", "画布 B")])
  });
  await catalog.load();
  const dialogs = new DialogService();
  // getStatus 必须返回同一快照对象，否则 useSyncExternalStore 每次读取都"变化"并无限重渲染。
  const session = fakeSession("synced");
  const sessionStatus = session.getStatus();
  session.getStatus = () => sessionStatus;
  const Renderer = createCanvasSwitcherRenderer({
    catalog,
    slots,
    selection: { getRecentCanvasId: () => null, setRecentCanvasId: () => undefined },
    session,
    currentCanvasId: () => "a",
    switchTo: options.switchTo ?? (() => undefined),
    create: async () => ({ ok: true, canvasId: "new" }),
    rename: async () => ({ ok: true }),
    exportArchive: async () => ({ ok: true }),
    remove: options.remove ?? (async () => ({ ok: true })),
    ...(options.sources ? { sources: options.sources } : {})
  });
  const dispose = dialogs.registerDialog(CANVAS_SWITCHER_DIALOG_ID, {
    definition: canvasSwitcherDefinition,
    renderer: Renderer
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<DialogHost dialogs={dialogs} />);
  });
  await act(async () => {
    dialogs.open({ dialogId: CANVAS_SWITCHER_DIALOG_ID, payload: {} });
  });
  return {
    dialogs,
    async cleanup() {
      await act(async () => root.unmount());
      dispose();
      container.remove();
    }
  };
}

describe("CanvasSwitcherTrigger", () => {
  const navigation = {
    subscribe: () => () => undefined,
    getSnapshot: () => ({ mode: { type: "overview" }, panel: null, menu: null })
  } as unknown as CanvasNavigationService;

  it("显示当前标题与可访问名称", () => {
    const markup = renderToStaticMarkup(
      <CanvasSwitcherTrigger
        getTitle={() => "我的画布"}
        getSync={() => undefined}
        subscribeTitle={() => () => undefined}
        onOpen={() => undefined}
        navigation={navigation}
      />
    );
    expect(markup).toContain("我的画布");
    expect(markup).toContain("当前画布");
  });

  it("空标题回退为「未命名画布」", () => {
    const markup = renderToStaticMarkup(
      <CanvasSwitcherTrigger
        getTitle={() => ""}
        getSync={() => undefined}
        subscribeTitle={() => () => undefined}
        onOpen={() => undefined}
        navigation={navigation}
      />
    );
    expect(markup).toContain("未命名画布");
  });

  it("顶栏直接显示当前画布的同步状态（含媒体补传中）", () => {
    const render = (sync: "syncing" | "synced" | "failed" | "local-only") =>
      renderToStaticMarkup(
        <CanvasSwitcherTrigger
          getTitle={() => "我的画布"}
          getSync={() => sync}
          subscribeTitle={() => () => undefined}
          onOpen={() => undefined}
          navigation={navigation}
        />
      );
    expect(render("syncing")).toContain("同步中");
    expect(render("synced")).toContain("已同步");
    expect(render("failed")).toContain("同步失败");
    // 纯本地画布也如实显示，不把「仅本机」当成错误。
    expect(render("local-only")).toContain("仅本机");
  // 实时连接态（离线只读 / 连接中 / 就绪回落目录标签）的用例见
  // `chrome-live-sync.test.tsx`（change: 2026-10-21-recover-canvas-connection-explicitly）。
    const focused = {
      subscribe: () => () => undefined,
      getSnapshot: () => ({ mode: { type: "node-focus", nodeId: "n1", kind: "model", owner: "direct" }, panel: null, menu: null })
    } as unknown as CanvasNavigationService;
    const markup = renderToStaticMarkup(
      <CanvasSwitcherTrigger
        getTitle={() => "x"}
        getSync={() => undefined}
        subscribeTitle={() => () => undefined}
        onOpen={() => undefined}
        navigation={focused}
      />
    );
    expect(markup).toBe("");
  });
});

describe("CanvasSwitcher dialog renderer", () => {
  it("标记当前画布并列出其它画布", async () => {
    const { markup } = await renderSwitcher({ currentCanvasId: "a" });
    expect(markup).toContain("画布 A");
    expect(markup).toContain("画布 B");
    expect(markup).toContain("当前");
    expect(markup).toContain('aria-current="true"');
  });

  it("每个条目并列渲染 canvas.catalog-item-action 贡献，并注入 entry/openCanvas/refreshCatalog", async () => {
    const slots = new SlotRegistry();
    const switchTo = vi.fn();
    const seen: CanvasCatalogItemActionProps[] = [];
    slots.register("canvas.catalog-item-action", {
      id: "remote-sync",
      owner: "test-extension",
      priority: 10,
      render: (props) => {
        seen.push(props);
        return (
          <button type="button" className="test-catalog-action" data-entry-id={props.entry.id}>
            同步远端
          </button>
        );
      }
    });

    const { markup, deps } = await renderSwitcher({ slots, switchTo });
    // 每个目录条目各渲染一次（2 张画布 → 2 个动作按钮），而不是只渲染当前条目。
    expect((markup.match(/同步远端/g) ?? [])).toHaveLength(2);
    expect(markup).toContain('data-entry-id="a"');
    expect(markup).toContain('data-entry-id="b"');
    // 贡献收到的是该条目本身（含 sources / sync），不是共享快照。
    expect(seen.map((props) => [props.entry.id, props.entry.title])).toEqual([
      ["a", "画布 A"],
      ["b", "画布 B"]
    ]);

    // openCanvas 即宿主切换回调。
    seen[1].openCanvas("b");
    expect(switchTo).toHaveBeenCalledWith("b");

    // refreshCatalog 失效并强制重取目录，使来源/同步徽标随动作结果更新。
    const invalidate = vi.spyOn(deps.catalog, "invalidate");
    const load = vi.spyOn(deps.catalog, "load");
    await seen[0].refreshCatalog();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(true);
  });

  it("未注册贡献时条目结构与行为保持：无动作容器、无动作按钮", async () => {
    const { markup } = await renderSwitcher({ currentCanvasId: "b" });
    expect(markup).not.toContain("canvas-switcher__item-actions");
    expect(markup).not.toContain("test-catalog-action");
    // 行容器内仍是原来的切换按钮，当前画布标记不变。
    expect(markup).toContain("canvas-switcher__item-row");
    expect(markup).toContain("canvas-switcher__item-button");
    expect(markup).toContain('aria-current="true"');
  });

  it("动作点击不触发行切换或关闭弹窗；条目点击仍切换并关闭", async () => {
    const slots = new SlotRegistry();
    let actionClicks = 0;
    slots.register("canvas.catalog-item-action", {
      id: "test-action",
      owner: "test-extension",
      render: (props) => (
        <button
          type="button"
          data-testid={`action-${props.entry.id}`}
          onClick={() => {
            actionClicks += 1;
          }}
        >
          同步远端
        </button>
      )
    });
    const switchTo = vi.fn();
    const mounted = await mountSwitcher(slots, { switchTo });
    try {
      const action = document.querySelector('[data-testid="action-b"]') as HTMLButtonElement | null;
      expect(action).not.toBeNull();
      await act(async () => {
        action!.click();
      });
      expect(actionClicks).toBe(1);
      expect(switchTo).not.toHaveBeenCalled();
      expect(mounted.dialogs.top()).not.toBeNull();

      const rowB = Array.from(document.querySelectorAll(".canvas-switcher__item-button")).find((element) =>
        element.textContent?.includes("画布 B")
      ) as HTMLButtonElement;
      await act(async () => {
        rowB.click();
      });
      expect(switchTo).toHaveBeenCalledWith("b");
      expect(mounted.dialogs.top()).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("扩展晚注册/注销后条目动作随之出现与消失（订阅 slot 版本）", async () => {
    const slots = new SlotRegistry();
    const mounted = await mountSwitcher(slots);
    try {
      expect(document.querySelector('[data-testid="late-action"]')).toBeNull();
      let unregister!: () => void;
      await act(async () => {
        unregister = slots.register("canvas.catalog-item-action", {
          id: "late-action",
          owner: "test-extension",
          render: () => (
            <button type="button" data-testid="late-action">
              同步远端
            </button>
          )
        });
      });
      expect(document.querySelector('[data-testid="late-action"]')).not.toBeNull();
      await act(async () => {
        unregister();
      });
      expect(document.querySelector('[data-testid="late-action"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("synced 时可重命名；离线只读时禁用并提示", async () => {
    const { markup: online } = await renderSwitcher({ phase: "synced" });
    expect(online).toContain("重命名");
    expect(online).not.toContain("离线只读");

    const { markup: offline } = await renderSwitcher({ phase: "offline" });
    expect(offline).toContain("离线只读");
    expect(offline).toContain("disabled");
  });

  it("每个可删条目提供删除入口；明确没有删除权时不渲染", async () => {
    const { markup } = await renderSwitcher({});
    expect(markup).toContain("canvas-switcher__item-delete");

    const remote = createFakeCanvasCatalogRemote([
      { ...makeSummary("a", "画布 A"), access: { canRead: true, canWrite: true, canDelete: false } }
    ]);
    const catalog = new CanvasCatalogStore({ remote });
    await catalog.load();
    const Renderer = createCanvasSwitcherRenderer({
      catalog,
      selection: { getRecentCanvasId: () => null, setRecentCanvasId: () => undefined },
      session: fakeSession("synced"),
      slots: new SlotRegistry(),
      currentCanvasId: () => "a",
      switchTo: () => undefined,
      create: async () => ({ ok: true, canvasId: "new" }),
      rename: async () => ({ ok: true }),
      exportArchive: async () => ({ ok: true }),
      remove: async () => ({ ok: true })
    });
    const shared = renderToStaticMarkup(
      <Renderer instance={emptyInstance} requestClose={() => undefined} setBusy={() => undefined} replace={() => undefined} />
    );
    expect(shared).not.toContain("canvas-switcher__item-delete");
  });

  it("删除需要一次行内确认，确认后调用 remove；取消不发请求", async () => {
    const remove = vi.fn(async () => ({ ok: true }));
    const mounted = await mountSwitcher(new SlotRegistry(), { remove });
    try {
      const deleteButtons = Array.from(document.querySelectorAll(".canvas-switcher__item-delete"));
      expect(deleteButtons).toHaveLength(2);
      await act(async () => {
        (deleteButtons[1] as HTMLButtonElement).click();
      });
      const confirm = document.querySelector('[data-testid="canvas-switcher-delete-confirm"]');
      expect(confirm).not.toBeNull();
      expect(confirm!.textContent).toContain("画布 B");
      // 取消：回到普通行，不发请求。
      await act(async () => {
        (confirm!.querySelectorAll("button")[1] as HTMLButtonElement).click();
      });
      expect(remove).not.toHaveBeenCalled();
      expect(document.querySelector('[data-testid="canvas-switcher-delete-confirm"]')).toBeNull();

      await act(async () => {
        (Array.from(document.querySelectorAll(".canvas-switcher__item-delete"))[1] as HTMLButtonElement).click();
      });
      const again = document.querySelector('[data-testid="canvas-switcher-delete-confirm"]')!;
      await act(async () => {
        (again.querySelector(".ui-button--danger") as HTMLButtonElement).click();
      });
      expect(remove).toHaveBeenCalledWith("b", 1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("提供新建画布入口", async () => {
    const { markup } = await renderSwitcher({});
    expect(markup).toContain("新建画布");
  });

  it("分页：还有更多时显示「加载更多」，列表滚动区收敛在 ScrollArea 内", async () => {
    const remote = createFakeCanvasCatalogRemote([
      makeSummary("a", "画布 A"),
      makeSummary("b", "画布 B"),
      makeSummary("c", "画布 C")
    ]);
    const catalog = new CanvasCatalogStore({ remote, pageSize: 1 });
    await catalog.load();
    const Renderer = createCanvasSwitcherRenderer({
      catalog,
      selection: { getRecentCanvasId: () => null, setRecentCanvasId: () => undefined },
      session: fakeSession("synced"),
      slots: new SlotRegistry(),
      currentCanvasId: () => "a",
      switchTo: () => undefined,
      create: async () => ({ ok: true, canvasId: "new" }),
      rename: async () => ({ ok: true }),

      exportArchive: async () => ({ ok: true })
    });
    const markup = renderToStaticMarkup(
      <Renderer instance={emptyInstance} requestClose={() => undefined} setBusy={() => undefined} replace={() => undefined} />
    );
    expect(markup).toContain("加载更多");
    // 列表放在可访问的滚动区（Radix ScrollArea viewport）。
    expect(markup).toContain("canvas-switcher__scroll");
    expect(markup).toContain('aria-label="画布列表"');
  });

  it("来源分区（任务 5.7）：注入 sources 时展示来源作品与可用性；未注入不渲染", async () => {
    const remote = createFakeCanvasCatalogRemote([makeSummary("a", "画布 A")]);
    const catalog = new CanvasCatalogStore({ remote });
    await catalog.load();
    const deps = {
      catalog,
      selection: { getRecentCanvasId: () => null, setRecentCanvasId: () => undefined },
      session: fakeSession("synced"),
      slots: new SlotRegistry(),
      currentCanvasId: () => "a",
      switchTo: () => undefined,
      create: async () => ({ ok: true, canvasId: "new" }),
      rename: async () => ({ ok: true }),

      exportArchive: async () => ({ ok: true })
    };
    // 未注入 sources：不出现来源分区。
    const WithoutSources = createCanvasSwitcherRenderer(deps);
    const markupWithout = renderToStaticMarkup(
      <WithoutSources instance={emptyInstance} requestClose={() => undefined} setBusy={() => undefined} replace={() => undefined} />
    );
    expect(markupWithout).not.toContain("历史来源");

    // 注入 sources 但还没有作品时**不渲染空分区**：空标题+「暂无作品」只是噪音。
    const WithSources = createCanvasSwitcherRenderer({
      ...deps,
      sources: {
        list: async () => [{ sourceId: "legacy-source", displayName: "LegacyCanvas" }],
        listAccessible: async () => ({ items: [], nextCursor: null })
      }
    });
    const markupWith = renderToStaticMarkup(
      <WithSources instance={emptyInstance} requestClose={() => undefined} setBusy={() => undefined} replace={() => undefined} />
    );
    expect(markupWith).not.toContain("历史来源");
    expect(markupWith).not.toContain("暂无可用历史来源作品");
    expect(markupWith).not.toContain("legacy-source"); // 内部 sourceId 不进入创作者视图
  });

  it("来源目录有作品时展示历史来源分区，并允许打开", async () => {
    const slots = new SlotRegistry();
    const mounted = await mountSwitcher(slots, {
      sources: {
        list: async () => [{ sourceId: "s1", displayName: "历史来源" }],
        listAccessible: async () => ({
          items: [{
            ref: { sourceId: "s1", sourceCanvasId: "from-1", cutoverGeneration: "g1" },
            targetCanvasId: "target-1",
            title: "旧作品 A",
            updatedAt: "2026-10-19T00:00:00.000Z",
            availability: "ready" as const
          }],
          nextCursor: null
        })
      }
    });
    try {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(document.body.textContent).toContain("历史来源");
      expect(document.body.textContent).toContain("旧作品 A");
      const sourceIdText = document.body.textContent ?? "";
      expect(sourceIdText).not.toContain("s1");
    } finally {
      await mounted.cleanup();
    }
  });

  it("画布变多时提供搜索，条目副行给出更新时间与规模", async () => {
    const { markup } = await renderSwitcher({
      entries: Array.from({ length: 6 }, (_, index) => [`c${index}`, `画布 ${index}`] as [string, string])
    });
    expect(markup).toContain("搜索画布标题");
    expect(markup).toContain("6 张画布");
    expect(markup).toContain("canvas-switcher__item-meta");
  });

  it("搜索按标题过滤列表（画布变多时才出现搜索框）", async () => {
    const remote = createFakeCanvasCatalogRemote(
      Array.from({ length: 6 }, (_, index) => makeSummary(`c${index}`, `画布 ${index}`))
    );
    const catalog = new CanvasCatalogStore({ remote });
    await catalog.load();
    // getStatus 必须返回同一快照对象：useSyncExternalStore 每次拿到新对象会无限重渲染。
    const session = fakeSession("synced");
    const sessionSnapshot = session.getStatus();
    session.getStatus = () => sessionSnapshot;
    const Renderer = createCanvasSwitcherRenderer({
      catalog,
      selection: { getRecentCanvasId: () => null, setRecentCanvasId: () => undefined },
      session,
      slots: new SlotRegistry(),
      currentCanvasId: () => "c0",
      switchTo: () => undefined,
      create: async () => ({ ok: true, canvasId: "new" }),
      rename: async () => ({ ok: true }),

      exportArchive: async () => ({ ok: true })
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<Renderer instance={emptyInstance} requestClose={() => undefined} setBusy={() => undefined} replace={() => undefined} />);
      });
      const input = container.querySelector('input[aria-label="搜索画布"]') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        setter.call(input!, "画布 3");
        input!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(container.textContent).toContain("画布 3");
      expect(container.textContent).not.toContain("画布 4");
      expect(container.textContent).toContain("1 张匹配");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("空目录给出空态与新建入口", async () => {
    const remote = createFakeCanvasCatalogRemote([]);
    const catalog = new CanvasCatalogStore({ remote });
    await catalog.load();
    const Renderer = createCanvasSwitcherRenderer({
      catalog,
      selection: { getRecentCanvasId: () => null, setRecentCanvasId: () => undefined },
      session: fakeSession("synced"),
      slots: new SlotRegistry(),
      currentCanvasId: () => "a",
      switchTo: () => undefined,
      create: async () => ({ ok: true, canvasId: "new" }),
      rename: async () => ({ ok: true }),

      exportArchive: async () => ({ ok: true })
    });
    const markup = renderToStaticMarkup(
      <Renderer instance={emptyInstance} requestClose={() => undefined} setBusy={() => undefined} replace={() => undefined} />
    );
    expect(markup).toContain("还没有画布");
    expect(markup).toContain("canvas-switcher-empty");
    expect(markup).not.toContain("暂无画布");
    expect(markup.match(/>新建画布</g)).toHaveLength(1);
  });

  it("最长名称不破坏主要动作（标题与当前徽标共存）", async () => {
    const longName = "这是一个非常长的画布名称用于验证 390px 下不会挤压相邻控件或产生横向滚动";
    const { markup } = await renderSwitcher({ currentCanvasId: "a", entries: [["a", longName], ["b", "短名"]] });
    expect(markup).toContain(longName);
    expect(markup).toContain("当前");
    // 主要动作仍在。
    expect(markup).toContain("重命名");
    expect(markup).toContain("新建画布");
  });

  it("加载中显示状态提示", async () => {
    const remote = createFakeCanvasCatalogRemote([]);
    const catalog = new CanvasCatalogStore({ remote });
    // 不 await load：留在 loading 状态。
    void catalog.load();
    const Renderer = createCanvasSwitcherRenderer({
      catalog,
      selection: { getRecentCanvasId: () => null, setRecentCanvasId: () => undefined },
      session: fakeSession("synced"),
      slots: new SlotRegistry(),
      currentCanvasId: () => "a",
      switchTo: () => undefined,
      create: async () => ({ ok: true, canvasId: "new" }),
      rename: async () => ({ ok: true }),

      exportArchive: async () => ({ ok: true })
    });
    const markup = renderToStaticMarkup(
      <Renderer instance={emptyInstance} requestClose={() => undefined} setBusy={() => undefined} replace={() => undefined} />
    );
    expect(markup).toContain("正在加载画布");
  });

  it("加载失败显示可诊断错误状态", async () => {
    const remote = createFakeCanvasCatalogRemote([]);
    // 让 list 返回失败结果。
    (remote as unknown as { list: () => Promise<{ ok: false; error: string }> }).list = async () => ({
      ok: false,
      error: "catalog down"
    });
    const catalog = new CanvasCatalogStore({ remote });
    await catalog.load();
    const Renderer = createCanvasSwitcherRenderer({
      catalog,
      selection: { getRecentCanvasId: () => null, setRecentCanvasId: () => undefined },
      session: fakeSession("synced"),
      slots: new SlotRegistry(),
      currentCanvasId: () => "a",
      switchTo: () => undefined,
      create: async () => ({ ok: true, canvasId: "new" }),
      rename: async () => ({ ok: true }),

      exportArchive: async () => ({ ok: true })
    });
    const markup = renderToStaticMarkup(
      <Renderer instance={emptyInstance} requestClose={() => undefined} setBusy={() => undefined} replace={() => undefined} />
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain("catalog down");
  });
});


it("新建完成先清 busy 再关闭真实 DialogHost，失败则保留弹窗", async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const catalog = new CanvasCatalogStore({ remote: createFakeCanvasCatalogRemote([makeSummary("a", "A")]) });
  await catalog.load();
  let resolveCreate!: (result: { ok: boolean; canvasId?: string; error?: string }) => void;
  const dialogs = new DialogService();
  const session = fakeSession();
  const sessionStatus = session.getStatus();
  session.getStatus = () => sessionStatus;
  const Renderer = createCanvasSwitcherRenderer({
    catalog, selection: { getRecentCanvasId: () => null, setRecentCanvasId() {} },
    slots: new SlotRegistry(),
    session, currentCanvasId: () => "a", switchTo() {}, rename: async () => ({ ok: true }),
    exportArchive: async () => ({ ok: true }),
    create: () => new Promise(resolve => { resolveCreate = resolve; })
  });
  const dispose = dialogs.registerDialog("canvas-switcher", { definition: canvasSwitcherDefinition, renderer: Renderer });
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<DialogHost dialogs={dialogs} />); });
    for (const outcome of [{ ok: false, error: "创建失败" }, { ok: true, canvasId: "new" }]) {
      await act(async () => { dialogs.open({ dialogId: "canvas-switcher", payload: {} }); });
      const button = Array.from(document.querySelectorAll("button")).find(button => button.textContent?.trim() === "新建画布")!;
      await act(async () => { button.click(); });
      expect(dialogs.top()?.busy).toBe(true);
      await act(async () => { resolveCreate(outcome); });
      if (outcome.ok) {
        expect(dialogs.top()).toBeNull();
        expect(document.querySelector('[role="dialog"]')).toBeNull();
      } else {
        expect(dialogs.top()?.busy).toBe(false);
        expect(document.body.textContent).toContain("创建失败");
        await act(async () => { dialogs.close(dialogs.top()!.instanceId); });
      }
    }
  } finally { await act(async () => root.unmount()); dispose(); container.remove(); }
});
