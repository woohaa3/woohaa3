/**
 * 「插件配置」分区：按插件树分层列出的可扫描行，点一行进入该插件的配置详情。
 *
 * 行只放身份、说明、配置规模与启停；配置项与它提供的生成模型在详情里改。清单以本次启动
 * 扫描到的已安装扩展为准，站点插件与 browser-local 行提供启停状态，见 `indexPlugins`。
 *
 * change: 2026-10-26-redesign-settings-plugin-page：列表从卡片网格改为分组行，并增加搜索 /
 * 筛选；市场与文件安装从顶部常驻面板改为「添加扩展」内联视图，不再在设置弹窗里叠第二层浮层。
 */
import { useState, useSyncExternalStore } from "react";
import { Button } from "@woohaa3/ui/primitives";
import { Switch } from "@woohaa3/ui/primitives";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon, SearchIcon } from "@woohaa3/ui/icons";
import type { ExtensionManagerFacade } from "../extension-manager/contract.js";
import type { BackendSettingsStore } from "./backend-settings-store.js";
import { PluginIconMark } from "./plugin-icons.js";
import {
  PLUGIN_LAYER_LABELS,
  configCountLabel,
  diagnosticsOf,
  indexPlugins,
  isActionable,
  isManageable,
  versionLabel,
  type PluginSettingsGroup,
  type PluginViewIndex
} from "./plugin-groups.js";
import {
  PLUGIN_BROWSER_FILTERS,
  filterPluginGroups,
  isStoppedStatus,
  pluginBrowserTotals,
  pluginRowStatus,
  pluginSourceOptions,
  sectionizePluginGroups,
  type PluginBrowserFilter
} from "./plugin-browser.js";
import { PluginFailureDetails, PluginStateControl } from "./plugin-state-control.js";
import { ExtensionFaultNotice } from "./extension-fault-notice.js";
import { ReleaseChangedNotice } from "./managed-extensions-ui.js";
import { extensionObservationBadge, extensionSource, extensionTrustBadge, signedKeyId } from "./extension-source.js";
import type { ManagedExtensionsController } from "./managed-extensions.js";
import {
  EMPTY_SETTINGS_PANELS,
  settingsPanelIds,
  type SettingsPanelSource
} from "./plugin-panels.js";
import "./settings.css";

const SECTION_HINTS: Record<string, string> = {
  扩展插件: "开关写宿主的扩展配置并立即生效：停用即卸下，启用即装回，无需重开页面。"
};


export type PluginSettingsSectionProps = {
  store: BackendSettingsStore;
  manager: ExtensionManagerFacade;
  /** 打开某个插件的配置详情（由 settings 插件注册的 dialog 提供）。 */
  onOpenPlugin?: (pluginId: string) => void;
  /** 进入「添加扩展」页（右下角悬浮 +）；缺省不显示该入口。 */
  onRequestInstall?: (mode: "market" | "file") => void;
  /** 扩展自带设置面板（`settings.plugin-config` slot）；有面板的插件行也可打开配置。 */
  settingsPanels?: SettingsPanelSource;
  /**
   * 受管扩展（change: 2026-10-21-add-extension-marketplace-point，7.2）：安装入口、任务进度与受管行操作；
   * `pendingReopen` 是当前页面仍在用旧版本、重开画布后生效的扩展。缺省不显示这些入口。
   */
  managed?: ManagedExtensionsSource;
};

export type ManagedExtensionsSource = {
  controller: ManagedExtensionsController;
  pendingReopen: { get(): readonly string[]; subscribe(listener: () => void): () => void };
  /** 重新打开画布以加载新版本（repin 新 release 后只重建 Canvas scope）；缺省只提示不给按钮。 */
  reopenCanvas?: () => Promise<void>;
  /** 「从市场安装」（change: 2026-10-21-add-server-extension-marketplace，7.5）；缺省不显示。 */
  marketplace?: import("./marketplace-install.js").MarketplaceInstallController;
};

const NO_PENDING: readonly string[] = [];

export function PluginSettingsSection({ store, manager, onOpenPlugin, onRequestInstall, settingsPanels, managed }: PluginSettingsSectionProps) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const pendingReopen = useSyncExternalStore(
    managed?.pendingReopen.subscribe ?? noopSubscribe,
    managed?.pendingReopen.get ?? emptyPending,
    managed?.pendingReopen.get ?? emptyPending
  );
  const view = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  const panels = settingsPanels ?? EMPTY_SETTINGS_PANELS;
  // 订阅 slot 版本：扩展前端按需加载、注册面板后行立即变为可打开。
  useSyncExternalStore(panels.subscribe, panels.version, panels.version);
  const panelIds = settingsPanelIds(panels);
  const [sectionToggled, setSectionToggled] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PluginBrowserFilter>("all");
  /** 来源筛选：`all` 或 `builtin`/某个 sourceId（见 extension-source.ts）。 */
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  const index = indexPlugins(state.status === "ready" ? state.snapshot : null, view);
  const canInstallFile = Boolean(
    state.status === "ready" && state.snapshot?.extensionInstallations && store.canManage()
  );
  const canUseMarket = Boolean(canInstallFile && managed?.marketplace);
  // 悬浮入口只在真的能装的时候出现；默认落到市场，没有市场时落到文件安装。
  const installMode = canUseMarket ? "market" : canInstallFile ? "file" : null;
  const normalizedQuery = query.trim().toLowerCase();
  const groups = filterPluginGroups(index, index.groups, { query: normalizedQuery, filter, sourceFilter, panelIds });
  // 只在真的有多个来源时出现来源筛选，避免单来源场景多一行噪声。
  const sourceOptions = pluginSourceOptions(index.groups);
  const totals = pluginBrowserTotals(index, panelIds);
  const sections = sectionizePluginGroups(groups).map((section) => ({
    ...section,
    // 受管扩展行带卸载/回滚操作，所在分区不算「纯信息」，不默认收起。
    informational: section.groups.every(
      (group) => !isActionable(index, group) && !panelIds.has(group.id) && !(managed && group.installed?.managed)
    )
  }));
  const configCount = index.groups.reduce((total, group) => total + group.entries.length, 0);

  return (
    <div className="settings-plugin-page" data-testid="plugin-settings">
      <header className="settings-plugin-head">
        <div className="settings-plugin-head__title">
          <h2>插件配置</h2>
          <p className="settings-plugin-head__meta" data-testid="plugins-settings-summary">
            {totals.all} 个插件 · {totals.running} 个运行中
            {totals.disabled > 0 ? ` · ${totals.disabled} 个已停用` : ""} · {configCount} 项配置
          </p>
        </div>
        <label className="settings-plugin-search">
          <SearchIcon size={15} />
          <input
            type="search"
            value={query}
            placeholder="搜索插件、能力或配置…"
            onChange={(event) => setQuery(event.currentTarget.value)}
            data-testid="plugins-settings-search"
          />
        </label>
      </header>

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

          <ReleaseChangedNotice
            pending={pendingReopen}
            {...(managed?.reopenCanvas ? { onReopen: () => void managed.reopenCanvas?.() } : {})}
          />
          {view.siteError ? (
            <p className="settings-page__error" role="alert" data-testid="plugins-settings-site-error">{view.siteError}</p>
          ) : null}

          <div className="settings-plugin-toolbar">
            <div className="settings-plugin-filter-groups">
            <div className="settings-plugin-filters" aria-label="插件筛选">
              {PLUGIN_BROWSER_FILTERS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={filter === entry.id ? "settings-plugin-filter is-active" : "settings-plugin-filter"}
                  onClick={() => setFilter(entry.id)}
                  data-testid={`plugins-filter-${entry.id}`}
                >
                  {entry.label}
                  <span>{totals[entry.id]}</span>
                </button>
              ))}
            </div>
            {sourceOptions.length > 0 ? (
              <div className="settings-plugin-filters" aria-label="按来源筛选" data-testid="plugins-source-filters">
                <button
                  type="button"
                  className={sourceFilter === "all" ? "settings-plugin-filter is-active" : "settings-plugin-filter"}
                  onClick={() => setSourceFilter("all")}
                  data-testid="plugins-source-all"
                >
                  全部来源
                </button>
                {sourceOptions.map((source) => (
                  <button
                    key={source.id}
                    type="button"
                    className={sourceFilter === source.id ? "settings-plugin-filter is-active" : "settings-plugin-filter"}
                    onClick={() => setSourceFilter(source.id)}
                    data-testid={`plugins-source-${source.id}`}
                  >
                    {source.label}
                  </button>
                ))}
              </div>
            ) : null}
            </div>
            <span className="settings-plugin-result">{groups.length} / {totals.all}</span>
          </div>

          {index.groups.length === 0 ? (
            <p className="settings-page__hint" data-testid="plugins-settings-empty">没有可显示的插件。</p>
          ) : null}

          {groups.length === 0 && index.groups.length > 0 ? (
            <p className="settings-page__hint" data-testid="plugins-settings-empty-filter">
              没有匹配的插件；换个关键词或清空筛选。
            </p>
          ) : null}

          {sections.map((section) => {
            const collapsed = normalizedQuery || filter !== "all"
              ? false
              : sectionToggled[section.title] ?? section.informational;
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
                  <span className="settings-plugins__rule" />
                </div>
                {SECTION_HINTS[section.title] && !collapsed ? (
                  <p className="settings-page__hint settings-plugins__section-hint">{SECTION_HINTS[section.title]}</p>
                ) : null}
                {collapsed ? null : (
                  <div className="settings-plugins__list">
                    {section.groups.map((group) => (
                      <PluginRow
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


          {!store.canManage() ? (
            <p className="settings-page__hint" data-testid="plugins-settings-readonly">仅管理员可修改插件启停与配置。</p>
          ) : null}

      {/* 安装不再占一排按钮：右下角悬浮 + 进入「添加扩展」页（同一层级位移）。 */}
      {installMode && onRequestInstall ? (
        <button
          type="button"
          className="settings-plugin-fab"
          onClick={() => onRequestInstall(installMode)}
          title="添加扩展"
          aria-label="添加扩展"
          data-testid="plugin-install-open"
        >
          <PlusIcon size={19} />
        </button>
      ) : null}
    </div>
  );
}

/** 一张插件行：身份 + 说明 + 配置规模 + 状态；右侧是启停开关。 */
function PluginRow({
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
  hasSettingsPanel: boolean;
  onOpen?: () => void;
}) {
  // 详情页总有内容（概览 / 启停 / 安装信息），所以每一行都能点进去；配置规模只是行上的提示。
  const openable = onOpen !== undefined;
  const layer = PLUGIN_LAYER_LABELS[group.layer];
  const diagnostics = diagnosticsOf(index, group);
  const manageable = isManageable(index, group);
  const status = pluginRowStatus(index, group);

  return (
    <article
      className={openable ? "plugin-row is-openable" : "plugin-row"}
      data-plugin-id={group.id}
      data-plugin-layer={group.layer}
      data-testid={`settings-plugin-${group.id}`}
      {...(group.providerId ? { "data-provider-id": group.providerId } : {})}
    >
      <button
        type="button"
        className="plugin-row__open"
        disabled={!openable}
        onClick={onOpen}
        data-testid={`settings-plugin-open-${group.id}`}
      >
        <PluginIconMark icon={group.icon} testId={`settings-plugin-icon-${group.id}`} />
        <span className="plugin-row__main">
          <span className="plugin-row__title">
            <span className="plugin-row__name">{group.label}</span>
            <span className="plugin-card__badge">{layer.badge}</span>
            {group.provider ? <span className="plugin-card__badge is-provider">Provider</span> : null}
            {group.installed?.managed ? (
              <span
                className="plugin-card__badge is-source"
                data-tone={extensionSource(group.installed).tone}
                data-testid={`settings-plugin-source-${group.id}`}
                title={group.installed.sourceId ? `安装来源：${group.installed.sourceId}` : undefined}
              >
                {extensionSource(group.installed).label}
              </span>
            ) : null}
            {extensionTrustBadge(group.installed) ? (
              <span
                className="plugin-card__badge is-trust"
                data-tone={extensionTrustBadge(group.installed)!.tone}
                data-testid={`settings-plugin-trust-${group.id}`}
                title={extensionTrustBadge(group.installed)?.tone === "verified"
                  ? `已验证${signedKeyId(group.installed?.trust) ? ` · ${signedKeyId(group.installed?.trust)}` : ""}（与本机宿主同权限，不是沙箱）`
                  : "未验证：签名不在本机信任根中，与宿主同权限"}
              >
                {extensionTrustBadge(group.installed)!.label}
              </span>
            ) : null}
            {extensionObservationBadge(group.installed) ? (
              <span
                className="plugin-card__badge is-observe"
                data-testid={`settings-plugin-observe-${group.id}`}
                title={extensionObservationBadge(group.installed)!.title}
              >
                {extensionObservationBadge(group.installed)!.label}
              </span>
            ) : null}
          </span>
          <span className="plugin-row__description">{group.description || "暂无说明"}</span>
          <span className="plugin-row__meta">{configCountLabel(index, group, hasSettingsPanel) || "—"}</span>
        </span>
      </button>
      <div className="plugin-row__side">
        <span
          className="plugin-row__status"
          data-tone={status.tone}
          {...(diagnostics.length > 0 ? { title: diagnostics.join("；") } : {})}
        >
          <i />{status.label}
        </span>
        {group.version ? (
          <span className="plugin-row__version" title={`扩展版本 ${versionLabel(group.version)}`} data-testid={`settings-plugin-version-${group.id}`}>
            {versionLabel(group.version)}
          </span>
        ) : null}
        <div className="plugin-row__switch">
          {manageable ? (
            <PluginStateControl
              index={index}
              group={group}
              manager={manager}
              store={store}
              siteManageable={siteManageable}
              testId={`settings-plugin-switch-${group.id}`}
            />
          ) : (
            <Switch
              checked={!isStoppedStatus(status.label, status.tone)}
              disabled
              onCheckedChange={() => undefined}
              aria-label={`${group.label} 的启停由宿主管理，不能单独停用`}
              title="内置扩展由宿主管理，不能单独停用"
              testId={`settings-plugin-switch-${group.id}`}
            />
          )}
        </div>
        {openable ? <span className="plugin-row__chevron"><ChevronRightIcon size={15} /></span> : null}
      </div>
      <PluginFailureDetails index={index} group={group} />
      {group.directory ? (
        <p className="plugin-directory plugin-row__directory" title={group.directory}>
          <span>所在目录</span><code>{group.directory}</code>
        </p>
      ) : null}
      <ExtensionFaultNotice extensionId={group.id} />
      {/* 受管明细（来源身份、同权限说明、卸载/回滚）在详情页；行里只留来源/信任徽标。 */}
    </article>
  );
}

const noopSubscribe = () => () => undefined;
const emptyPending = () => NO_PENDING;

