/**
 * App Router 与 page scope 生命周期测试
 * （change: 2026-09-28-unify-canvas-presentation-navigation，task 2.2/2.5）。
 *
 * @vitest-environment jsdom
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { startApp, type AppRuntime } from "./page-scope.js";
import { resolvePageLocation, locationToPath } from "./navigation/app-router-store.js";
import { createFakeCanvasCatalogRemote } from "./test-support/canvas-catalog.js";
import { createSourceExtensionRuntimeService } from "./test-support/source-extensions.js";
import { routeNodeActionHit } from "./plugins/canvas-shell/node-action-host.js";
import type { TaskActivityStore } from "@woohaa3/extension-task-activity/frontend";

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

/** 确定性 startApp：注入内存目录 remote 与源码型 extension runtime，避免依赖真实 fetch/发布目录。 */
function startTestApp(options: Parameters<typeof startApp>[0] = {}): Promise<AppRuntime> {
  return startApp({
    extensionRuntime: options.extensionRuntime ?? createSourceExtensionRuntimeService(),
    ...options,
    canvasCatalogRemote: createFakeCanvasCatalogRemote()
  });
}

afterEach(async () => {
  await app?.dispose();
  app = null;
});

describe("App Router 页面解析", () => {
  it("内置监控路由不依赖扩展登记，并丢弃非查询字段", () => {
    expect(resolvePageLocation("/admin/tasks", "?state=failed&canvasId=c1&prompt=secret")).toEqual({
      page: "task-monitor", query: { state: "failed", canvasId: "c1" }
    });
    expect(locationToPath({ page: "task-monitor", query: { state: "failed" } })).toBe("/admin/tasks?state=failed");
  });

  it("纯解析 pathname → 页面 identity", () => {
    expect(resolvePageLocation("/task-history", "")).toEqual({ page: "task-history" });
    expect(resolvePageLocation("/task-history/", "")).toEqual({ page: "task-history" });
    expect(resolvePageLocation("/", "?canvasId=c1&nodeId=n1")).toEqual({
      page: "canvas",
      canvasId: "c1",
      nodeId: "n1"
    });
    expect(resolvePageLocation("/", "")).toEqual({ page: "canvas" });
  });

  it("location 序列化只含页面 identity（不写 panel/menu/focus）", () => {
    expect(locationToPath({ page: "task-history" })).toBe("/task-history");
    expect(locationToPath({ page: "canvas", canvasId: "c1", nodeId: "n1" })).toBe("/?canvasId=c1&nodeId=n1");
    expect(locationToPath({ page: "canvas" })).toBe("/");
  });
});

describe("Page scope 生命周期", () => {
  it("任务监控不依赖扩展发布目录，也不创建画布资源；修改查询复用页面 scope", async () => {
    installGlobals();
    const runtime = createSourceExtensionRuntimeService();
    runtime.ensureCatalog = async () => { throw new Error("监控页面不应请求扩展目录"); };
    app = await startTestApp({ initialPathname: "/admin/tasks", extensionRuntime: runtime });
    const page = app.currentPage()!;
    expect(app.router.getLocation().page).toBe("task-monitor");
    expect(page.ctx.get("canvasSession" as never)).toBeUndefined();
    expect(page.ctx.get("canvasRuntime" as never)).toBeUndefined();
    expect(page.ctx.get("applicationRemote" as never)).toBeDefined();
    await app.applyLocation({ page: "task-monitor", query: { state: "failed", taskKey: "t1" } });
    expect(app.currentPage()).toBe(page);
    expect(app.router.getLocation().query).toEqual({ state: "failed", taskKey: "t1" });
  });

  it("Task History 冷启动不创建 Canvas Session/Runtime/plugins", async () => {
    installGlobals();
    app = await startTestApp({ initialPathname: "/task-history" });
    const page = app.currentPage();
    expect(page).not.toBeNull();
    expect(page!.ctx.get("canvasSession" as never)).toBeUndefined();
    expect(page!.ctx.get("canvasRuntime" as never)).toBeUndefined();
    expect(page!.ctx.get("canvasNavigation" as never)).toBeUndefined();
    // 历史 route 存在，画布 slot 为空。
    expect(page!.ctx.slots.list("app.route").map((route) => route.path)).toEqual(["/task-history"]);
    expect(page!.ctx.slots.list("canvas.context-menu")).toHaveLength(0);
  });

  it("Canvas 页面启动 Canvas Session/Runtime/plugins", async () => {
    installGlobals();
    app = await startTestApp({ initialPathname: "/" });
    const page = app.currentPage();
    expect(page).not.toBeNull();
    expect(page!.ctx.canvasSession).toBeDefined();
    expect(page!.ctx.canvasNavigation).toBeDefined();
    expect(page!.ctx.canvasNavigation.resolvePanel("node-execution")).not.toBeNull();
  });

  it("默认全启用：optional Plugin 和常驻活动面板都进入启动清单", async () => {
    installGlobals();
    app = await startTestApp({ initialPathname: "/" });
    const page = app.currentPage()!;
    const actions = page.ctx.slots.list("canvas.toolbar-action").map((entry) => entry.id);
    // node-history 通过 slot 可观察；disabled 诊断不应存在。
    expect(page.diagnostics.getStatus().plugins.find((plugin) => plugin.status === "disabled")).toBeUndefined();
    expect(actions).not.toContain("node-history-all");
    expect(page.ctx.slots.list("ai-center.generation-history")).toHaveLength(1);
  });

  it("浏览器本地禁用记录决定启动装配：禁用的 browser-local 插件不装配，required 不受影响", async () => {
    installGlobals();
    const storage = {
      data: {
        "woohaa:frontend-extensions:v1": JSON.stringify({
          "task-activity": false,
          "prompt-snippets": false,
          "node-history": false
        })
      } as Record<string, string>,
      getItem(key: string) {
        return this.data[key] ?? null;
      },
      setItem(key: string, value: string) {
        this.data[key] = value;
      }
    };
    app = await startTestApp({ initialPathname: "/", extensionPreferenceStorage: storage });
    const page = app.currentPage()!;
    const diagnostics = page.diagnostics.getStatus();
    for (const id of ["prompt-snippets", "node-history"]) {
      // 用户关掉的 browser-local optional 不装配，诊断里是合成 disabled 行（不是启动失败）。
      expect(diagnostics.plugins.find((plugin) => plugin.id === id)?.status).toBe("disabled");
    }
    // disabled 不算启动失败，required paste-import/model-editor 仍装配；node-history 的工具栏入口随之消失。
    expect(diagnostics.plugins.find((plugin) => plugin.id === "paste-import")?.status).toBe("active");
    expect(diagnostics.plugins.find((plugin) => plugin.id === "model-editor")?.status).toBe("active");
    expect(diagnostics.plugins.find((plugin) => plugin.id === "task-activity")?.status).toBe("active");
    expect(page.ctx.slots.list("canvas.overlay").some(entry => entry.id === "task-activity-feed")).toBe(true);
    const activity = page.ctx.get("taskActivityStore" as never) as unknown as { store: TaskActivityStore };
    routeNodeActionHit({
      hit: { nodeId: "creation-group", actionId: "group-run-status", menu: false },
      context: { nodeId: "creation-group", nodeType: "group", writable: false },
      contributions: page.ctx.slots.list("canvas.node-action"),
      openSettings: () => { throw new Error("状态入口不应打开节点设置"); }
    });
    expect(activity.store.getSnapshot()).toMatchObject({ selectedGroupId: "creation-group", openRevision: 1 });
    expect(page.ctx.slots.list("canvas.toolbar-action").some((entry) => entry.id === "node-history-all")).toBe(false);
  });

  it("optional 入口加载失败被隔离：页面仍启动，失败行标为失败", async () => {
    installGlobals();
    const base = createSourceExtensionRuntimeService();
    const runtime = createSourceExtensionRuntimeService({
      loadDescriptor: (extensionId) => {
        if (extensionId === "prompt-snippets") {
          return Promise.reject(new Error("network down"));
        }
        return base.loadDescriptor(extensionId);
      }
    });
    app = await startTestApp({ initialPathname: "/", extensionRuntime: runtime });
    const page = app.currentPage()!;
    // 页面没有因为 optional 失败而失败：required 插件仍 active。
    expect(page.diagnostics.getStatus().plugins.find((plugin) => plugin.id === "paste-import")?.status).toBe("active");
    // 可选片段入口失败不影响画布菜单与任务执行的生成溯源入口。
    expect(page.ctx.slots.list("canvas.context-menu").map(entry => entry.id)).toEqual(["canvas-menu", "generation-trace"]);
    expect(page.ctx.slots.list("canvas.overlay").some(entry => entry.id === "task-activity-feed")).toBe(true);
    // 失败的可选入口在运行时服务中记录为 load-failed（供 Plugin Manager 显示「启动失败」）。
    const failed = runtime.diagnostics().find((row) => row.extensionId === "prompt-snippets");
    expect(failed?.status).toBe("load-failed");
  });

  it("活动面板资源失败必须显示启动失败，不能进入只有组状态但无活动入口的画布", async () => {
    installGlobals();
    const base = createSourceExtensionRuntimeService();
    const runtime = createSourceExtensionRuntimeService({
      loadDescriptor: id => id === "task-activity" ? Promise.reject(new Error("network down")) : base.loadDescriptor(id)
    });
    app = await startTestApp({ initialPathname: "/", extensionRuntime: runtime });
    expect(app.currentPage()).toBeNull();
    const phases: Array<{ phase: string; error: string | null }> = [];
    const off = app.router.subscribeScope(status => phases.push(status));
    await app.applyLocation({ page: "canvas" });
    off();
    expect(phases.at(-1)).toMatchObject({ phase: "error", error: expect.stringContaining('required extension "task-activity"') });
  });

  it("required Plugin 强制装配（用户配置无法禁用）", async () => {
    installGlobals();
    const storage = {
      data: {
        "woohaa:frontend-extensions:v1": JSON.stringify({ "paste-import": false, "model-editor": false })
      } as Record<string, string>,
      getItem(key: string) {
        return this.data[key] ?? null;
      },
      setItem(key: string, value: string) {
        this.data[key] = value;
      }
    };
    app = await startTestApp({ initialPathname: "/", extensionPreferenceStorage: storage });
    const page = app.currentPage()!;
    const diagnostics = page.diagnostics.getStatus();
    expect(diagnostics.plugins.find((plugin) => plugin.id === "paste-import")?.status).toBe("active");
    expect(diagnostics.plugins.find((plugin) => plugin.id === "model-editor")?.status).toBe("active");
    // change: 2026-10-16-consolidate-canvas-settings-entries：required 的 Plugin Manager 仍装配并
    // 提供 capability，但恢复入口是左下角「设置」→ 设置页「插件配置」，画布内没有管理入口。
    expect(diagnostics.plugins.find((plugin) => plugin.id === "extension-manager")?.status).toBe("active");
    expect(page.ctx.get("extensionManager" as never)).toBeDefined();
    const toolbarActions = page.ctx.slots.list("canvas.toolbar-action").map((entry) => entry.id);
    expect(toolbarActions).not.toContain("extension-manager-open");
    expect(toolbarActions).not.toContain("provider-credentials-open");
    expect(toolbarActions).toContain("settings-open");
    // 任务监控只在执行面板按 tasks.inspect 提供页面动作；画布工具栏不再有监控按钮。
    expect(toolbarActions).not.toContain("openTaskInspection");
  });

  it("Canvas ↔ Task History 往返释放并重建 scope，无残留", async () => {    installGlobals();
    app = await startTestApp({ initialPathname: "/" });
    const canvasPage = app.currentPage();
    expect(canvasPage).not.toBeNull();
    const canvasScopeId = app.router.currentScopeId();

    // 切到历史：outgoing canvas scope 释放。
    const scopePhases: string[] = [];
    app.router.subscribeScope((status) => scopePhases.push(`${status.page}:${status.phase}`));
    await app.applyLocation({ page: "task-history" });
    expect(app.router.currentScopeId()).not.toBe(canvasScopeId);
    expect(app.currentPage()!.ctx.get("canvasSession" as never)).toBeUndefined();
    expect(scopePhases).toContain("task-history:ready");

    // 切回画布：新 scope 重新装配。
    await app.applyLocation({ page: "canvas" });
    expect(scopePhases).toContain("canvas:ready");
    const rebuilt = app.currentPage();
    expect(rebuilt).not.toBeNull();
    expect(rebuilt!.ctx.canvasSession).toBeDefined();
    expect(rebuilt!.ctx.canvasNavigation.resolvePanel("node-execution")).not.toBeNull();
  });

  it("跨页面切换按浏览器本地偏好重建装配", async () => {
    installGlobals();
    const storage = {
      data: { "woohaa:frontend-extensions:v1": JSON.stringify({ "node-history": false }) } as Record<string, string>,
      getItem(key: string) {
        return this.data[key] ?? null;
      },
      setItem(key: string, value: string) {
        this.data[key] = value;
      }
    };
    app = await startTestApp({ initialPathname: "/", extensionPreferenceStorage: storage });
    const first = app.currentPage()!;
    expect(first.diagnostics.getStatus().plugins.find((plugin) => plugin.id === "node-history")?.status).toBe("disabled");

    // Canvas → Task History → Canvas：新 scope 仍按同一份本地偏好装配。
    await app.applyLocation({ page: "task-history" });
    await app.applyLocation({ page: "canvas" });
    const rebuilt = app.currentPage()!;
    expect(rebuilt.diagnostics.getStatus().plugins.find((plugin) => plugin.id === "node-history")?.status).toBe("disabled");
    expect(rebuilt.ctx.slots.list("canvas.toolbar-action").some((entry) => entry.id === "node-history-all")).toBe(false);
  });

  it("Task History 冷启动无 Canvas socket/WASM 且同页 URL 不重建 scope（任务 6.4）", async () => {
    installGlobals();
    // 统计 history scope 启动期间的 WebSocket 构造：不得创建 canvas sync socket。
    let socketsCreated = 0;
    class CountingWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        socketsCreated += 1;
      }
    }
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = CountingWebSocket;

    app = await startTestApp({ initialPathname: "/task-history", initialSearch: "?tab=failed&taskKey=t1" });
    const page = app.currentPage()!;
    const scopeId = app.router.currentScopeId();
    // 无 Canvas Session / Runtime / Navigation / selection。
    expect(page.ctx.get("canvasSession" as never)).toBeUndefined();
    expect(page.ctx.get("canvasRuntime" as never)).toBeUndefined();
    expect(page.ctx.get("canvasNavigation" as never)).toBeUndefined();
    expect(page.ctx.get("selection" as never)).toBeUndefined();
    expect(socketsCreated).toBe(0);

    // 同页 URL 变化（筛选/选中/翻页）复用同一 scope，不重建，不新建 socket。
    await app.applyLocation({ page: "task-history", history: { tab: "succeeded", taskKey: "t2" } });
    expect(app.router.currentScopeId()).toBe(scopeId);
    expect(socketsCreated).toBe(0);
    // 页面已装配的 taskRemote/re mediaRemote 仍在。
    expect(page.ctx.taskRemote).toBeDefined();
  });
});

describe("画布内设置与旧 /settings 兼容入口", () => {
  it("设置是 Canvas 壳内能力：装配 settingsOpen 与 singleton dialog，且不创建独立页面 scope", async () => {
    installGlobals();
    app = await startTestApp({ initialPathname: "/" });
    const page = app.currentPage()!;
    expect(app.router.getLocation().page).toBe("canvas");
    // 能力与弹窗注册都在 Canvas scope；页面身份仍是 canvas。
    expect(page.ctx.get("settingsOpen" as never)).toBeDefined();
    expect(page.ctx.dialogs.registeredDialogIds()).toContain("settings");
    // 旧独立设置页 route / scope 已退场：Canvas scope 不注册 app.route。
    expect(page.ctx.slots.list("app.route")).toHaveLength(0);
  });

  it("冷启动访问 /settings：进入 Canvas、replace 为规范地址并消费一次打开意图", async () => {
    installGlobals();
    const history: string[] = [];
    app = await startTestApp({
      initialPathname: "/settings",
      history: {
        pushState: (_data, _title, url) => history.push(`push:${url}`),
        replaceState: (_data, _title, url) => history.push(`replace:${url}`)
      }
    });
    expect(app.router.getLocation().page).toBe("canvas");
    const page = app.currentPage()!;
    // 不等待 GPU/场景 ready：设置弹窗在壳就绪后直接出现。
    const opened = await page.ctx.canvasNavigation.requestOpenDialog({ dialogId: "settings" });
    expect(opened.ok).toBe(true);
    expect(page.ctx.dialogs.top()?.dialogId).toBe("settings");
    // 兼容地址被 replace 规范化：没有额外 push 一条设置历史。
    expect(history.some((entry) => entry.startsWith("push:"))).toBe(false);
    expect(history.some((entry) => entry.startsWith("replace:"))).toBe(true);
    expect(app.router.getLocation().openSettings).toBeUndefined();
  });

  it("已有画布接收旧路径请求：复用同一 scope，不重建画布资源", async () => {
    installGlobals();
    app = await startTestApp({ initialPathname: "/" });
    const page = app.currentPage()!;
    const scopeId = app.router.currentScopeId();
    await app.applyLocation({ page: "canvas", openSettings: true });
    expect(app.router.currentScopeId()).toBe(scopeId);
    expect(app.currentPage()).toBe(page);
    expect(app.router.getLocation().openSettings).toBeUndefined();
    // 关闭设置后再次刷新规范地址不会自动重开。
    const opened = page.ctx.dialogs.top();
    if (opened) page.ctx.dialogs.close(opened.instanceId);
    await app.applyLocation({ page: "canvas" });
    expect(page.ctx.dialogs.top()).toBeNull();
  });

  it("设置开关不 dispose Session/runtime、不清空撤销记录；page dispose 无残留注册", async () => {
    installGlobals();
    app = await startTestApp({ initialPathname: "/" });
    const page = app.currentPage()!;
    const session = page.ctx.canvasSession;
    const dialogIdsBefore = page.ctx.dialogs.registeredDialogIds();

    expect((await page.ctx.canvasNavigation.requestOpenDialog({ dialogId: "settings" })).ok).toBe(true);
    const instance = page.ctx.dialogs.top()!;
    page.ctx.dialogs.requestClose(instance.instanceId);
    // Session 仍是同一活动实例；弹窗注册保持同一集合（无重复注册）。
    expect(page.ctx.canvasSession).toBe(session);
    expect(page.ctx.dialogs.getSnapshot().stack).toHaveLength(0);
    expect(page.ctx.dialogs.registeredDialogIds()).toEqual(dialogIdsBefore);

    // Canvas 页面离开：settings 的能力与 dialog 注册随 scope 释放。
    await app.applyLocation({ page: "task-history" });
    expect(app.currentPage()!.ctx.get("settingsOpen" as never)).toBeUndefined();
    expect(app.currentPage()!.ctx.dialogs.registeredDialogIds()).not.toContain("settings");
  });

  it("渲染失败/找不到画布的恢复页仍装配设置能力，且不创建画布资源", async () => {
    // change: 2026-10-17-move-settings-into-canvas-dialog，design D1 / spec: 渲染器恢复失败。
    installGlobals();
    let socketsCreated = 0;
    class CountingWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        socketsCreated += 1;
      }
    }
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = CountingWebSocket;
    app = await startTestApp({ initialPathname: "/", initialSearch: "?canvasId=missing-canvas" });
    const page = app.currentPage()!;
    expect(app.router.getLocation().page).toBe("canvas");
    // 恢复页仍提供设置能力与 singleton 弹窗。
    const capability = page.ctx.get("settingsOpen" as never) as { open(): Promise<{ ok: boolean }> } | undefined;
    expect(capability).toBeDefined();
    expect(page.ctx.dialogs.registeredDialogIds()).toContain("settings");
    // 不自动创建作品/占位会话、不起 sync socket、也不启动 renderer。
    expect(socketsCreated).toBe(0);
    expect(page.ctx.get("canvasSession" as never)).toBeUndefined();
    expect(page.ctx.get("canvasRuntime" as never)).toBeUndefined();
    expect(page.ctx.get("canvasRecovery" as never)).toBeDefined();
    // 设置可打开（空壳没有聚焦编辑现场可结算）。
    await expect(capability!.open()).resolves.toMatchObject({ ok: true });
    expect(page.ctx.dialogs.top()?.dialogId).toBe("settings");
  });

  it("旧 ID 迁移准备中的壳也保留设置入口", async () => {
    installGlobals();
    const remote = createFakeCanvasCatalogRemote([]);
    // 显式 ID 不存在 + 无可访问来源 → 恢复页（不创建默认画布）。
    app = await startTestApp({ initialPathname: "/", initialSearch: "?canvasId=legacy-missing", canvasCatalogRemote: remote });
    expect(remote.created).toEqual([]);
    const page = app.currentPage()!;
    expect(page.ctx.get("settingsOpen" as never)).toBeDefined();
    expect(page.ctx.dialogs.registeredDialogIds()).toContain("settings");
  });

  it("兼容打开失败只给显式重试，不自动重试；成功后只打开一次", async () => {
    installGlobals();
    // 首次让设置能力「不可用」：模拟发布/装配暂缺；随后恢复，重试应只成功一次。
    let failNext = true;
    const runtime = createSourceExtensionRuntimeService();
    app = await startTestApp({ initialPathname: "/settings", extensionRuntime: runtime });
    const page = app.currentPage()!;
    const capability = page.ctx.get("settingsOpen" as never) as unknown as {
      open(input?: { canvasId?: string | null }): Promise<{ ok: boolean; reason?: string }>;
    };
    // 关掉已成功打开的实例，制造一次失败：先关闭，再让能力返回失败，再重试。
    const top = page.ctx.dialogs.top();
    if (top) page.ctx.dialogs.close(top.instanceId);
    const original = capability.open.bind(capability);
    capability.open = async () => (failNext ? { ok: false, reason: "设置内容加载失败" } : original());
    await app.retrySettingsIntent();
    expect(app.settingsIntentError()).toBe("设置内容加载失败");
    expect(page.ctx.dialogs.top()).toBeNull();
    // 没有自动重试：错误保留，弹窗仍未打开。
    await Promise.resolve();
    expect(page.ctx.dialogs.top()).toBeNull();
    failNext = false;
    await app.retrySettingsIntent();
    expect(app.settingsIntentError()).toBeNull();
    expect(page.ctx.dialogs.top()?.dialogId).toBe("settings");
    // 重试成功只打开一个实例。
    expect(page.ctx.dialogs.getSnapshot().stack.filter((entry) => entry.dialogId === "settings")).toHaveLength(1);
  });

  it("用户离开画布后旧兼容意图失效（迟到结果不改变新页面）", async () => {
    installGlobals();
    app = await startTestApp({ initialPathname: "/settings" });
    const canvasPage = app.currentPage()!;
    const scopeId = app.router.currentScopeId();
    await app.applyLocation({ page: "task-history" });
    expect(app.router.currentScopeId()).not.toBe(scopeId);
    // 旧壳的设置能力随 scope 释放；Dialog stack 仍可能保留旧实例（App 级 Host），
    // 关键是新页面不再注册设置能力，也不会被迟到重试导航或改动。
    expect(app.currentPage()!.ctx.get("settingsOpen" as never)).toBeUndefined();
    const topBefore = app.currentPage()!.ctx.dialogs.getSnapshot();
    // 迟到的重试不再作用于新页面。
    await app.retrySettingsIntent();
    expect(app.router.getLocation().page).toBe("task-history");
    expect(app.currentPage()!.ctx.dialogs.getSnapshot()).toBe(topBefore);
    expect(canvasPage).not.toBe(app.currentPage());
  });
});
