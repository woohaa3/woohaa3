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
import { PluginConfigContent } from "./workspace/plugin-config-content.js";
import { PluginInstallPage } from "./workspace/plugin-install-page.js";
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
    const managed = {
      controller,
      pendingReopen: { get: () => pending, subscribe: () => () => undefined },
      ...(extras.reopenCanvas ? { reopenCanvas: extras.reopenCanvas } : {})
    };
    // 文件安装已从列表顶部移到「添加扩展」页：这里两个视图同时挂载，
    // 列表侧断言行与徽标，安装页侧断言任务、失败原因与重启提示。
    root.render(
      <>
        <PluginSettingsSection store={store} manager={facade()} managed={managed} />
        <PluginInstallPage
          mode="file"
          onSelectMode={() => undefined}
          managed={managed}
          snapshot={snapshot}
          canManage
          marketAvailable={false}
          fileAvailable={Boolean(snapshot.extensionInstallations)}
        />
      </>
    );
  });
  return { container, controller, reload, timers };
}

/** 详情页：受管扩展的卸载 / 回滚 / 身份说明只在这里出现（行里只留徽标）。 */
async function renderDetail(
  snapshot: SettingsSnapshot,
  remote: ExtensionInstallRemote,
  timers = manualTimers(),
  page: "overview" | "manage" = "manage"
) {
  const store = createBackendSettingsStore({ fetchSnapshot: async () => ({ ok: true, snapshot }), write: async () => ({ ok: false, code: "x", error: "x" }) });
  await store.load();
  const controller = createManagedExtensionsController({ remote, reload: async () => undefined, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.add(root);
  await act(async () => {
    root.render(
      <PluginConfigContent pluginId="demo" page={page} store={store} manager={facade()} managed={controller} onBack={() => undefined} />
    );
  });
  return { container, controller };
}

const baseSnapshot = (installed: InstalledExtensionView[], extra: Partial<SettingsSnapshot> = {}): SettingsSnapshot => ({
  settings: [],
  plugins: installed.map((entry) => plugin(entry.id)),
  installedExtensions: installed,
  files: { config: "c", secrets: "s" },
  extensionInstallations: { revision: 1, jobs: [], restartSupported: true },
  ...extra
});

describe("受管扩展设置面", () => {
  it("列表行只展示来源/信任徽标，不再挂卸载与明细", async () => {
    const { container } = await render(baseSnapshot([builtin("film-set"), managedEntry("demo")]), remoteWith());
    expect(container.querySelector('[data-testid="settings-plugin-source-film-set"]')).toBeNull();
    // 来源从「已安装」这种无信息量的徽标改成具体来源：内置也在行上标出来，便于按来源扫读。
    expect(container.querySelector('[data-testid="settings-plugin-source-demo"]')?.textContent).toBe("本地文件");
    expect(container.querySelector('[data-testid="settings-plugin-trust-demo"]')?.textContent).toBe("已验证");
    // 行里不再有受管明细：卸载/回滚/同权限说明都在详情页。
    expect(container.querySelector('[data-testid="managed-extension-demo"]')).toBeNull();
    expect(container.querySelector('[data-testid="managed-uninstall-demo"]')).toBeNull();
    expect(container.querySelector('[data-testid="managed-rollback-demo"]')).toBeNull();
  });

  it("「管理」页放卸载/回滚与身份说明；概览只留同权限提示", async () => {
    const manage = await renderDetail(baseSnapshot([managedEntry("demo")]), remoteWith());
    const actions = manage.container.querySelector('[data-testid="managed-actions-demo"]');
    expect(actions).not.toBeNull();
    // 卸载/回滚收在「管理」页的独立分区里，不再顶在详情头部。
    expect(actions?.closest(".settings-workbench__section")).not.toBeNull();
    expect(manage.container.querySelector('[data-testid="managed-rollback-demo"]')?.textContent).toBe("回滚到 v1.0.0");
    expect(manage.container.querySelector('[data-testid="managed-uninstall-demo"]')).not.toBeNull();
    // 没有需要提示的状态时，不再渲染受管明细块。
    expect(manage.container.querySelector('[data-testid="managed-extension-demo"]')).toBeNull();

    const overview = await renderDetail(baseSnapshot([managedEntry("demo")]), remoteWith(), manualTimers(), "overview");
    expect(overview.container.querySelector('[data-testid="managed-trust-note-demo"]')?.textContent).toContain("同权限");
    expect(overview.container.querySelector('[data-testid="managed-uninstall-demo"]')).toBeNull();
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
    expect(container.querySelector('[data-testid="managed-install-error"]')?.textContent).toBe("签名无效");
    expect(container.querySelector('[data-testid="managed-install-jobs"]')).toBeNull();
  });

  it("未验证的包先弹窗，确认后才带确认标记重试；取消则不重试", async () => {
    const failed = {
      ok: true as const,
      jobId: "job-1",
      job: job({ status: "failed", phase: "verify", failure: { code: "MARKETPLACE_UNSIGNED_REJECTED", message: "包没有签名" } })
    };
    const installFile = vi.fn()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce({ ...failed, jobId: "job-2", job: job({ jobId: "job-2", status: "failed", phase: "verify", failure: { code: "MARKETPLACE_UNSIGNED_REJECTED", message: "包没有签名" } }) })
      .mockResolvedValueOnce({
        ok: true as const,
        jobId: "job-3",
        job: job({ jobId: "job-3", status: "succeeded", phase: "observe", outcome: "installed", extensionId: "demo", version: "1.0.0" })
      });
    const remote = remoteWith({ installFile });
    const { container, controller } = await render(baseSnapshot([]), remote);
    const file = Object.assign(new Blob(["x"]), { name: "demo.wxt" });
    await act(async () => {
      await controller.installFile(file);
    });
    expect(container.querySelector('[data-testid="untrusted-install-dialog"]')?.textContent).toContain("没有签名");
    expect(container.querySelector('[data-testid="untrusted-install-dialog"]')?.textContent).toContain("没有隔离");
    await act(async () => {
      controller.dismissRisk();
    });
    expect(container.querySelector('[data-testid="untrusted-install-dialog"]')).toBeNull();
    expect(installFile).toHaveBeenCalledTimes(1);

    await act(async () => {
      await controller.installFile(file);
    });
    expect(container.querySelector('[data-testid="untrusted-install-dialog-confirm"]')).not.toBeNull();
    await act(async () => {
      await controller.confirmRisk();
    });
    expect(installFile).toHaveBeenLastCalledWith(file, { acceptUntrusted: true });
    expect(container.querySelector('[data-testid="untrusted-install-dialog"]')).toBeNull();
  });

  it("签名校验失败不弹安装确认", async () => {
    const remote = remoteWith({
      installFile: vi.fn(async () => ({
        ok: true as const,
        jobId: "job-1",
        job: job({ status: "failed", phase: "verify", failure: { code: "MARKETPLACE_SIGNATURE_INVALID", message: "签名校验失败" } })
      }))
    });
    const { container, controller } = await render(baseSnapshot([]), remote);
    await act(async () => {
      await controller.installFile(new Blob(["x"]));
    });
    expect(container.querySelector('[data-testid="untrusted-install-dialog"]')).toBeNull();
    expect(container.querySelector('[data-testid="managed-job-detail-job-1"]')?.textContent).toBe("签名无效");
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

  it("需要重启：详情页说明 + 列表顶部提示；立即重启不支持时提示手动重启", async () => {
    const remote = remoteWith({ restart: vi.fn(async () => ({ ok: false as const, code: "MARKETPLACE_RESTART_UNSUPPORTED", error: "x" })) });
    const snapshot = baseSnapshot([managedEntry("demo", { restartRequired: true })]);
    const detail = await renderDetail(snapshot, remote);
    expect(detail.container.querySelector('[data-testid="managed-restart-required-demo"]')).not.toBeNull();

    const { container } = await render(snapshot, remote);
    const button = container.querySelector('[data-testid="managed-restart-now"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
    });
    expect(container.querySelector('[data-testid="managed-restart"]')?.textContent).toContain("请手动重启");
    expect(container.querySelector('[data-testid="managed-restart-now"]')).toBeNull();
  });

  it("宿主不支持受控重启：直接提示手动重启，不渲染按钮", async () => {
    const snapshot = baseSnapshot([managedEntry("demo", { restartRequired: true })], {
      extensionInstallations: { revision: 1, jobs: [], restartSupported: false }
    });
    const { container } = await render(snapshot, remoteWith());
    expect(container.querySelector('[data-testid="managed-restart"]')?.textContent).toContain("请手动重启");
    expect(container.querySelector('[data-testid="managed-restart-now"]')).toBeNull();
  });

  it("详情页卸载需二次确认并带上是否清除数据；进行中禁用该按钮", async () => {
    const remote = remoteWith({ job: vi.fn(async () => ({ ok: true as const, job: job({ jobId: "job-u", action: "uninstall", extensionId: "demo" }) })) });
    const { container } = await renderDetail(baseSnapshot([managedEntry("demo")]), remote);
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
    const snapshot = baseSnapshot([], { extensionInstallations: { revision: 1, jobs: [job({ extensionId: "demo" })], restartSupported: true } });
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

  it("下载失败显示宿主给出的具体原因（断流 / 进度 / 重试次数都能看见）", () => {
    expect(failureReason("MARKETPLACE_DOWNLOAD_FAILED", "下载停滞：60 秒内没有收到新数据（已收到 47%）（已尝试 3 次）")).toBe(
      "读取安装包失败：下载停滞：60 秒内没有收到新数据（已收到 47%）（已尝试 3 次）"
    );
    // 来源不可用同理：只给固定标签时用户看不出是超时、限流还是仓库删了。
    expect(failureReason("MARKETPLACE_SOURCE_UNAVAILABLE", "访问 GitHub 超时（acme/extensions）")).toBe(
      "安装来源不可用：访问 GitHub 超时（acme/extensions）"
    );
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
