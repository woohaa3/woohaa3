/**
 * 「插件配置」分区：一棵插件树的卡片网格，点卡片进入该插件的配置弹窗。
 *
 * 卡片只放基本信息：插件名、版本、分层 / Provider 标记、一句话说明、配置规模，以及启停开关；配置项与
 * 它提供的生成模型在弹窗里改（见 [plugin-config-dialog](plugin-config-dialog.tsx)），卡片不承载表单。
 * 清单以本次启动扫描到的已安装扩展为准，站点插件与 browser-local 行提供启停状态，见 `indexPlugins`。
 */
import { useState, useSyncExternalStore } from "react";
import { Button } from "../../../shared/ui/Button.js";
import { ChevronDownIcon, ChevronRightIcon } from "../../../shared/ui/icons.js";
import type { ExtensionManagerFacade } from "../extension-manager/contract.js";
import type { BackendSettingsStore } from "./backend-settings-store.js";
import { PluginIconMark } from "./plugin-icons.js";
import {
  PLUGIN_LAYER_LABELS,
  configCountLabel,
  diagnosticsOf,
  indexPlugins,
  isActionable,
  isConfigurable,
  isManageable,
  pluginStateKind,
  versionLabel,
  type PluginSettingsGroup,
  type PluginViewIndex
} from "./plugin-groups.js";
import { PluginStateControl } from "./plugin-state-control.js";
import {
  EMPTY_SETTINGS_PANELS,
  settingsPanelIds,
  type SettingsPanelSource
} from "./plugin-panels.js";
import "./settings.css";

const SECTION_HINTS: Record<string, string> = {
  扩展插件: "站点插件的开关对整个实例生效并立即应用；浏览器本地插件在下一次打开时生效。"
};

/** 浏览器本地插件：偏好与本次装配不一致时提示「下次打开生效」。 */
function browserPending(index: PluginViewIndex, group: PluginSettingsGroup): boolean {
  const row = index.browserRows.get(group.id);
  return row !== undefined && row.status.startsWith("pending");
}

export type PluginSettingsSectionProps = {
  store: BackendSettingsStore;
  manager: ExtensionManagerFacade;
  /** 打开某个插件的配置弹窗（由 settings 插件注册的 dialog 提供）。 */
  onOpenPlugin?: (pluginId: string) => void;
  /** 扩展自带设置面板（`settings.plugin-config` slot）；有面板的插件卡片也可打开配置弹窗。 */
  settingsPanels?: SettingsPanelSource;
};

export function PluginSettingsSection({ store, manager, onOpenPlugin, settingsPanels }: PluginSettingsSectionProps) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const view = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  const panels = settingsPanels ?? EMPTY_SETTINGS_PANELS;
  // 订阅 slot 版本：扩展前端按需加载、注册面板后卡片立即变为可打开。
  useSyncExternalStore(panels.subscribe, panels.version, panels.version);
  const panelIds = settingsPanelIds(panels);
  /** 用户手动开关过的整节；没有记录时整节都没有可操作内容的（内置插件现在如此）默认收起。 */
  const [sectionToggled, setSectionToggled] = useState<Record<string, boolean>>({});

  const index = indexPlugins(state.status === "ready" ? state.snapshot : null, view);
  const sections = sectionize(index.groups).map((section) => ({
    ...section,
    informational: section.groups.every((group) => !isActionable(index, group) && !panelIds.has(group.id))
  }));

  return (
    <div data-testid="plugin-settings">
      {state.status === "loading" ? <p className="settings-page__hint" role="status">正在读取插件配置…</p> : null}
      {state.status === "unauthorized" ? (
        <p className="settings-page__hint" data-testid="plugins-settings-unauthorized">
          需要管理员权限才能查看和修改插件配置。
        </p>
      ) : null}
      {state.status === "error" ? (
        <div className="settings-page__hint">
          <p className="settings-page__error" role="alert">{state.error}</p>
          <Button size="sm" onClick={() => void store.load()}>重试</Button>
        </div>
      ) : null}
      {view.siteError ? (
        <p className="settings-page__error" role="alert" data-testid="plugins-settings-site-error">{view.siteError}</p>
      ) : null}

      {index.groups.length > 0 ? (
        <p className="settings-plugins__summary" data-testid="plugins-settings-summary">
          {index.groups.length} 个插件 · {index.groups.reduce((total, group) => total + group.entries.length, 0)} 项配置
        </p>
      ) : (
        <p className="settings-page__hint" data-testid="plugins-settings-empty">没有可显示的插件。</p>
      )}

      {sections.map((section) => {
        const collapsed = sectionToggled[section.title] ?? section.informational;
        return (
          <section
            key={section.title}
            className="settings-plugins__section"
            data-plugin-section={section.title}
            data-section-collapsed={section.informational && collapsed ? "true" : "false"}
          >
            <div className="settings-plugins__head">
              {section.informational ? (
                <button
                  type="button"
                  className="settings-plugins__toggle"
                  aria-expanded={!collapsed}
                  onClick={() => setSectionToggled((current) => ({ ...current, [section.title]: !collapsed }))}
                  data-testid={`plugins-section-toggle-${section.title}`}
                >
                  {collapsed ? <ChevronRightIcon size={16} /> : <ChevronDownIcon size={16} />}
                  <span className="settings-plugins__heading">{section.title}</span>
                  <span className="settings-plugins__count">{section.groups.length}</span>
                </button>
              ) : (
                <>
                  <h3 className="settings-plugins__heading">{section.title}</h3>
                  <span className="settings-plugins__count">{section.groups.length}</span>
                </>
              )}
            </div>
            <p className="settings-page__hint">{SECTION_HINTS[section.title] ?? ""}</p>
            {collapsed ? null : (
              <div className="settings-plugins__grid">
                {section.groups.map((group) => (
                  <PluginCard
                    key={group.id}
                    index={index}
                    group={group}
                    manager={manager}
                    store={store}
                    siteManageable={view.siteManageable}
                    hasSettingsPanel={panelIds.has(group.id)}
                    {...(onOpenPlugin ? { onOpen: () => onOpenPlugin(group.id) } : {})}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}

      {index.groups.some((group) => pluginStateKind(index, group) === "browser" && browserPending(index, group)) ? (
        <p className="settings-page__pending" data-testid="settings-plugins-pending">
          有浏览器本地插件改动，下次打开应用生效。
        </p>
      ) : null}
      {!store.canManage() ? (
        <p className="settings-page__hint" data-testid="plugins-settings-readonly">仅管理员可修改插件启停与配置。</p>
      ) : null}
    </div>
  );
}

/** 一张插件卡片：基本信息 + 启停；有配置项或模型时整块可点开配置弹窗。 */
function PluginCard({
  index,
  group,
  manager,
  store,
  siteManageable,
  hasSettingsPanel,
  onOpen
}: {
  index: PluginViewIndex;
  group: PluginSettingsGroup;
  manager: ExtensionManagerFacade;
  store: BackendSettingsStore;
  siteManageable: boolean;
  /** 该插件有扩展自带设置面板（`settings.plugin-config`）。 */
  hasSettingsPanel: boolean;
  onOpen?: () => void;
}) {
  const openable = (isConfigurable(index, group) || hasSettingsPanel) && onOpen !== undefined;
  const layer = PLUGIN_LAYER_LABELS[group.layer];
  const diagnostics = diagnosticsOf(index, group);
  const manageable = isManageable(index, group);

  return (
    <article
      className={openable ? "plugin-card is-openable" : "plugin-card"}
      data-plugin-id={group.id}
      data-plugin-layer={group.layer}
      data-testid={`settings-plugin-${group.id}`}
      {...(group.providerId ? { "data-provider-id": group.providerId } : {})}
    >
      <button
        type="button"
        className="plugin-card__open"
        disabled={!openable}
        onClick={onOpen}
        data-testid={`settings-plugin-open-${group.id}`}
      >
        <span className="plugin-card__head">
          <PluginIconMark icon={group.icon} testId={`settings-plugin-icon-${group.id}`} />
          <span className="plugin-card__name">{group.label}</span>
          <span className="plugin-card__badge">{layer.badge}</span>
          {group.provider ? <span className="plugin-card__badge is-provider">Provider</span> : null}
          {group.version ? (
            <span className="plugin-card__version" title={`扩展版本 ${versionLabel(group.version)}`} data-testid={`settings-plugin-version-${group.id}`}>
              {versionLabel(group.version)}
            </span>
          ) : null}
        </span>
        {group.description ? <span className="plugin-card__description">{group.description}</span> : null}
        <span className="plugin-card__meta">
          {configCountLabel(index, group, hasSettingsPanel)}
          {openable ? <ChevronRightIcon size={14} /> : null}
        </span>
      </button>
      {group.directory ? (
        <p className="plugin-directory" title={group.directory}>
          <span>所在目录</span><code>{group.directory}</code>
        </p>
      ) : null}
      {diagnostics.length > 0 ? (
        <p className="plugin-card__diagnostics" role="status">{diagnostics.join("；")}</p>
      ) : null}
      {manageable ? (
        <div className="plugin-card__foot">
          <PluginStateControl
            index={index}
            group={group}
            manager={manager}
            store={store}
            siteManageable={siteManageable}
            testId={`settings-plugin-switch-${group.id}`}
          />
        </div>
      ) : null}
    </article>
  );
}

/** 按分层标题归组，保持插件树顺序；base 与 core 合成「内置插件」一节。 */
function sectionize(groups: readonly PluginSettingsGroup[]): Array<{ title: string; groups: PluginSettingsGroup[] }> {
  const order: string[] = [];
  const byTitle = new Map<string, PluginSettingsGroup[]>();
  for (const group of groups) {
    const title = PLUGIN_LAYER_LABELS[group.layer].section;
    if (!byTitle.has(title)) {
      byTitle.set(title, []);
      order.push(title);
    }
    byTitle.get(title)!.push(group);
  }
  return order.map((title) => ({ title, groups: byTitle.get(title)! }));
}
