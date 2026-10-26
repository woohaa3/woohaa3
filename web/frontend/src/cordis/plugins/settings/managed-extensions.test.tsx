/**
 * 受管扩展设置面（change: 2026-10-21-add-extension-marketplace-point，任务 7.2 / 7.3 / design D10、D11）。
 *
 * 覆盖：安装失败展示稳定中文原因、需要重启提示与重启不支持、内置扩展卡片无受管操作、
 * 受管卡片来源/信任/权限/回滚/卸载、任务轮询到终态后重取设置、接管快照里的进行中任务。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ExtensionInstallJobView, InstalledExtensionView, SettingPluginView, SettingsSnapshot } from "@woohaa3/contracts";
import { createBackendSettingsStore } from "./backend-settings-store.js";
import { PluginSettingsSection } from "./plugin-settings-section.js";
import { createManagedExtensionsController, describeJob, failureReason } from "./managed-extensions.js";
import type { ExtensionInstallRemote } from "../../services/extension-install-remote.js";
import type { ExtensionManagerFacade, ExtensionManagerView } from "../extension-manager/contract.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots = new Set<Root>();
afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.innerHTML = "";
});

const plugin = (id: string): SettingPluginView => ({ id, label: id, description: "", layer: "extension", settingCount: 0, siteManaged: false, provider: false });

const builtin = (id: string): InstalledExtensionView => ({ id, label: id, description: "", directory: `/plugins/${id}`, writable: false });
const managedEntry = (id: string, overrides: Partial<InstalledExtensionView> = {}): InstalledExtensionView => ({
  ...builtin(id),
  directory: `/data/extensions/installed/${id}/1.1.0`,
  version: "1.1.0",
  managed: true,
  previousVersion: "1.0.0",
  sourceId: "local-file",
  trust: "signed:woohaa-dev",
  permissions: { network: ["api.example.com"], canvas: "read" },
  ...overrides
});

function facade(): ExtensionManagerFacade {
  const view: ExtensionManagerView = { rows: [], siteRows: [], modelRows: [], siteManageable: true, siteError: null, pending: false, persistenceMessage: null, error: null };
  return {
    getSnapshot: () => view,
    subscribe: () => () => undefined,
    setEnabled: () => undefined,
    refresh: () => undefined,
    setSiteEnabled: () => undefined,
    siteRows: () => [],
    canManageSite: () => true,
    modelRows: () => [],
    setModelEnabled: () => undefined,
    setModelsEnabled: () => undefined,
    setModelDefault: () => undefined,
    refreshModels: async () => undefined
  } as unknown as ExtensionManagerFacade;
}

function job(overrides: Partial<ExtensionInstallJobView> = {}): ExtensionInstallJobView {
  return { jobId: "job-1", action: "install", sourceId: "local-file", status: "running", phase: "verify", startedAt: "2026-10-21T00:00:00.000Z", ...overrides };
}

/** 手动驱动的定时器：测试显式推进轮询。 */
function manualTimers() {
  const queue: Array<() => void> = [];
  return {
    setTimer: (callback: () => void) => {
      queue.push(callback);
      return queue.length;
    },
    clearTimer: () => undefined,
    async flush() {
      const pending = queue.splice(0);
      for (const callback of pending) await callback();
      await Promise.resolve();
    }
  };
}

function remoteWith(overrides: Partial<ExtensionInstallRemote> = {}): ExtensionInstallRemote {
  return {
    installFile: vi.fn(async () => ({ ok: true as const, jobId: "job-1" })),
    job: vi.fn(async () => ({ ok: true as const, job: job({ status: "succeeded", phase: "observe", outcome: "installed", extensionId: "demo", version: "1.0.0" }) })),
    cancel: vi.fn(async () => ({ ok: true as const, job: job({ status: "cancelled" }) })),
    uninstall: vi.fn(async () => ({ ok: true as const, jobId: "job-u" })),
    rollback: vi.fn(async () => ({ ok: true as const, jobId: "job-r" })),
    restart: vi.fn(async () => ({ ok: true as const })),
    ...overrides
  };
}

async function render(
  snapshot: SettingsSnapshot,
  remote: ExtensionInstallRemote,
  timers = manualTimers(),
  extras: { pending?: string[]; reopenCanvas?: () => Promise<void> } = {}
) {
  const store = createBackendSettingsStore({ fetchSnapshot: async () => ({ ok: true, snapshot }), write: async () => ({ ok: false, code: "x", error: "x" }) });
  await store.load();
  const reload = vi.fn(async () => undefined);
  const controller = createManagedExtensionsController({ remote, reload, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const pending: string[] = extras.pending ?? [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.add(root);
  await act(async () => {
    root.render(
      <PluginSettingsSection
        store={store}
        manager={facade()}
        managed={{
          controller,
          pendingReopen: { get: () => pending, subscribe: () => () => undefined },
          ...(extras.reopenCanvas ? { reopenCanvas: extras.reopenCanvas } : {})
        }}
      />
    );
  });
  return { container, controller, reload, timers };
}

const baseSnapshot = (installed: InstalledExtensionView[], extra: Partial<SettingsSnapshot> = {}): SettingsSnapshot => ({
  settings: [],
  plugins: installed.map((entry) => plugin(entry.id)),
  installedExtensions: installed,
  files: { config: "c", secrets: "s" },
  extensionInstallations: { revision: 1, jobs: [], restartSupported: true, allowUnsignedLocal: false },
  ...extra
});

describe("受管扩展设置面", () => {
  it("内置扩展卡片没有来源/卸载/回滚入口；受管卡片显示来源、信任、权限与回滚", async () => {
    const { container } = await render(baseSnapshot([builtin("film-set"), managedEntry("demo")]), remoteWith());
    expect(container.querySelector('[data-testid="managed-extension-film-set"]')).toBeNull();
    expect(container.querySelector('[data-testid="managed-uninstall-film-set"]')).toBeNull();
    expect(container.querySelector('[data-testid="settings-plugin-managed-film-set"]')).toBeNull();
    expect(container.querySelector('[data-testid="settings-plugin-managed-demo"]')?.textContent).toBe("已安装");
    expect(container.querySelector('[data-testid="managed-source-demo"]')?.textContent).toBe("本地文件");
    expect(container.querySelector('[data-testid="managed-trust-demo"]')?.textContent).toContain("woohaa-dev");
    expect(container.querySelector('[data-testid="managed-permissions-demo"]')?.textContent).toContain("api.example.com");
    expect(container.querySelector('[data-testid="managed-rollback-demo"]')?.textContent).toBe("回滚到 v1.0.0");
  });

  it("宿主未启用受管安装（无 extensionInstallations）：不显示「从文件安装」", async () => {
    const { container } = await render(baseSnapshot([builtin("film-set")], { extensionInstallations: undefined }), remoteWith());
    expect(container.querySelector('[data-testid="managed-install-file"]')).toBeNull();
  });

  it("安装请求失败：显示稳定错误码对应的中文原因，不产生任务", async () => {
    const remote = remoteWith({ installFile: vi.fn(async () => ({ ok: false as const, code: "MARKETPLACE_SIGNATURE_INVALID", error: "bad sig" })) });
    const { container, controller } = await render(baseSnapshot([]), remote);
    await act(async () => {
      await controller.installFile(new Blob(["x"]));
    });
    expect(container.querySelector('[data-testid="managed-install-error"]')?.textContent).toBe("签名无效或不受信任");
    expect(container.querySelector('[data-testid="managed-install-jobs"]')).toBeNull();
  });

  it("宿主同步失败（422 带任务）：直接显示任务失败原因，不轮询，重取设置", async () => {
    const remote = remoteWith({
      installFile: vi.fn(async () => ({
        ok: true as const,
        jobId: "job-1",
        job: job({ status: "failed", phase: "queued", failure: { code: "MARKETPLACE_UNAVAILABLE", message: "x" } })
      }))
    });
    const { container, controller, reload } = await render(baseSnapshot([]), remote);
    await act(async () => {
      await controller.installFile(new Blob(["x"]));
    });
    expect(container.querySelector('[data-testid="managed-job-detail-job-1"]')?.textContent).toBe("本机宿主未启用扩展安装");
    expect(remote.job).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("安装任务阶段进度 → 失败原因；终态后重取设置", async () => {
    const remote = remoteWith({
      job: vi.fn(async () => ({ ok: true as const, job: job({ status: "failed", phase: "preflight", failure: { code: "MARKETPLACE_FORBIDDEN_DECLARATION", message: "x" } }) }))
    });
    const { container, controller, reload, timers } = await render(baseSnapshot([]), remote);
    await act(async () => {
      await controller.installFile(new Blob(["x"]));
    });
    expect(container.querySelector('[data-testid="managed-job-detail-job-1"]')?.textContent).toBe("排队中");
    await act(async () => {
      await timers.flush();
    });
    expect(container.querySelector('[data-testid="managed-job-detail-job-1"]')?.textContent).toBe("扩展声明了受管扩展不允许的能力");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("需要重启：卡片与顶部提示；立即重启不支持时提示手动重启", async () => {
    const remote = remoteWith({ restart: vi.fn(async () => ({ ok: false as const, code: "MARKETPLACE_RESTART_UNSUPPORTED", error: "x" })) });
    const { container } = await render(baseSnapshot([managedEntry("demo", { restartRequired: true })]), remote);
    expect(container.querySelector('[data-testid="managed-restart-required-demo"]')).not.toBeNull();
    const button = container.querySelector('[data-testid="managed-restart-now"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
    });
    expect(container.querySelector('[data-testid="managed-restart"]')?.textContent).toContain("请手动重启");
    expect(container.querySelector('[data-testid="managed-restart-now"]')).toBeNull();
  });

  it("宿主不支持受控重启：直接提示手动重启，不渲染按钮", async () => {
    const snapshot = baseSnapshot([managedEntry("demo", { restartRequired: true })], {
      extensionInstallations: { revision: 1, jobs: [], restartSupported: false, allowUnsignedLocal: false }
    });
    const { container } = await render(snapshot, remoteWith());
    expect(container.querySelector('[data-testid="managed-restart"]')?.textContent).toContain("请手动重启");
    expect(container.querySelector('[data-testid="managed-restart-now"]')).toBeNull();
  });

  it("卸载需二次确认并带上是否清除数据；进行中禁用该卡片按钮", async () => {
    const remote = remoteWith({ job: vi.fn(async () => ({ ok: true as const, job: job({ jobId: "job-u", action: "uninstall", extensionId: "demo" }) })) });
    const { container } = await render(baseSnapshot([managedEntry("demo")]), remote);
    await act(async () => {
      (container.querySelector('[data-testid="managed-uninstall-demo"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="managed-uninstall-confirm-demo"]') as HTMLButtonElement).click();
    });
    expect(remote.uninstall).toHaveBeenCalledWith("demo", { purgeData: false });
    expect((container.querySelector('[data-testid="managed-rollback-demo"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("接管快照里进行中的任务继续轮询；读取失败不标失败", async () => {
    let calls = 0;
    const remote = remoteWith({
      job: vi.fn(async () => {
        calls += 1;
        return calls === 1 ? { ok: false as const, code: "unavailable", error: "x" } : { ok: true as const, job: job({ status: "succeeded", phase: "observe", outcome: "restart-required", extensionId: "demo" }) };
      })
    });
    const snapshot = baseSnapshot([], { extensionInstallations: { revision: 1, jobs: [job({ extensionId: "demo" })], restartSupported: true, allowUnsignedLocal: false } });
    const { container, controller, timers } = await render(snapshot, remote);
    act(() => controller.adoptSnapshot(snapshot));
    await act(async () => {
      await timers.flush();
    });
    expect(container.querySelector('[data-testid="managed-job-detail-job-1"]')?.textContent).toBe("校验签名");
    await act(async () => {
      await timers.flush();
    });
    expect(container.querySelector('[data-testid="managed-job-detail-job-1"]')?.textContent).toBe("已完成，重启本机服务后生效");
    expect(container.querySelector('[data-testid="managed-restart"]')).not.toBeNull();
  });
});

describe("重新打开画布（升级不热换）", () => {
  it("有待重开的扩展时显示按钮，点击走 reopenCanvas；没有重开入口时只提示", async () => {
    const reopenCanvas = vi.fn(async () => undefined);
    const { container } = await render(baseSnapshot([]), remoteWith(), manualTimers(), { pending: ["demo"], reopenCanvas });
    expect(container.querySelector('[data-testid="managed-release-pending"]')?.textContent).toContain("demo 已更新");
    await act(async () => {
      (container.querySelector('[data-testid="managed-release-reopen"]') as HTMLButtonElement).click();
    });
    expect(reopenCanvas).toHaveBeenCalledTimes(1);
    document.body.innerHTML = "";
    const bare = await render(baseSnapshot([]), remoteWith(), manualTimers(), { pending: ["demo"] });
    expect(bare.container.querySelector('[data-testid="managed-release-pending"]')).not.toBeNull();
    expect(bare.container.querySelector('[data-testid="managed-release-reopen"]')).toBeNull();
  });
});

describe("失败码与任务文案", () => {
  it("未知码回落宿主消息；预检失败带具体原因", () => {
    expect(failureReason("SOMETHING_NEW", "宿主说明")).toBe("宿主说明");
    expect(failureReason("MARKETPLACE_PREFLIGHT_FAILED", "缺 entry")).toBe("扩展声明未通过预检：缺 entry");
    expect(describeJob(job({ progress: 0.42, phase: "download" })).detail).toBe("读取安装包 42%");
  });
});

describe("受管扩展任务跟踪与失败码", () => {
  it("track：其他入口受理的任务进入同一任务列表并轮询", async () => {
    const remote = remoteWith();
    const { container, controller, timers } = await render(baseSnapshot([]), remote);
    act(() => controller.track("job-m", job({ jobId: "job-m", sourceId: "woohaa-server", extensionId: "demo", phase: "download" })));
    expect(container.querySelector('[data-testid="managed-job-detail-job-m"]')?.textContent).toBe("读取安装包");
    await act(async () => {
      await timers.flush();
    });
    expect(remote.job).toHaveBeenCalledWith("job-m");
  });
  it("新失败码：缺构建期描述提示重新打包", () => {
    expect(failureReason("MARKETPLACE_PACKAGE_INVALID")).toContain("重新打包");
  });
});
