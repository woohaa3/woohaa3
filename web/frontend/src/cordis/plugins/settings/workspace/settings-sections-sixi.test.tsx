/**
 * 四喜发行形态的设置分区：左栏只留「插件配置 + 外观」，被藏掉的分区请求落回默认。
 *
 * 这份测试不带 `sections` 属性，走的是**缺省值**——也就是用户真正会看到的那一份。
 * 上游 `settings-workspace.test.tsx` 显式打开全部分区去测工作区自身的行为，两边互不干扰。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SettingsSnapshot } from "@woohaa3/contracts";
import { AppThemeService } from "../../../services/theme/service.js";
import { createExtensionManagerFacade } from "../../extension-manager/facade.js";
import { createBackendSettingsStore } from "../backend-settings-store.js";
import { indexPlugins } from "../plugin-groups.js";
import type { ExtensionManagerView } from "../../extension-manager/contract.js";
import { SettingsWorkspace } from "./settings-workspace.js";
import {
  SIXI_SETTINGS_DEFAULT_SECTION,
  SIXI_SETTINGS_SECTIONS,
  isSixiSettingsSectionVisible
} from "./settings-sections-sixi.js";
import {
  SIXI_HIDDEN_SETTINGS_PLUGINS,
  isSixiHiddenSettingsPlugin
} from "./settings-plugins-sixi.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.clear();
  document.body.innerHTML = "";
});

const SNAPSHOT = {
  settings: [],
  plugins: [],
  unknownKeys: [],
  extensionPoints: { storage: [], exposer: [] }
} as unknown as SettingsSnapshot;

/**
 * 带 ppserver-provider 的快照：它在发行版里必须被装配（生图链路要靠它），
 * 但设置列表不该出现这一行。
 */
const SNAPSHOT_WITH_PPSERVER = {
  ...SNAPSHOT,
  installedExtensions: [
    {
      id: "ppserver-provider",
      label: "ppserver",
      description: "ppserver 任务路由器。",
      directory: "/extensions/ppserver-provider",
      version: "1.0.0",
      writable: false
    },
    {
      id: "prompt-skills",
      label: "提示词快捷改写",
      description: "执行面板的快捷改写。",
      directory: "/extensions/prompt-skills",
      version: "0.1.0",
      writable: false
    }
  ],
  plugins: [
    { id: "ppserver-provider", label: "ppserver", description: "", layer: "extension", settingCount: 6, siteManaged: false, provider: true },
    { id: "prompt-skills", label: "提示词快捷改写", description: "", layer: "extension", settingCount: 0, siteManaged: false, provider: false }
  ]
} as unknown as SettingsSnapshot;

async function renderDefault(
  initialSection?: "backend" | "plugins" | "appearance" | "notifications" | "runtimes" | "about",
  snapshot: SettingsSnapshot = SNAPSHOT
) {
  const backend = createBackendSettingsStore({
    fetchSnapshot: async () => ({ ok: true, snapshot }),
    write: async () => ({ ok: true, snapshot })
  });
  // 快照是异步读的（`SettingsWorkspace` 挂载后自己 `load()`），断言前必须先等它落地，
  // 否则看到的是空列表，测出来的「没有 ppserver」是假的。
  await backend.load();
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
        {...(initialSection ? { initialSection } : {})}
      />
    );
  });
  return container;
}

const navIds = (container: Element) =>
  [...container.querySelectorAll<HTMLElement>('[data-testid^="settings-nav-"]')].map((node) =>
    node.getAttribute("data-testid")!.replace("settings-nav-", "")
  );

/** 没有站点/浏览器行的插件管理快照：这里只关心「已安装清单 → 插件行」这一步。 */
const emptyManagerView = (): ExtensionManagerView =>
  ({
    rows: [],
    siteRows: [],
    modelRows: [],
    siteManageable: false,
    siteError: null,
    pending: false,
    persistenceMessage: null,
    error: null
  }) as ExtensionManagerView;

describe("四喜发行形态的设置分区", () => {
  it("隐藏清单覆盖 ppserver、两个存储后端与四喜本体", () => {
    expect([...SIXI_HIDDEN_SETTINGS_PLUGINS]).toEqual([
      "ppserver-provider",
      "sqlite-storage",
      "local-storage",
      "sixi-spike"
    ]);
    for (const hidden of SIXI_HIDDEN_SETTINGS_PLUGINS) {
      expect(isSixiHiddenSettingsPlugin(hidden), hidden).toBe(true);
    }
    expect(isSixiHiddenSettingsPlugin("prompt-skills")).toBe(false);
  });

  it("隐藏的插件都不出现在投影结果里，其余插件照常保留", () => {
    // 直接测投影函数：列表页的分组在「非可操作」分区里默认收起，行不会渲染，
    // 用 DOM 断言只能证明「收起后看不见」，证明不了过滤本身。
    const index = indexPlugins(SNAPSHOT_WITH_PPSERVER, emptyManagerView(), SIXI_HIDDEN_SETTINGS_PLUGINS);
    const ids = index.groups.map((group) => group.id);
    for (const hidden of SIXI_HIDDEN_SETTINGS_PLUGINS) {
      expect(ids, hidden).not.toContain(hidden);
    }
    // 过滤只针对清单内的 id，不是「有一条就全空」。
    expect(ids).toContain("prompt-skills");
  });

  it("ppserver 那一行在插件配置页面上也读不到", async () => {
    const container = await renderDefault("plugins", SNAPSHOT_WITH_PPSERVER);
    expect(container.querySelector('[data-testid="settings-plugin-ppserver-provider"]')).toBeNull();
    expect(container.textContent).not.toContain("ppserver");
  });

  it("分区清单只含插件配置与外观，默认落在插件配置", () => {
    expect([...SIXI_SETTINGS_SECTIONS]).toEqual(["plugins", "appearance"]);
    expect(SIXI_SETTINGS_DEFAULT_SECTION).toBe("plugins");
    expect(isSixiSettingsSectionVisible("plugins")).toBe(true);
    for (const hidden of ["backend", "runtimes", "notifications", "about"]) {
      expect(isSixiSettingsSectionVisible(hidden), hidden).toBe(false);
    }
  });

  it("缺省渲染：左栏只有两个分区，核心服务 / 运行时组件 / 通知 / 关于都不出现", async () => {
    const container = await renderDefault();
    expect(navIds(container)).toEqual(["plugins", "appearance"]);
    for (const hidden of ["backend", "runtimes", "notifications", "about"]) {
      expect(container.querySelector(`[data-testid="settings-nav-${hidden}"]`), hidden).toBeNull();
    }
  });

  it("请求打开已被藏掉的分区时落到默认分区，不留下左栏无选中项的孤儿视图", async () => {
    for (const hidden of ["backend", "runtimes", "notifications", "about"] as const) {
      const container = await renderDefault(hidden);
      const active = container.querySelector(".settings-workbench__nav-item.is-active");
      expect(active?.getAttribute("data-testid"), hidden).toBe("settings-nav-plugins");
    }
  });

  it("请求仍可见的分区时照常打开", async () => {
    const container = await renderDefault("appearance");
    const active = container.querySelector(".settings-workbench__nav-item.is-active");
    expect(active?.getAttribute("data-testid")).toBe("settings-nav-appearance");
  });
});
