/**
 * 设置面板与徽标的渲染测试：只断言**可见语义**，不测样式。
 *
 * 重点是三条产品判断被真的渲染出来：
 * - 本地模式不是错误（不出现 alert 角色，不用警示文案）；
 * - 已连接时能看出「接的是哪台、以谁的身份」；
 * - 令牌输入框在连接成功后必须清空（不把凭据留在 DOM 里）。
 */
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CanvasSummary } from "@woohaa3/contracts";
import {
  RemoteServerCatalogAction,
  createRemoteServerCatalogActionRenderer
} from "../src/frontend/catalog-action.js";
import { RemoteServerBadge } from "../src/frontend/remote-badge.js";
import { RemoteServerSettingsPanel } from "../src/frontend/settings-panel.js";
import { createRemoteServerService } from "../src/frontend/remote.js";

// React 18 的 act 需要显式声明测试环境。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createService(responses: Record<string, unknown> = {}) {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const transport = {
    request: vi.fn(async (input: { path: string; body?: unknown }) => {
      calls.push(input);
      const key = Object.keys(responses).find((suffix) => input.path.endsWith(suffix));
      if (key === undefined) return { ok: false as const, code: "unavailable" as const, error: "未配置" };
      return { ok: true as const, status: 200, data: responses[key] };
    })
  };
  return { service: createRemoteServerService(transport), calls };
}

async function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return { container, unmount: () => act(() => root.unmount()) };
}

describe("RemoteServerBadge", () => {
  it("本地模式显示「本地模式」，不带警示语义", async () => {
    const { service } = createService({ "/session": { phase: "local", subject: null, serverUrl: null, methods: [], error: null } });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mount(createElement(RemoteServerBadge, { service }));
    const badge = container.querySelector('[data-testid="remote-server-badge"]');
    expect(badge?.getAttribute("data-phase")).toBe("local");
    expect(badge?.textContent).toBe("本地模式");
    // 作用域词：徽标描述远端账号/链路，不是画布连接。
    expect(badge?.getAttribute("title")).toContain("画布同步状态以右下角为准");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    unmount();
  });

  it("已连接时显示主体与地址提示", async () => {
    const { service } = createService({
      "/session": {
        phase: "connected",
        serverUrl: "https://canvas.example.com",
        subject: "alice",
        displayName: "Alice",
        expiresAt: Date.now() + 3600_000,
        methods: [],
        error: null
      }
    });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mount(createElement(RemoteServerBadge, { service }));
    const badge = container.querySelector('[data-testid="remote-server-badge"]');
    expect(badge?.getAttribute("data-phase")).toBe("connected");
    // 标签必须带「远端」限定词：避免「已接服务端」被读成「画布已连接」。
    expect(badge?.textContent).toBe("远端已接入");
    expect(badge?.getAttribute("title")).toContain("远端服务端账号/链路");
    expect(badge?.getAttribute("title")).toContain("canvas.example.com");
    expect(badge?.getAttribute("title")).toContain("Alice");
    expect(badge?.getAttribute("title")).toContain("画布同步状态以右下角为准");
    unmount();
  });

  it("四相标签都带「远端」作用域词：不会被读成画布连接状态", async () => {
    const { service } = createService({ "/session": { phase: "local", subject: null, serverUrl: null, methods: [], error: null } });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mount(createElement(RemoteServerBadge, { service }));
    const cases = [
      ["local", "本地模式"],
      ["connecting", "远端连接中"],
      ["connected", "远端已接入"],
      ["error", "远端异常"]
    ] as const;
    for (const [phase, label] of cases) {
      await act(async () => {
        service.setSnapshot({
          phase,
          serverUrl: phase === "connected" ? "https://canvas.example.com" : null,
          subject: phase === "connected" ? "alice" : null,
          displayName: phase === "connected" ? "Alice" : null,
          expiresAt: null,
          methods: [],
          error: phase === "error" ? "连不上服务端" : null
        });
      });
      const badge = container.querySelector('[data-testid="remote-server-badge"]');
      // data-phase 仍是四相枚举本身：标签换了作用域词，状态机没变。
      expect(badge?.getAttribute("data-phase")).toBe(phase);
      expect(badge?.textContent).toBe(label);
      // 悬停说明必须说清「画布同步状态以右下角为准」，否则两处指示仍会打架。
      expect(badge?.getAttribute("title")).toContain("画布同步状态以右下角为准");
    }
    unmount();
  });

  it("注入 onOpen 时徽标可点，点击即打开设置面板（接入状态的下一动作就是去改配置）", async () => {
    const { service } = createService({ "/session": { phase: "local", subject: null, serverUrl: null, methods: [], error: null } });
    await act(async () => {
      await service.refresh();
    });
    const onOpen = vi.fn();
    const { container, unmount } = await mount(createElement(RemoteServerBadge, { service, onOpen }));
    const badge = container.querySelector('[data-testid="remote-server-badge"]');
    // 可点时必须是真正的 button：span + onClick 无法键盘触发，也会被读屏当成纯文本。
    expect(badge?.tagName).toBe("BUTTON");
    await act(async () => {
      (badge as HTMLButtonElement).click();
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("没有 onOpen 时退化为只读 span（空壳/恢复页没有设置能力，不渲染死按钮）", async () => {
    const { service } = createService({ "/session": { phase: "local", subject: null, serverUrl: null, methods: [], error: null } });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mount(createElement(RemoteServerBadge, { service }));
    const badge = container.querySelector('[data-testid="remote-server-badge"]');
    expect(badge?.tagName).toBe("SPAN");
    unmount();
  });
});

describe("RemoteServerSettingsPanel（设置里的接入面板）", () => {
  it("本地模式：说明只在本地保存，提供地址，但不要求输入任何凭据", async () => {
    const { service } = createService({ "/session": { phase: "local", subject: null, serverUrl: null, methods: [], error: null } });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mount(createElement(RemoteServerSettingsPanel, { service }));
    expect(container.textContent).toContain("本地模式");
    expect(container.textContent).toContain("只在本地保存");
    expect(container.querySelector('[data-testid="server-address"]')).not.toBeNull();
    // 登录发生在服务端：客户端面板**不得**出现令牌输入框（把服务端登录表单搬过来是错的）。
    expect(container.querySelector('[data-testid="server-token"]')).toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    unmount();
  });

  it("已连接：显示地址与主体，令牌输入消失", async () => {
    // 宿主报告已连接：面板挂载时读到的就是 connected。
    const { service } = createService({
      "/session": {
        phase: "connected",
        serverUrl: "https://canvas.example.com",
        subject: "alice",
        displayName: "Alice",
        expiresAt: Date.now() + 3600_000,
        methods: [],
        error: null
      }
    });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mount(createElement(RemoteServerSettingsPanel, { service }));
    expect(container.textContent).toContain("已连接");
    expect(container.textContent).toContain("canvas.example.com");
    expect(container.textContent).toContain("Alice");
    // 已连接后不应再出现凭据输入。
    expect(container.querySelector('[data-testid="server-token"]')).toBeNull();
    expect(container.querySelector('[data-testid="server-disconnect"]')).not.toBeNull();
    unmount();
  });

  it("登录成功后被迟到刷新打回的问题已修复（本地推进作废在途结果）", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = {
      request: vi.fn(async (input: { path: string }) => {
        if (input.path.endsWith("/session")) {
          // 让挂载时那次 refresh 一直挂着，模拟慢响应。
          await gate;
          return { ok: true as const, status: 200, data: { phase: "local", subject: null, serverUrl: null, methods: [], error: null } };
        }
        return { ok: false as const, code: "unavailable" as const, error: "未配置" };
      })
    };
    const service = createRemoteServerService(transport);
    const pending = service.refresh();
    // 刷新在途时登录成功：本地推进必须赢。
    service.setSnapshot({
      phase: "connected",
      serverUrl: "https://canvas.example.com",
      subject: "alice",
      displayName: "Alice",
      expiresAt: Date.now() + 3600_000,
      methods: [],
      error: null
    });
    release!();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 迟到的 local 快照不得覆盖已登录状态。
    expect(service.getSnapshot()).toMatchObject({ phase: "connected", subject: "alice" });
  });

  it("点击登录后展示服务端短码与批准页地址，且不出现任何凭据输入", async () => {
    const { service } = createService({
      "/session": { phase: "local", subject: null, serverUrl: null, methods: [], error: null },
      "/device-start": {
        ok: true,
        userCode: "BCDF-GHJK",
        verificationUri: "https://canvas.example.com/device",
        intervalMs: 3000,
        expiresAt: Date.now() + 15 * 60_000
      }
    });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mount(createElement(RemoteServerSettingsPanel, { service }));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="server-connect"]')!.click();
    });
    // 短码与批准页地址都要显示出来——人是靠它们去服务端登录的。
    const device = container.querySelector('[data-testid="server-device-code"]');
    expect(device).not.toBeNull();
    expect(device?.textContent).toContain("BCDF-GHJK");
    expect(device?.textContent).toContain("canvas.example.com/device");
    // 客户端依然不收集任何凭据。
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('[data-testid="server-token"]')).toBeNull();
    unmount();
  });

  it("发起失败时显示原因，且不要求输入凭据", async () => {
    const { service } = createService({
      "/session": { phase: "local", subject: null, serverUrl: null, methods: [], error: null },
      "/device-start": { ok: false, error: "这台服务端没有启用设备码登录（需要配置对外地址）" }
    });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mount(createElement(RemoteServerSettingsPanel, { service }));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="server-connect"]')!.click();
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("设备码登录");
    expect(container.querySelector('input[type="password"]')).toBeNull();
    unmount();
  });

  it("提供 onOpenDebug 时显示「服务端日志」入口；未提供时不渲染死按钮", async () => {
    const { service } = createService({ "/session": { phase: "local", subject: null, serverUrl: null, methods: [], error: null } });
    await act(async () => {
      await service.refresh();
    });
    // 宿主没有 dialogs 能力（空壳/恢复页）时不传 onOpenDebug：面板不该摆一个点了没反应的入口。
    const withoutEntry = await mount(createElement(RemoteServerSettingsPanel, { service }));
    expect(withoutEntry.container.querySelector('[data-testid="server-open-debug"]')).toBeNull();
    withoutEntry.unmount();

    const onOpenDebug = vi.fn();
    const withEntry = await mount(createElement(RemoteServerSettingsPanel, { service, onOpenDebug }));
    const button = withEntry.container.querySelector<HTMLButtonElement>('[data-testid="server-open-debug"]');
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
    });
    expect(onOpenDebug).toHaveBeenCalledTimes(1);
    withEntry.unmount();
  });

  it("面板本身不轮询、也不读诊断（打开入口不产生诊断请求）", async () => {
    const { service, calls } = createService({
      "/session": {
        phase: "connected",
        serverUrl: "https://canvas.example.com",
        subject: "alice",
        displayName: "Alice",
        expiresAt: Date.now() + 3600_000,
        methods: [],
        error: null
      }
    });
    await act(async () => {
      await service.refresh();
    });
    const before = calls.length;
    const { unmount } = await mount(
      createElement(RemoteServerSettingsPanel, { service, onOpenDebug: () => undefined })
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // 诊断读取属于调试窗口：设置面板只在挂载时共享一次 refresh。
    // 已连接时面板还会读一次托管生成的目录状态（「服务端模型 N 个」的初值），这是一次性读取，
    // 不是轮询：再等一个 tick 也不能增加请求（change: 2026-10-20-reserve-remote-generation-provider）。
    expect(calls.filter((call) => call.path.endsWith("/diagnostics")).length).toBe(0);
    expect(calls.length - before).toBeLessThanOrEqual(2);
    expect(calls.filter((call) => call.path.endsWith("/generation-refresh")).length).toBe(1);
    const settled = calls.length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(calls.length).toBe(settled);
    unmount();
  });

  it("已连接时展示服务端模型数量，并可用「刷新模型」重新读取（不需要重载页面）", async () => {
    const { service, calls } = createService({
      "/session": {
        phase: "connected",
        serverUrl: "https://canvas.example.com",
        subject: "alice",
        displayName: "Alice",
        expiresAt: Date.now() + 3600_000,
        methods: [],
        error: null
      },
      "/generation-refresh": { available: true, modelCount: 3, catalogRevision: 7 }
    });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mount(createElement(RemoteServerSettingsPanel, { service }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-testid="server-generation-models"]')?.textContent).toContain("3 个");
    // 数量留在接入状态区；具体模型由宿主快照投影到下方「生成的模型」区（只读），
    // 面板不再声称「这里只有数量」——否则人找不到模型去哪了。
    expect(container.textContent).toContain("生成的模型");

    const before = calls.filter((call) => call.path.endsWith("/generation-refresh")).length;
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="server-refresh-models"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(calls.filter((call) => call.path.endsWith("/generation-refresh")).length).toBe(before + 1);
    unmount();
  });
});

describe("预置服务端地址（部署配置里的 serverUrl）", () => {
  it("预置地址随快照下发时，输入框直接带着它，不需要用户从头填", async () => {
    // 这正是之前的 bug：后端一直把 configuredServerUrl 放进 local 快照的 serverUrl，
    // 但面板从没读它（prop 无调用方传入），于是部署配了也对用户毫无帮助。
    const { service } = createService({
      "/session": {
        phase: "local",
        serverUrl: "https://server.example.com",
        subject: null,
        displayName: null,
        expiresAt: null,
        methods: [],
        error: null
      }
    });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mount(createElement(RemoteServerSettingsPanel, { service }));
    const input = container.querySelector<HTMLInputElement>('[data-testid="server-address"]');
    expect(input?.value).toBe("https://server.example.com");
    // 预置值必须说明来源，否则人不知道它从哪来、也不确定能不能直接用。
    expect(container.querySelector('[data-testid="server-address-preset"]')).not.toBeNull();
    unmount();
  });

  it("未预置时输入框为空，也不显示「由部署预置」的说明", async () => {
    const { service } = createService({ "/session": { phase: "local", subject: null, serverUrl: null, methods: [], error: null } });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mount(createElement(RemoteServerSettingsPanel, { service }));
    const input = container.querySelector<HTMLInputElement>('[data-testid="server-address"]');
    expect(input?.value).toBe("");
    expect(container.querySelector('[data-testid="server-address-preset"]')).toBeNull();
    unmount();
  });

  it("用户改过地址后，预置说明消失（它描述的是「当前值就是预置值」）", async () => {
    const { service } = createService({
      "/session": {
        phase: "local",
        serverUrl: "https://preset.example.com",
        subject: null,
        displayName: null,
        expiresAt: null,
        methods: [],
        error: null
      }
    });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mount(createElement(RemoteServerSettingsPanel, { service }));
    const input = container.querySelector<HTMLInputElement>('[data-testid="server-address"]')!;
    expect(container.querySelector('[data-testid="server-address-preset"]')).not.toBeNull();
    await act(async () => {
      // React 受控输入：改 value 后要派发 input 事件才会走到 onChange。
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "https://other.example.com");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="server-address-preset"]')).toBeNull();
    unmount();
  });
});

describe("复制短码（省一次手抄，但不把短码放进地址）", () => {
  it("复制按钮写进剪贴板的是短码本身", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) }
    });
    const { service } = createService({
      "/session": { phase: "local", subject: null, serverUrl: null, methods: [], error: null },
      "/device-start": {
        ok: true,
        userCode: "BCDF-GHJK",
        verificationUri: "https://canvas.example.com/device",
        intervalMs: 3000,
        expiresAt: Date.now() + 15 * 60_000
      }
    });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mount(createElement(RemoteServerSettingsPanel, { service }));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="server-connect"]')!.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="server-device-copy"]')!.click();
    });
    expect(written).toEqual(["BCDF-GHJK"]);
    expect(container.querySelector('[data-testid="server-device-copy"]')?.textContent).toContain("已复制");
    unmount();
  });

  it("批准页地址里没有短码（短码不进 URL 是安全要求，不是 UI 偏好）", async () => {
    const { service } = createService({
      "/session": { phase: "local", subject: null, serverUrl: null, methods: [], error: null },
      "/device-start": {
        ok: true,
        userCode: "BCDF-GHJK",
        verificationUri: "https://canvas.example.com/device",
        intervalMs: 3000,
        expiresAt: Date.now() + 15 * 60_000
      }
    });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mount(createElement(RemoteServerSettingsPanel, { service }));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="server-connect"]')!.click();
    });
    const link = container.querySelector<HTMLAnchorElement>('[data-testid="server-device-code"] a');
    expect(link?.getAttribute("href")).toBe("https://canvas.example.com/device");
    // 两种写法都要查：`?code=` 与裸短码都不许出现在地址里。
    expect(link?.getAttribute("href")).not.toContain("BCDF");
    expect(link?.getAttribute("href")).not.toContain("code=");
    unmount();
  });
});

/** 画布目录条目动作测试用的已连接快照（与徽标测试同一形状）。 */
const connectedSnapshot = {
  phase: "connected" as const,
  serverUrl: "https://canvas.example.com",
  subject: "alice",
  displayName: "Alice",
  expiresAt: 1_800_000_000_000,
  methods: [],
  error: null
};

function makeEntry(overrides: Partial<CanvasSummary> = {}): CanvasSummary {
  return {
    id: "canvas-1",
    title: "本地画布",
    revision: 1,
    updatedAt: "2026-10-19T00:00:00.000Z",
    createdAt: "2026-10-19T00:00:00.000Z",
    nodeCount: 0,
    assetCount: 0,
    sources: ["local"],
    sync: "local-only",
    ...overrides
  };
}

async function mountCatalogAction(input: {
  service: ReturnType<typeof createRemoteServerService>;
  entry?: CanvasSummary;
  openCanvas?: (canvasId: string) => void;
  refreshCatalog?: () => Promise<void>;
}) {
  const props = {
    service: input.service,
    entry: input.entry ?? makeEntry(),
    openCanvas: input.openCanvas ?? vi.fn(),
    refreshCatalog: input.refreshCatalog ?? vi.fn(async () => undefined)
  };
  return { ...(await mount(createElement(RemoteServerCatalogAction, props))), props };
}

describe("画布目录条目动作「同步远端」", () => {
  it("未读取过状态（缺省 local）不渲染：登录远端不等于自动上传", async () => {
    const { service } = createService({});
    const { container, unmount } = await mountCatalogAction({ service });
    expect(container.querySelector('[data-testid="remote-server-catalog-sync"]')).toBeNull();
    unmount();
  });

  it("未连接（本地模式）不渲染按钮", async () => {
    const { service } = createService({
      "/session": { phase: "local", subject: null, serverUrl: null, methods: [], error: null }
    });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mountCatalogAction({ service });
    expect(container.querySelector('[data-testid="remote-server-catalog-sync"]')).toBeNull();
    unmount();
  });

  it("已连接 + 仅本机：渲染「同步远端」轻量按钮", async () => {
    const { service } = createService({ "/session": connectedSnapshot });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mountCatalogAction({ service });
    const button = container.querySelector<HTMLButtonElement>('[data-testid="remote-server-catalog-sync"]');
    expect(button).not.toBeNull();
    expect(button?.tagName).toBe("BUTTON");
    expect(button?.textContent).toBe("同步远端");
    expect(button?.disabled).toBe(false);
    // 悬停提示说清这件事只对「仅本机」的画布做，避免被理解成全局开关。
    expect(button?.getAttribute("title")).toContain("仅本机");
    unmount();
  });

  it("旧响应没有 sources / sync 时视为仅本机（纯本地部署兼容）", async () => {
    const { service } = createService({ "/session": connectedSnapshot });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mountCatalogAction({
      service,
      entry: makeEntry({ sources: undefined, sync: undefined })
    });
    expect(container.querySelector('[data-testid="remote-server-catalog-sync"]')).not.toBeNull();
    unmount();
  });

  it("已在远端的条目不再出现该动作（来源含 remote 或 sync 已不是 local-only）", async () => {
    const { service } = createService({ "/session": connectedSnapshot });
    await act(async () => {
      await service.refresh();
    });
    const entries: CanvasSummary[] = [
      makeEntry({ sources: ["local", "remote"], sync: "synced" }),
      makeEntry({ sources: ["local", "remote"] }),
      makeEntry({ sources: ["remote"], sync: "remote-only" }),
      makeEntry({ sources: ["local", "remote"], sync: "syncing" }),
      makeEntry({ sources: ["local", "remote"], sync: "offline" }),
      makeEntry({ sources: ["local", "remote"], sync: "failed" })
    ];
    for (const entry of entries) {
      const { container, unmount } = await mountCatalogAction({ service, entry });
      expect(container.querySelector('[data-testid="remote-server-catalog-sync"]')).toBeNull();
      unmount();
    }
  });

  it("文档已同步、媒体仍在补传时显示「同步中」并短轮询目录", async () => {
    vi.useFakeTimers();
    try {
      const { service } = createService({ "/session": connectedSnapshot });
      await act(async () => {
        await service.refresh();
      });
      const refreshCatalog = vi.fn(async () => undefined);
      const entry = makeEntry({ sources: ["local", "remote"], sync: "syncing" });
      const { container, unmount } = await mountCatalogAction({ service, entry, refreshCatalog });
      // 不再给「同步远端」按钮（已经启用过），但仍要让人看出资源还没传完。
      expect(container.querySelector('[data-testid="remote-server-catalog-sync"]')).toBeNull();
      expect(container.querySelector('[data-testid="remote-server-catalog-syncing"]')?.textContent).toContain("同步中");
      await act(async () => {
        vi.advanceTimersByTime(1600);
      });
      expect(refreshCatalog).toHaveBeenCalledTimes(1);
      await unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("贡献工厂返回的组件可直接按宿主契约渲染（index.ts 注册走的正是这条路）", async () => {
    const { service } = createService({ "/session": connectedSnapshot });
    await act(async () => {
      await service.refresh();
    });
    const Action = createRemoteServerCatalogActionRenderer(service);
    const { container, unmount } = await mount(
      createElement(Action, {
        entry: makeEntry(),
        openCanvas: vi.fn(),
        refreshCatalog: vi.fn(async () => undefined)
      })
    );
    expect(container.querySelector('[data-testid="remote-server-catalog-sync"]')?.textContent).toBe("同步远端");
    unmount();
  });

  it("点击：先调用启用 handler，成功后依次刷新目录、切到该画布", async () => {
    const { service, calls } = createService({
      "/session": connectedSnapshot,
      "/canvas-sync-enable": { ok: true }
    });
    await act(async () => {
      await service.refresh();
    });
    const order: string[] = [];
    const openCanvas = vi.fn((_canvasId: string) => {
      order.push("open");
    });
    const refreshCatalog = vi.fn(async () => {
      order.push("refresh");
    });
    const { container, unmount } = await mountCatalogAction({ service, openCanvas, refreshCatalog });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="remote-server-catalog-sync"]')?.click();
    });

    const enableCalls = calls.filter((call) => call.path.endsWith("/canvas-sync-enable"));
    expect(enableCalls).toHaveLength(1);
    expect(enableCalls[0]?.path).toBe("/api/extensions/remote-server/handlers/canvas-sync-enable");
    expect(enableCalls[0]?.body).toEqual({ canvasId: "canvas-1" });
    // 顺序是硬要求：先刷新目录（来源变远端），再切画布（首次推送在加载后开始）。
    expect(order).toEqual(["refresh", "open"]);
    expect(openCanvas).toHaveBeenCalledWith("canvas-1");
    expect(container.querySelector('[data-testid="remote-server-catalog-error"]')).toBeNull();
    unmount();
  });

  it("失败时按钮旁显示原因并恢复可点，重试成功后照常刷新与切画布", async () => {
    let attempts = 0;
    const transport = {
      request: vi.fn(async (input: { path: string; method?: string; body?: unknown }) => {
        if (input.path.endsWith("/session")) return { ok: true as const, status: 200, data: connectedSnapshot };
        if (input.path.endsWith("/canvas-sync-enable")) {
          attempts += 1;
          return attempts === 1
            ? { ok: true as const, status: 200, data: { ok: false, error: "当前账号没有这张画布的写权限" } }
            : { ok: true as const, status: 200, data: { ok: true } };
        }
        return { ok: false as const, code: "unavailable" as const, error: "未配置" };
      })
    };
    const service = createRemoteServerService(transport);
    await act(async () => {
      await service.refresh();
    });
    const order: string[] = [];
    const openCanvas = vi.fn(() => {
      order.push("open");
    });
    const refreshCatalog = vi.fn(async () => {
      order.push("refresh");
    });
    const { container, unmount } = await mountCatalogAction({ service, openCanvas, refreshCatalog });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="remote-server-catalog-sync"]')?.click();
    });
    const error = container.querySelector('[data-testid="remote-server-catalog-error"]');
    expect(error?.textContent).toContain("没有这张画布的写权限");
    // 失败不得刷新目录、也不得切画布：什么都没发生，界面状态保持原样。
    expect(order).toEqual([]);
    const button = container.querySelector<HTMLButtonElement>('[data-testid="remote-server-catalog-sync"]');
    expect(button?.disabled).toBe(false);
    expect(button?.textContent).toBe("同步远端");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="remote-server-catalog-sync"]')?.click();
    });
    expect(attempts).toBe(2);
    expect(order).toEqual(["refresh", "open"]);
    expect(container.querySelector('[data-testid="remote-server-catalog-error"]')).toBeNull();
    unmount();
  });

  it("同步中禁用并显示「同步中…」，完成后恢复（不做轮询）", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = {
      request: vi.fn(async (input: { path: string; method?: string; body?: unknown }) => {
        if (input.path.endsWith("/session")) return { ok: true as const, status: 200, data: connectedSnapshot };
        // 启用请求挂住，模拟慢响应。
        await gate;
        return { ok: true as const, status: 200, data: { ok: true } };
      })
    };
    const service = createRemoteServerService(transport);
    await act(async () => {
      await service.refresh();
    });
    const openCanvas = vi.fn();
    const refreshCatalog = vi.fn(async () => undefined);
    const { container, unmount } = await mountCatalogAction({ service, openCanvas, refreshCatalog });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="remote-server-catalog-sync"]')?.click();
    });
    const pendingButton = container.querySelector<HTMLButtonElement>('[data-testid="remote-server-catalog-sync"]');
    expect(pendingButton?.disabled).toBe(true);
    expect(pendingButton?.textContent).toBe("同步中…");
    // 在途期间只发了一次启用请求：连点不会重复提交。
    expect(
      transport.request.mock.calls.filter(([input]) => input.path.endsWith("/canvas-sync-enable"))
    ).toHaveLength(1);

    await act(async () => {
      release?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const doneButton = container.querySelector<HTMLButtonElement>('[data-testid="remote-server-catalog-sync"]');
    expect(doneButton?.disabled).toBe(false);
    expect(doneButton?.textContent).toBe("同步远端");
    expect(openCanvas).toHaveBeenCalledWith("canvas-1");
    expect(refreshCatalog).toHaveBeenCalledTimes(1);
    unmount();
  });
});
