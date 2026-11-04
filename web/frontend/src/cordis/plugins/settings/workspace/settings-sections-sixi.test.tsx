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
import { createBackendSettingsStore, type BackendSettingsRemote } from "../backend-settings-store.js";
import { SettingsWorkspace } from "./settings-workspace.js";
import {
  SIXI_SETTINGS_DEFAULT_SECTION,
  SIXI_SETTINGS_SECTIONS,
  isSixiSettingsSectionVisible
} from "./settings-sections-sixi.js";

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

const remote: BackendSettingsRemote = {
  fetchSnapshot: async () => ({ ok: true, snapshot: SNAPSHOT }),
  write: async () => ({ ok: true, snapshot: SNAPSHOT })
};

async function renderDefault(initialSection?: "backend" | "plugins" | "appearance" | "notifications" | "runtimes" | "about") {
  const backend = createBackendSettingsStore(remote);
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

describe("四喜发行形态的设置分区", () => {
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
