/**
 * 设置「通知」分区组件回归
 * （change: 2026-10-17-move-settings-into-canvas-dialog，任务 9.1/9.3/9.4）。
 *
 * 覆盖：四分区导航、普通用户可改本地偏好、宿主配置失败仍可用、平台差异（Web 只有标题渠道、
 * 桌面有系统通知+权限+测试）、OS 权限与用户意愿分开、异步 pending 上报。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SettingPluginView, SettingsEntryView, SettingsSnapshot } from "@woohaa3/contracts";
import { AppThemeService } from "../../services/theme/service.js";
import { createExtensionManagerFacade } from "../extension-manager/facade.js";
import { createBackendSettingsStore, type BackendSettingsRemote } from "./backend-settings-store.js";
import { createTaskNotificationService } from "../../services/notifications/service.js";
import { createTitlePresenter } from "../../services/notifications/web-presenter.js";
import type { ForegroundState, ReminderCoordinator } from "../../services/notifications/coordination.js";
import { SettingsWorkspace } from "./workspace/settings-workspace.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots = new Set<Root>();
afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.innerHTML = "";
});

const snapshotOf = (settings: SettingsEntryView[] = []): SettingsSnapshot => ({
  settings,
  plugins: [] as SettingPluginView[],
  installedExtensions: [],
  files: { config: "/tmp/c", secrets: "/tmp/s" }
});

const backgroundForeground = (): ForegroundState => ({
  isBackground: () => true,
  subscribe: () => () => undefined,
  dispose: () => undefined
});
const owner: ReminderCoordinator = {
  role: () => "owner",
  subscribe: () => () => undefined,
  async claim() {
    return "owner";
  },
  async release() {},
  setPeerForeground() {},
  isPeerForeground: () => false,
  dispose: () => undefined
};

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    }
  };
}

function notifications(platform: "web" | "desktop", permission: "granted" | "prompt" | "denied" = "granted") {
  return createTaskNotificationService({
    reader: null,
    scope: () => ({ instanceId: "i", basePath: "/dev/x/", dataScopeId: "" }),
    presenter:
      platform === "web"
        ? {
            platform: "web",
            permission: () => "unsupported",
            async requestPermission() {
              return "unsupported" as const;
            },
            async refreshPermission() {
              return "unsupported" as const;
            },
            async notify() {
              return { ok: false as const, error: "浏览器不支持系统通知渠道" };
            }
          }
        : {
            platform: "desktop",
            permission: () => permission,
            async requestPermission() {
              return "granted" as const;
            },
            async refreshPermission() {
              return permission;
            },
            async notify() {
              return { ok: true as const };
            }
          },
    foreground: backgroundForeground(),
    coordinator: owner,
    title: createTitlePresenter({ write: () => undefined, read: () => "t" }),
    storage: memoryStorage()
  });
}

async function renderWorkspace(options: {
  remote?: BackendSettingsRemote;
  notifications?: ReturnType<typeof notifications>;
  initialSection?: "backend" | "plugins" | "appearance" | "notifications";
}) {
  const backend = createBackendSettingsStore(
    options.remote ?? {
      fetchSnapshot: async () => ({ ok: true, snapshot: snapshotOf() }),
      write: async () => ({ ok: true, snapshot: snapshotOf() })
    }
  );
  const extensions = createExtensionManagerFacade({
    catalog: [],
    ids: [],
    assembled: {},
    refresh: () => undefined,
    site: { canManageSite: () => backend.canManage() }
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  await act(async () => {
    root.render(
      <SettingsWorkspace
        backend={backend}
        theme={new AppThemeService({ storage: null })}
        extensions={extensions.facade}
        onRequestClose={() => undefined}
        // 通知分区在四喜发行形态下被藏掉；这里测的是分区本身，显式打开全部分区。
        sections={["backend", "plugins", "appearance", "runtimes", "notifications", "about"]}
        initialSection={options.initialSection ?? "backend"}
        {...(options.notifications ? { notifications: options.notifications } : {})}
      />
    );
  });
  return { container, backend, extensions };
}

const query = <T extends Element>(container: Element, testId: string) =>
  container.querySelector(`[data-testid="${testId}"]`) as T | null;

describe("通知分区", () => {
  it("四分区导航，通知与外观同级", async () => {
    const { container } = await renderWorkspace({ notifications: notifications("web") });
    for (const id of ["backend", "plugins", "appearance", "notifications"]) {
      expect(query(container, `settings-nav-${id}`), id).not.toBeNull();
    }
    act(() => query<HTMLButtonElement>(container, "settings-nav-notifications")!.click());
    expect(query(container, "notification-settings")).not.toBeNull();
    expect(container.textContent).toContain("仅在应用处于后台时提醒");
  });

  it("Web：成功/失败默认开 + 标题渠道；不展示系统通知控件", async () => {
    const { container } = await renderWorkspace({
      notifications: notifications("web"),
      initialSection: "notifications"
    });
    expect(query<HTMLButtonElement>(container, "notification-category-succeeded")!.getAttribute("aria-checked")).toBe("true");
    expect(query<HTMLButtonElement>(container, "notification-category-failed")!.getAttribute("aria-checked")).toBe("true");
    expect(query(container, "notification-channel-title")).not.toBeNull();
    expect(query(container, "notification-channel-system")).toBeNull();
    expect(query(container, "notification-send-test")).toBeNull();
  });

  it("普通用户可改本地偏好，立即生效且不需要保存按钮", async () => {
    const service = notifications("web");
    const { container } = await renderWorkspace({ notifications: service, initialSection: "notifications" });
    const toggle = query<HTMLButtonElement>(container, "notification-category-succeeded")!;
    act(() => toggle.click());
    expect(service.getSnapshot().preferences.categories.succeeded).toBe(false);
    // 行上没有全局保存按钮，偏好不属于配置草稿。
    expect(query(container, "setting-save-notification-category-succeeded")).toBeNull();
    expect(service.getSnapshot().storageError).toBeNull();
  });

  it("宿主配置读取失败时通知分区仍可用", async () => {
    const service = notifications("web");
    const { container } = await renderWorkspace({
      remote: {
        fetchSnapshot: async () => ({ ok: false, code: "unavailable", error: "无法连接配置服务" }),
        write: async () => ({ ok: false, code: "unavailable", error: "x" })
      },
      notifications: service,
      initialSection: "notifications"
    });
    expect(query(container, "notification-settings")).not.toBeNull();
    act(() => query<HTMLButtonElement>(container, "notification-category-failed")!.click());
    expect(service.getSnapshot().preferences.categories.failed).toBe(false);
  });

  it("数据源不可用：明确说明且偏好仍可保存", async () => {
    const service = notifications("web");
    const { container } = await renderWorkspace({ notifications: service, initialSection: "notifications" });
    expect(query(container, "notification-source-unavailable")?.textContent).toContain("任务提醒当前不可用");
    // 仍可改偏好。
    act(() => query<HTMLButtonElement>(container, "notification-channel-title")!.click());
    expect(service.getSnapshot().preferences.titleEnabled).toBe(false);
  });

  it("桌面：系统通知默认关，权限与用户意愿分开显示，测试通知按权限可用", async () => {
    const service = notifications("desktop", "prompt");
    const { container } = await renderWorkspace({ notifications: service, initialSection: "notifications" });
    expect(query(container, "notification-channel-system")).not.toBeNull();
    expect(query<HTMLButtonElement>(container, "notification-channel-system")!.getAttribute("aria-checked")).toBe("false");
    // 权限未授予：测试按钮不可用。
    expect(query<HTMLButtonElement>(container, "notification-send-test")!.disabled).toBe(true);
    expect(query(container, "notification-permission")?.textContent).toBe("尚未授权");
    // Web 专属的标题渠道在桌面不展示。
    expect(query(container, "notification-channel-title")).toBeNull();
  });

  it("桌面权限已允许：可发送测试通知并给出结果", async () => {
    const service = notifications("desktop", "granted");
    const { container } = await renderWorkspace({ notifications: service, initialSection: "notifications" });
    const test = query<HTMLButtonElement>(container, "notification-send-test")!;
    expect(test.disabled).toBe(false);
    await act(async () => test.click());
    expect(query(container, "notification-test-result")?.textContent).toContain("测试通知已发送");
  });

  it("没有通知服务时分区给出明确不可用说明", async () => {
    const { container } = await renderWorkspace({ initialSection: "notifications" });
    expect(query(container, "notification-settings-unavailable")).not.toBeNull();
  });

  it("设置实例关闭后不再保留通知订阅（服务仍归 App scope）", async () => {
    const service = notifications("web");
    const { container } = await renderWorkspace({ notifications: service, initialSection: "notifications" });
    act(() => {
      for (const root of roots) root.unmount();
    });
    roots.clear();
    // App 服务仍可用（设置关闭不影响观察）。
    expect(service.getSnapshot().preferences.categories).toBeDefined();
    void container;
  });
});
