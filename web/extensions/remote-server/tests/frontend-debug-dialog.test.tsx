/**
 * 「服务端接入日志」调试窗口（`debug-dialog.tsx`）的渲染与轮询测试。
 *
 * 这些用例锁住四件容易做错的事：
 * 1. 只在窗口打开期间轮询，关闭即停，且在途请求不叠加（否则宿主日志窗口会自我放大）；
 * 2. `available:false` 必须说成「宿主不支持」，不能说成「最近没有事件」；
 * 3. 上报只在已连接时可用，成功/失败都要有可见文案（不能点了没反应）；
 * 4. 复制真的把格式化后的条目写出去，失败要提示。
 *
 * 全部用 fake service + fake timers，不碰真实网络与宿主。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { RemoteServerDebugDialog, formatDiagnosticEntry } from "../src/frontend/debug-dialog.js";
import type { RemoteDebugDialogService } from "../src/frontend/debug-dialog.js";
import {
  LOCAL_ONLY_SNAPSHOT,
  type RemoteDiagnosticsReadResult,
  type RemoteDiagnosticsReportResult,
  type RemoteDiagnosticsSnapshot,
  type RemoteServerSnapshot
} from "../src/shared.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_700_000_000_000;

const CONNECTED: RemoteServerSnapshot = {
  phase: "connected",
  serverUrl: "https://canvas.example.com",
  subject: "alice",
  displayName: "Alice",
  expiresAt: NOW + 3_600_000,
  methods: [],
  error: null
};

const DIAGNOSTICS: RemoteDiagnosticsSnapshot = {
  entries: [
    {
      seq: 3,
      time: NOW,
      level: "info",
      category: "probe",
      event: "remote-probe-ok",
      code: "ok",
      message: "探测成功",
      // 插入序刻意与 key 升序相反：界面与复制文本都必须按 key 排序，不能跟着对象序走。
      attributes: { status: "200", server: "canvas.example.com:443" }
    },
    {
      seq: 4,
      time: NOW + 1000,
      level: "warn",
      category: "login",
      event: "remote-login-failed",
      message: "凭证无效"
    }
  ],
  capturedAt: NOW + 2000,
  capacity: 200,
  available: true
};

type FakeOptions = {
  snapshot?: RemoteServerSnapshot;
  load?: () => Promise<RemoteDiagnosticsReadResult>;
  report?: () => Promise<RemoteDiagnosticsReportResult>;
};

function createFakeService(options: FakeOptions = {}) {
  let snapshot = options.snapshot ?? CONNECTED;
  const listeners = new Set<() => void>();
  const loadDiagnostics = vi.fn<() => Promise<RemoteDiagnosticsReadResult>>(
    options.load ?? (async () => ({ ok: true as const, snapshot: DIAGNOSTICS }))
  );
  const reportDiagnostics = vi.fn<() => Promise<RemoteDiagnosticsReportResult>>(
    options.report ?? (async () => ({ ok: true as const, acceptedCount: 2 }))
  );
  const service: RemoteDebugDialogService = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    api: { loadDiagnostics, reportDiagnostics }
  };
  return {
    service,
    loadDiagnostics,
    reportDiagnostics,
    setSnapshot(next: RemoteServerSnapshot) {
      snapshot = next;
      for (const listener of listeners) listener();
    }
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

async function mount(service: RemoteDebugDialogService, props: { copyText?: (text: string) => Promise<void> } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(RemoteServerDebugDialog, { service, instanceId: "remote-debug-test", ...props }));
  });
  let unmounted = false;
  const unmount = async () => {
    if (unmounted) return;
    unmounted = true;
    await act(async () => root.unmount());
    container.remove();
  };
  cleanups.push(unmount);
  return { container, unmount };
}

/** 推进假时钟并冲掉由定时器触发的异步读取。 */
async function tick(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("RemoteServerDebugDialog", () => {
  it("打开即读一次，之后每 1500ms 轮询", async () => {
    vi.useFakeTimers();
    const fake = createFakeService();
    const { container } = await mount(fake.service);

    expect(fake.loadDiagnostics).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('[data-testid="remote-debug-entry"]')).toHaveLength(2);

    await tick(1500);
    expect(fake.loadDiagnostics).toHaveBeenCalledTimes(2);
    await tick(1500);
    expect(fake.loadDiagnostics).toHaveBeenCalledTimes(3);
  });

  it("关闭窗口后不再轮询", async () => {
    vi.useFakeTimers();
    const fake = createFakeService();
    const { unmount } = await mount(fake.service);
    expect(fake.loadDiagnostics).toHaveBeenCalledTimes(1);
    await unmount();
    await tick(5000);
    expect(fake.loadDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("读取在途时不叠加请求（间隔到了也等上一次回来）", async () => {
    vi.useFakeTimers();
    let release!: (result: RemoteDiagnosticsReadResult) => void;
    const fake = createFakeService({
      load: () =>
        new Promise<RemoteDiagnosticsReadResult>((resolve) => {
          release = resolve;
        })
    });
    await mount(fake.service);
    expect(fake.loadDiagnostics).toHaveBeenCalledTimes(1);

    await tick(4500);
    expect(fake.loadDiagnostics).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ ok: true, snapshot: DIAGNOSTICS });
    });
    await tick(1500);
    expect(fake.loadDiagnostics).toHaveBeenCalledTimes(2);
  });

  it("展示连接摘要与已脱敏说明", async () => {
    const fake = createFakeService();
    const { container } = await mount(fake.service);
    const summary = container.querySelector('[data-testid="remote-debug-summary"]');
    expect(summary?.textContent).toContain("已连接");
    expect(summary?.textContent).toContain("https://canvas.example.com");
    expect(summary?.textContent).toContain("Alice");
    expect(container.textContent).toContain("只显示已脱敏的接入与同步事件，不含令牌");
  });

  it("条目按「时间 级别 category event code message」渲染", async () => {
    const fake = createFakeService();
    const { container } = await mount(fake.service);
    const entries = container.querySelectorAll('[data-testid="remote-debug-entry"]');
    const first = entries[0] as HTMLElement;
    expect(first.dataset.level).toBe("info");
    // 时间必须是本地 HH:mm:ss，才能在同一窗口里对齐。
    expect(first.querySelector(".remote-server-debug__time")?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    for (const part of ["INFO", "probe", "remote-probe-ok", "ok", "探测成功"]) {
      expect(first.textContent).toContain(part);
    }
    const second = entries[1] as HTMLElement;
    expect(second.dataset.level).toBe("warn");
    expect(second.textContent).toContain("remote-login-failed");
  });

  it("attributes 按 key 升序渲染成 key=value，缺 attributes 的条目不渲染该区域", async () => {
    const fake = createFakeService();
    const { container } = await mount(fake.service);
    const entries = container.querySelectorAll('[data-testid="remote-debug-entry"]');
    const first = entries[0] as HTMLElement;
    const attributes = first.querySelectorAll('[data-testid="remote-debug-attribute"]');
    // 插入序是 status → server，渲染必须按 key 升序（server → status）。
    expect(Array.from(attributes).map((item) => item.textContent)).toEqual([
      "server=canvas.example.com:443",
      "status=200"
    ]);
    // key 与 value 分样式展示，便于同一行里区分标识与值。
    expect(first.querySelector(".remote-server-debug__attribute-key")?.textContent).toBe("server=");
    expect(first.querySelector(".remote-server-debug__attribute-value")?.textContent).toBe("canvas.example.com:443");

    // 没有 attributes 的条目：不渲染空容器，也不影响既有字段。
    const second = entries[1] as HTMLElement;
    expect(second.querySelector('[data-testid="remote-debug-attributes"]')).toBeNull();
    expect(second.textContent).toContain("凭证无效");
  });

  it("formatDiagnosticEntry 把 attributes 按 key 升序附在文本末尾", () => {
    const text = formatDiagnosticEntry(DIAGNOSTICS.entries[0]!);
    expect(text).toMatch(/^([0-9]{2}:){2}[0-9]{2} INFO probe remote-probe-ok ok 探测成功 /);
    expect(text.endsWith("server=canvas.example.com:443 status=200")).toBe(true);
    // 没有 attributes 时文本不额外追加空串或分隔符。
    const withoutAttributes = formatDiagnosticEntry(DIAGNOSTICS.entries[1]!);
    expect(withoutAttributes.endsWith("凭证无效")).toBe(true);
    expect(withoutAttributes).not.toContain("=");
  });

  it("available:false 时明说宿主不支持，而不是空列表", async () => {
    const fake = createFakeService({
      load: async () => ({
        ok: true as const,
        snapshot: { entries: [], capturedAt: 0, capacity: 0, available: false }
      })
    });
    const { container } = await mount(fake.service);
    const unavailable = container.querySelector('[data-testid="remote-debug-unavailable"]');
    expect(unavailable).not.toBeNull();
    expect(unavailable?.textContent).toContain("不支持");
    // 不可用态不能再渲染「最近还没有接入事件」这种会误导的文案。
    expect(container.textContent).not.toContain("最近还没有接入事件");
  });

  it("空态：可用但没有事件", async () => {
    const fake = createFakeService({
      load: async () => ({
        ok: true as const,
        snapshot: { entries: [], capturedAt: NOW, capacity: 200, available: true }
      })
    });
    const { container } = await mount(fake.service);
    expect(container.textContent).toContain("最近还没有接入事件");
    expect(container.querySelector('[data-testid="remote-debug-unavailable"]')).toBeNull();
    expect((container.querySelector('[data-testid="remote-debug-copy"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("错误态：显示读取失败原因", async () => {
    const fake = createFakeService({ load: async () => ({ ok: false as const, error: "宿主不支持接入日志" }) });
    const { container } = await mount(fake.service);
    const status = container.querySelector('[data-testid="remote-debug-status"]');
    expect(status?.getAttribute("data-state")).toBe("error");
    expect(status?.textContent).toContain("读取失败");
    expect(status?.textContent).toContain("宿主不支持接入日志");
  });

  it("未连接时禁用上报，已连接时可用", async () => {
    vi.useFakeTimers();
    const disconnected = createFakeService({ snapshot: LOCAL_ONLY_SNAPSHOT });
    const first = await mount(disconnected.service);
    const disabledButton = first.container.querySelector('[data-testid="remote-debug-report"]') as HTMLButtonElement;
    expect(disabledButton.disabled).toBe(true);
    await first.unmount();

    const connected = createFakeService();
    const second = await mount(connected.service);
    const enabledButton = second.container.querySelector('[data-testid="remote-debug-report"]') as HTMLButtonElement;
    expect(enabledButton.disabled).toBe(false);
  });

  it("上报成功显示受理条数", async () => {
    vi.useFakeTimers();
    const fake = createFakeService({ report: async () => ({ ok: true as const, acceptedCount: 7 }) });
    const { container } = await mount(fake.service);
    await act(async () => {
      (container.querySelector('[data-testid="remote-debug-report"]') as HTMLButtonElement).click();
    });
    expect(fake.reportDiagnostics).toHaveBeenCalledTimes(1);
    const result = container.querySelector('[data-testid="remote-debug-report-result"]');
    expect(result?.textContent).toContain("已上报 7 条");
  });

  it("上报失败显示原因（例如服务端尚未实现）", async () => {
    vi.useFakeTimers();
    const fake = createFakeService({
      report: async () => ({ ok: false as const, error: "服务端尚未实现诊断上报接口" })
    });
    const { container } = await mount(fake.service);
    await act(async () => {
      (container.querySelector('[data-testid="remote-debug-report"]') as HTMLButtonElement).click();
    });
    const result = container.querySelector('[data-testid="remote-debug-report-result"]');
    expect(result?.textContent).toContain("上报失败");
    expect(result?.textContent).toContain("服务端尚未实现诊断上报接口");
  });

  it("复制把格式化后的条目写出去", async () => {
    const copyText = vi.fn(async (_text: string) => undefined);
    const fake = createFakeService();
    const { container } = await mount(fake.service, { copyText });
    await act(async () => {
      (container.querySelector('[data-testid="remote-debug-copy"]') as HTMLButtonElement).click();
    });
    expect(copyText).toHaveBeenCalledTimes(1);
    const written = copyText.mock.calls[0]?.[0] as string;
    expect(written).toContain(formatDiagnosticEntry(DIAGNOSTICS.entries[0]!));
    // 复制文本同样带 attributes，且按 key 升序；界面里看得到的细节不能复制时丢掉。
    expect(written).toContain("server=canvas.example.com:443 status=200");
    expect(written.split("\n")).toHaveLength(2);
    expect(container.querySelector('[data-testid="remote-debug-copy-result"]')?.textContent).toContain("已复制 2 条");
  });

  it("复制失败给出提示，不静默", async () => {
    const copyText = vi.fn(async (_text: string) => {
      throw new Error("当前环境不支持剪贴板");
    });
    const fake = createFakeService();
    const { container } = await mount(fake.service, { copyText });
    await act(async () => {
      (container.querySelector('[data-testid="remote-debug-copy"]') as HTMLButtonElement).click();
    });
    const result = container.querySelector('[data-testid="remote-debug-copy-result"]');
    expect(result?.textContent).toContain("复制失败");
    expect(result?.textContent).toContain("当前环境不支持剪贴板");
  });

  it("连点两下只发一次上报（在途去重）", async () => {
    vi.useFakeTimers();
    let release!: (result: RemoteDiagnosticsReportResult) => void;
    const fake = createFakeService({
      report: () =>
        new Promise<RemoteDiagnosticsReportResult>((resolve) => {
          release = resolve;
        })
    });
    const { container } = await mount(fake.service);
    const button = container.querySelector('[data-testid="remote-debug-report"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
      button.click();
      await Promise.resolve();
    });
    expect(fake.reportDiagnostics).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({ ok: true, acceptedCount: 1 });
    });
    expect(container.querySelector('[data-testid="remote-debug-report-result"]')?.textContent).toContain(
      "已上报 1 条"
    );
  });

  it("刷新按钮立即读一次（不等下一个轮询间隔）", async () => {
    vi.useFakeTimers();
    const fake = createFakeService();
    const { container } = await mount(fake.service);
    expect(fake.loadDiagnostics).toHaveBeenCalledTimes(1);
    await act(async () => {
      (container.querySelector('[data-testid="remote-debug-refresh"]') as HTMLButtonElement).click();
    });
    expect(fake.loadDiagnostics).toHaveBeenCalledTimes(2);
  });
});
