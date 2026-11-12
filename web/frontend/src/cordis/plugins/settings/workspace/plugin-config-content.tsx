/**
 * 插件详情内容（设置弹窗右栏的二级 / 三级视图）。
 *
 * 层级导航（画布设置-扩展层级导航，2026-10-28）：
 * - L2 概览：身份、启停、说明、配置规模与「进入配置 / 模型 / 管理」的入口；
 * - L3 子页：配置（扩展面板 + 声明式配置项）、模型（模型目录与站点级启停）、管理（来源、签名、卸载/回滚）。
 *   子页之间只换右栏；返回列表由左栏的返回项承担，本组件不再自带「返回插件列表」按钮。
 *
 * 内容仍是同一份权威数据（配置项、模型策略、安全诊断与扩展面板），不持有第二份状态。
 */
import { Component, useEffect, useMemo, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import type { ExtensionManagerFacade } from "../../extension-manager/contract.js";
import { Button } from "@woohaa3/ui/primitives";
import { Switch } from "@woohaa3/ui/primitives";
import { CopyIcon } from "@woohaa3/ui/icons";
import { appPublicUrl } from "../../../services/app-base-path.js";
import type { BackendSettingsStore } from "../backend-settings-store.js";
import {
  PLUGIN_LAYER_LABELS,
  diagnosticsOf,
  inactiveStateOf,
  indexPlugins,
  isManageable,
  isSiteRowRunning,
  modelsOf,
  versionLabel,
  type PluginSettingsGroup
} from "../plugin-groups.js";
import { PluginFailureDetails, PluginStateControl } from "../plugin-state-control.js";
import { PluginIconMark } from "../plugin-icons.js";
import { SettingRow } from "../setting-row.js";
import { ArkEndpointSection, isArkEndpointEntry } from "../ark-endpoints.js";
import {
  EMPTY_SETTINGS_PANELS,
  settingsPanelIds,
  settingsPanelsOf,
  type SettingsPanelSource
} from "../plugin-panels.js";
import type { SettingsEditSession } from "../edit-session.js";
import type { ExtensionSettingsAssembly } from "../plugin.js";
import { useSettingsEditReport } from "./use-settings-edit-report.js";
import type { SettingsPanelRenderProps } from "../plugin-panels.js";
import { extensionObservationBadge, extensionSource, extensionTrustBadge } from "../extension-source.js";
import { ManagedExtensionActions, ManagedExtensionDetails } from "../managed-extensions-ui.js";
import type { ManagedExtensionsController } from "../managed-extensions.js";
import { GeneratedModelsSection } from "./model-catalog.js";
import { useExtensionFaults } from "../../../host.js";
import { slotContributionOrigin } from "../../../slots.js";
import {
  pluginPages,
  pluginSubPages,
  resolvePluginPage,
  type PluginPageDescriptor,
  type PluginPageId
} from "../plugin-pages.js";
import { PluginPageEntry } from "./rail-navigation.js";
import "../settings.css";

export type PluginConfigContentProps = {
  pluginId: string;
  /** 当前子页；缺省概览。目标子页不存在时回落到概览。 */
  page?: PluginPageId;
  store: BackendSettingsStore;
  manager: ExtensionManagerFacade;
  /** 扩展自带设置面板（`settings.plugin-config`）；缺省无面板。 */
  settingsPanels?: SettingsPanelSource;
  /** 「返回插件列表」（作为内部导航，遵守草稿门禁；不关闭设置）。面板的 requestClose 也复用它。 */
  onBack: () => void;
  /** 进入某个子页（L3）；缺省时概览只展示规模，不显示入口行。 */
  onSelectPage?: (page: PluginPageId) => void;
  /** 设置编辑会话：插件详情的扩展面板把 dirty/pending 汇总进同一门禁。 */
  editSession?: SettingsEditSession;
  /** 设置专项扩展装配：打开未激活扩展详情时按需加载其设置贡献。 */
  extensionSettings?: ExtensionSettingsAssembly;
};

/** 单个插件的详情内容；插件不存在或清单未读到给提示，不打开其它插件。 */
export function PluginConfigContent({
  pluginId,
  page = "overview",
  store,
  manager,
  managed,
  settingsPanels,
  onBack,
  onSelectPage,
  editSession,
  extensionSettings
}: PluginConfigContentProps & { /** 受管扩展的卸载/回滚/身份说明只在「管理」页出现。 */ managed?: ManagedExtensionsController }) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const view = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  const panels = settingsPanels ?? EMPTY_SETTINGS_PANELS;
  // slot 全局版本变化即重算该插件的面板；扩展前端按需加载后也能立即出现。
  const panelsVersion = useSyncExternalStore(panels.subscribe, panels.version, panels.version);
  const pluginPanels = useMemo(() => settingsPanelsOf(panels, pluginId), [panels, pluginId, panelsVersion]);
  const index = indexPlugins(state.status === "ready" ? state.snapshot : null, view);
  const panelIds = useMemo(() => settingsPanelIds(panels), [panels, panelsVersion]);
  const group = index.groups.find((candidate) => candidate.id === pluginId);
  const [panelError, setPanelError] = useState<string | null>(null);
  /**
   * 未激活扩展的设置贡献按需加载（change: 2026-10-17-move-settings-into-canvas-dialog，任务 5.2）。
   *
   * 只调用可信发布声明的 settings-only 工厂；加载失败/旧 artifact 缺入口只显示真实原因，
   * **不回退执行完整 plugin**。迟到结果在卸载后不复活（cancelled 标记）。
   */
  const active = extensionSettings ? extensionSettings.activeIds().has(pluginId) : true;
  const [loadState, setLoadState] = useState<{ status: "idle" | "loading" | "failed"; reason?: string }>({
    status: "idle"
  });
  useEffect(() => {
    if (!extensionSettings || active || pluginPanels.length > 0) return undefined;
    let cancelled = false;
    setLoadState({ status: "loading" });
    void extensionSettings.load(pluginId).then((result) => {
      if (cancelled) return;
      setLoadState(result.ok ? { status: "idle" } : { status: "failed", reason: result.reason });
    });
    return () => {
      cancelled = true;
    };
  }, [extensionSettings, active, pluginId, pluginPanels.length]);

  if (!group) {
    return (
      <div className="settings-workbench__detail" data-testid="plugin-config-missing">
        <h2 className="settings-workbench__detail-title">插件详情</h2>
        <p className="settings-page__hint">
          找不到插件 <code>{pluginId}</code>：它可能已被移除，或插件清单还没读到。
        </p>
        <Button size="sm" onClick={onBack}>返回插件列表</Button>
      </div>
    );
  }

  const pages = pluginPages(index, group, panelIds);
  const current = resolvePluginPage(pages, page);
  const layer = PLUGIN_LAYER_LABELS[group.layer];
  const inactive = inactiveStateOf(index, group);
  const diagnostics = diagnosticsOf(index, group);
  const models = modelsOf(index, group);
  const siteRow = index.siteRows.get(group.id);
  const browserRow = index.browserRows.get(group.id);
  const statusLabel = siteRow?.busy
    ? "正在应用…"
    : siteRow
      ? siteRow.actualStateLabel
      : browserRow
        ? browserRow.status === "failed"
          ? "异常"
          : browserRow.status === "disabled"
            ? "已停用"
            : "运行中"
        : inactive
          ? "未运行"
          : "运行中";
  const statusTone = siteRow
    ? siteRow.busy || siteRow.actualState === "degraded" || siteRow.actualState === "failed"
      ? "warning"
      : isSiteRowRunning(siteRow.actualState)
        ? "success"
        : "muted"
    : browserRow
      ? browserRow.status === "failed" || browserRow.status.startsWith("pending")
        ? "warning"
        : browserRow.status === "disabled"
          ? "muted"
          : "success"
      : inactive
        ? "muted"
        : "success";
  const enabledModels = models.filter((model) => model.enabled).length;
  const manageable = isManageable(index, group);
  const directory = group.directory;
  // 刷新入口由 Provider 插件自己声明（路径由插件注册、鉴权）：宿主不硬编码具体 Provider。
  const modelRefresh = group.modelRefresh;
  const endpointEntries = group.entries.filter(isArkEndpointEntry);
  const configEntries = group.entries.filter((entry) => !isArkEndpointEntry(entry));
  const inactiveHint = inactive ? (
    <p className="settings-page__hint" data-testid={`plugin-config-inactive-${group.id}`}>
      该插件当前未运行（{inactive}）：这里保存的配置要等启用后才生效。
    </p>
  ) : null;
  const diagnosticsHint = siteRow?.actualState === "failed" || browserRow?.status === "failed" ? (
    <PluginFailureDetails key={group.id} index={index} group={group} />
  ) : diagnostics.length > 0 ? (
    <p className="settings-page__hint" role="status">{diagnostics.join("；")}</p>
  ) : null;

  return (
    <div
      className="settings-workbench__detail"
      data-testid={`plugin-config-${group.id}`}
      data-page={current.id}
    >
      {current.id === "overview" ? (
        <>
          <PluginDetailHeader
            title={group.label}
            icon={<PluginIconMark icon={group.icon} testId={`plugin-config-icon-${group.id}`} />}
            meta={
              <>
                <span className="plugin-card__badge">{layer.badge}</span>
                {group.provider ? <span className="plugin-card__badge is-provider">Provider</span> : null}
                {group.installed?.managed ? (
                  <span
                    className="plugin-card__badge is-source"
                    data-tone={extensionSource(group.installed).tone}
                    data-testid={`plugin-config-source-${group.id}`}
                  >
                    {extensionSource(group.installed).label}
                  </span>
                ) : null}
                {extensionObservationBadge(group.installed) ? (
                  <span
                    className="plugin-card__badge is-observe"
                    data-testid={`plugin-config-observe-${group.id}`}
                    title={extensionObservationBadge(group.installed)!.title}
                  >
                    {extensionObservationBadge(group.installed)!.label}
                  </span>
                ) : null}
                {extensionTrustBadge(group.installed) ? (
                  <span
                    className="plugin-card__badge is-trust"
                    data-tone={extensionTrustBadge(group.installed)!.tone}
                    data-testid={`plugin-config-trust-${group.id}`}
                  >
                    {extensionTrustBadge(group.installed)!.label}
                  </span>
                ) : null}
                {group.version ? (
                  <span className="plugin-card__version" title={`扩展版本 ${versionLabel(group.version)}`} data-testid={`plugin-config-version-${group.id}`}>
                    {versionLabel(group.version)}
                  </span>
                ) : null}
                {/* 安全说明跟着徽标走：签名只证来源与完整性，扩展与宿主同进程、同权限。 */}
                {group.installed?.managed ? (
                  <span className="plugin-config__note" data-testid={`managed-trust-note-${group.id}`}>
                    与本机宿主同权限，不是沙箱
                  </span>
                ) : null}
              </>
            }
          />

          <section className="plugin-overview" data-testid={`plugin-overview-${group.id}`}>
            <div className="plugin-overview__top">
              <span className="plugin-overview__status" data-tone={statusTone}>
                <i />{statusLabel}
              </span>
              <div className="plugin-overview__controls">
                {manageable ? (
                  <PluginStateControl
                    index={index}
                    group={group}
                    manager={manager}
                    store={store}
                    siteManageable={view.siteManageable}
                    testId={`plugin-config-switch-${group.id}`}
                  />
                ) : (
                  <Switch
                    checked={!inactive}
                    disabled
                    onCheckedChange={() => undefined}
                    aria-label={`${group.label} 的启停由宿主管理，不能单独停用`}
                    title="内置扩展由宿主管理，不能单独停用"
                    testId={`plugin-config-switch-${group.id}`}
                  />
                )}
              </div>
            </div>
            <p className="plugin-overview__description">{group.description || "暂无说明。"}</p>
            <div className="plugin-overview__stats">
              <div className="plugin-overview__stat">
                <strong>{group.entries.length}</strong>
                <span>配置项</span>
              </div>
              {models.length > 0 ? (
                <div className="plugin-overview__stat">
                  <strong>{enabledModels}/{models.length}</strong>
                  <span>已启用模型</span>
                </div>
              ) : null}
              <div className="plugin-overview__stat">
                <strong>{extensionSource(group.installed).label}</strong>
                <span>安装来源</span>
              </div>
            </div>
            {directory ? (
              <div className="plugin-overview__path" title={directory}>
                <span>安装位置</span>
                <code>{directory}</code>
                <button
                  type="button"
                  className="plugin-overview__copy"
                  aria-label="复制安装路径"
                  title="复制安装路径"
                  onClick={() => void navigator.clipboard?.writeText(directory)}
                >
                  <CopyIcon size={13} />
                </button>
              </div>
            ) : null}
          </section>

          {inactiveHint}
          {diagnosticsHint}

          {onSelectPage ? <PluginPageEntries pages={pluginSubPages(pages)} onOpen={onSelectPage} /> : null}
        </>
      ) : current.id === "config" ? (
        <>
          <PluginPageHeader page={current} />
          {diagnosticsHint}
          {pluginPanels.length > 0 ? (
            inactive !== null ? (
              <p className="settings-page__hint" data-testid={`plugin-config-panel-inactive-${group.id}`}>
                该插件当前未运行（{inactive}）：先用上方开关启用它，再配置来源连接。
              </p>
            ) : (
              <section className="settings-workbench__section">
                <div className="plugin-config__panels" data-testid={`plugin-config-panels-${group.id}`}>
                  {pluginPanels.map((panel) => (
                    <ExtensionSettingsPanelHost
                      key={panel.id}
                      id={panel.id}
                      pluginId={group.id}
                      render={panel.render}
                      {...(panel.source ? { source: panel.source } : {})}
                      {...(editSession ? { editSession } : {})}
                      onRequestClose={onBack}
                      onError={setPanelError}
                    />
                  ))}
                </div>
                {panelError ? (
                  <p className="settings-page__error" role="alert" data-testid={`plugin-config-panel-error-${group.id}`}>
                    {panelError} 声明式配置仍可在下方修改。
                  </p>
                ) : null}
              </section>
            )
          ) : loadState.status === "loading" ? (
            <p className="settings-page__hint" role="status" data-testid={`plugin-config-panel-loading-${group.id}`}>
              正在加载该插件的设置面板…
            </p>
          ) : loadState.status === "failed" ? (
            <p className="settings-page__hint" data-testid={`plugin-config-panel-unavailable-${group.id}`}>
              该插件没有可用的专用设置面板（{loadState.reason ?? "扩展未声明设置入口"}）；下方声明式配置仍可读写。
            </p>
          ) : null}

          {configEntries.length > 0 ? (
            <section className="settings-workbench__section">
              <h3 className="settings-page__group-title">配置项</h3>
              <ul className="settings-page__list" data-testid={`plugin-config-entries-${group.id}`}>
                {configEntries.map((entry) => (
                  <SettingRow
                    key={`${entry.key}:${String(entry.value)}:${entry.configured}`}
                    entry={entry}
                    store={store}
                    inactive={inactive !== null}
                    {...(editSession ? { editSession } : {})}
                  />
                ))}
              </ul>
            </section>
          ) : null}
          {endpointEntries.length > 0 ? (
            <section className="settings-workbench__section">
              <ArkEndpointSection entries={endpointEntries} store={store} inactive={inactive !== null} />
            </section>
          ) : null}

        </>
      ) : current.id === "models" ? (
        <>
          <PluginPageHeader page={current} />
          {modelRefresh ? (
            <section className="settings-workbench__section">
              <h3 className="settings-page__group-title">可用模型</h3>
              <p className="settings-page__hint">{modelRefresh.hint}</p>
              <ModelRefresh
                path={modelRefresh.path}
                testId={modelRefreshTestId(group)}
                onDiscovered={() => manager.refreshModels()}
                {...(editSession ? { editSession } : {})}
                entryId={`plugin-model-refresh:${group.id}`}
              />
            </section>
          ) : null}
          {models.length > 0 || modelRefresh ? (
            <section className="settings-workbench__section">
              <GeneratedModelsSection
                groupId={group.id}
                models={models}
                manager={manager}
                siteManageable={view.siteManageable}
              />
            </section>
          ) : null}
        </>
      ) : (
        <>
          <PluginPageHeader page={current} />
          <section className="settings-workbench__section">
            <h3 className="settings-page__group-title">安装与版本</h3>
            <dl className="plugin-manage__facts">
              <div>
                <dt>安装来源</dt>
                <dd>
                  <span className="plugin-card__badge is-source" data-tone={extensionSource(group.installed).tone}>
                    {extensionSource(group.installed).label}
                  </span>
                  {extensionTrustBadge(group.installed) ? (
                    <span className="plugin-card__badge is-trust" data-tone={extensionTrustBadge(group.installed)!.tone}>
                      {extensionTrustBadge(group.installed)!.label}
                    </span>
                  ) : null}
                </dd>
              </div>
              {group.version ? (
                <div>
                  <dt>版本</dt>
                  <dd>{versionLabel(group.version)}</dd>
                </div>
              ) : null}
              {directory ? (
                <div>
                  <dt>安装位置</dt>
                  <dd>
                    <code>{directory}</code>
                  </dd>
                </div>
              ) : null}
            </dl>
            <p className="settings-page__hint">签名只证明来源与完整性；扩展与本机宿主同进程、同权限，不是沙箱。</p>
          </section>
          <ManagedExtensionDetails installed={group.installed} />
          {managed && group.installed?.managed ? (
            <section className="settings-workbench__section">
              <h3 className="settings-page__group-title">卸载与回滚</h3>
              <ManagedExtensionActions installed={group.installed} controller={managed} canManage={store.canManage()} />
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

/** 概览页的下一级入口：配置 / 模型 / 管理。对应设计稿里「权限 / 高级配置」两张卡片。 */
function PluginPageEntries({
  pages,
  onOpen
}: {
  pages: readonly PluginPageDescriptor[];
  onOpen: (page: PluginPageId) => void;
}) {
  if (pages.length === 0) {
    return <p className="settings-page__hint">这个插件没有可配置的内容：只需要启停。</p>;
  }
  return (
    <div className="plugin-entries" data-testid="plugin-page-entries">
      {pages.map((page) => (
        <PluginPageEntry key={page.id} page={page} onOpen={() => onOpen(page.id)} />
      ))}
    </div>
  );
}

/** 详情头部：插件身份（不含返回——返回在左栏）。 */
function PluginDetailHeader({
  title,
  icon,
  meta
}: {
  title: string;
  icon?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className="settings-workbench__detail-head">
      {icon}
      <h2 className="settings-workbench__detail-title">{title}</h2>
      {/* meta 在标题行里 flex-grow 并右对齐。 */}
      {meta ? <div className="plugin-config__meta">{meta}</div> : null}
    </header>
  );
}

/** 子页标题：讲清这一页管什么、有多少。 */
function PluginPageHeader({ page }: { page: PluginPageDescriptor }) {
  return (
    <header className="settings-workbench__page-head" data-testid={`plugin-page-head-${page.id}`}>
      <h2 className="settings-workbench__detail-title">{page.label}</h2>
      <p className="settings-page__hint">{page.hint}</p>
    </header>
  );
}

/**
 * 扩展设置面板宿主：把面板的 dirty/pending 上报与渲染错误隔离放在同一处。
 *
 * 面板 `requestClose` 在设置语境表示「返回插件列表」（经同一草稿门禁），不是关闭整个设置。
 * 面板可选调用 `reportEditState` 把异步动作（保存/检测/断开）计入设置工作区的退出保护。
 */
function ExtensionSettingsPanelHost({
  id,
  pluginId,
  render,
  source,
  editSession,
  onRequestClose,
  onError
}: {
  id: string;
  pluginId: string;
  render: ComponentType<SettingsPanelRenderProps>;
  source?: object;
  editSession?: SettingsEditSession;
  onRequestClose: () => void;
  onError: (message: string | null) => void;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const faults = useExtensionFaults();
  const reportEditState = useMemo(() => {
    if (!editSession) return { report: undefined, dispose: () => undefined };
    return editSession.register({ id: `panel:${pluginId}:${id}` });
  }, [editSession, pluginId, id]);
  useEffect(() => () => reportEditState.dispose(), [reportEditState]);
  const onReport = reportEditState.report
    ? (state: { dirty?: boolean; pending?: boolean }) =>
        reportEditState.report?.({ dirty: state.dirty ?? false, pending: state.pending ?? false })
    : undefined;

  if (failed) {
    return (
      <p className="settings-page__hint" data-testid={`plugin-config-panel-failed-${pluginId}`}>
        该扩展的设置面板加载失败（{failed}）；声明式配置仍可用。
      </p>
    );
  }
  const Render = render;
  return (
    <ErrorIsolatingPanel
      onError={(message) => {
        setFailed(message);
        onError(message);
        // 扩展来源的面板同时计入会话内熔断（design D2/D3）；内置面板只走本地提示。
        const origin = source ? slotContributionOrigin(source) : null;
        if (origin?.kind === "extension") {
          faults?.report({ extensionId: origin.extensionId, epoch: origin.epoch, slot: "settings.plugin-config", contributionId: id, message });
        }
      }}
    >
      <Render requestClose={onRequestClose} {...(onReport ? { reportEditState: onReport } : {})} />
    </ErrorIsolatingPanel>
  );
}

class ErrorIsolatingPanel extends Component<
  {
    onError: (message: string) => void;
    children: ReactNode;
  },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError(error instanceof Error ? error.message : String(error));
  }

  override render(): ReactNode {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

/** 刷新按钮的测试锚点：按 Provider id 派生，新增 Provider 不需要在前端登记。 */
function modelRefreshTestId(group: PluginSettingsGroup): string {
  return `${group.providerId ?? group.id}-refresh-models`;
}

function ModelRefresh({
  path,
  testId,
  onDiscovered,
  editSession,
  entryId
}: {
  path: string;
  testId: string;
  onDiscovered: () => Promise<void>;
  editSession?: SettingsEditSession;
  entryId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 刷新是写请求（会写模型目录）：计入设置工作区的 pending 门禁。
  useSettingsEditReport(editSession, entryId, { dirty: false, pending: busy });
  const refresh = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await globalThis.fetch(appPublicUrl(path), { method: "POST" });
      const body = (await response.json().catch(() => null)) as { modelCount?: unknown; message?: unknown } | null;
      if (!response.ok) {
        setMessage(typeof body?.message === "string" ? body.message : "刷新模型目录失败");
        return;
      }
      const count = typeof body?.modelCount === "number" ? body.modelCount : 0;
      const detail = typeof body?.message === "string" ? body.message.trim() : "";
      await onDiscovered();
      setMessage(detail ? `已发现 ${count} 个模型。${detail}` : `已发现 ${count} 个模型`);
    } catch {
      setMessage("无法连接后端");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-page__item-control is-stacked">
      <Button size="sm" disabled={busy} onClick={() => void refresh()} data-testid={testId}>
        {busy ? "正在刷新…" : "刷新可用模型"}
      </Button>
      {message ? <p className="settings-page__hint" role="status">{message}</p> : null}
    </div>
  );
}
