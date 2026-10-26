/**
 * 设置工作区：画布内的唯一设置弹窗内容
 * （change: 2026-10-17-move-settings-into-canvas-dialog，任务 2.1/2.2 / design D2）。
 *
 * 原来这里是独立 `/settings` 页面（`100vh` 整页滚动 + 返回画布按钮）。现在设置是画布壳内的
 * 大型模态工作区：
 * - 固定 Header「设置」与关闭按钮（关闭经 Host 的 guard，不在组件里挂全局 Escape/遮罩监听）；
 * - 左栏 180px 保留三个分区，右侧 `minmax(0,1fr)` + `min-height:0`，只有正文滚动；
 * - 插件列表点击后在右栏替换为插件详情（同一实例内），返回列表时保留列表滚动位置。
 *
 * 不持有第二份配置：各分区读写注入的既有服务（设置 store / 插件管理 facade / ThemeService）。
 * 组件本身不创建 popup/poller/socket，也不因打开设置而刷新、重启或重装扩展。
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "../../../../shared/ui/Button.js";
import { SegmentedControl } from "../../../../shared/ui/SegmentedControl.js";
import type { ThemeService } from "../../../contract/platform.js";
import type { ExtensionManagerFacade } from "../../extension-manager/contract.js";
import { RuntimeComponentsSection } from "../runtime-components-section.js";
import { BackendSettingsSection } from "../backend-settings-section.js";
import { PluginSettingsSection, type ManagedExtensionsSource } from "../plugin-settings-section.js";
import type { SettingsPanelSource } from "../plugin-panels.js";
import type { BackendSettingsStore } from "../backend-settings-store.js";
import type { SettingsEditSession } from "../edit-session.js";
import type { ExtensionSettingsAssembly } from "../plugin.js";
import { NotificationSettingsSection } from "../notification-settings-section.js";
import type { TaskNotificationService } from "../../../contract/notification.js";
import { PluginConfigContent } from "./plugin-config-content.js";
import { SettingsDialogChrome } from "./settings-dialog-chrome.js";

export type SettingsSectionId = "backend" | "plugins" | "appearance" | "notifications" | "runtimes";

const SECTION_LABEL: Record<SettingsSectionId, string> = {
  backend: "核心服务",
  plugins: "插件配置",
  appearance: "外观",
  runtimes: "运行时组件",
  notifications: "通知"
};

const SECTIONS: ReadonlyArray<{ id: SettingsSectionId; label: string }> = [
  { id: "backend", label: SECTION_LABEL.backend },
  { id: "plugins", label: SECTION_LABEL.plugins },
  { id: "appearance", label: SECTION_LABEL.appearance },
  { id: "runtimes", label: SECTION_LABEL.runtimes },
  { id: "notifications", label: SECTION_LABEL.notifications }
];

const THEME_LABELS: Record<string, string> = { default: "浅色", dark: "暗色" };

/**
 * 右栏视图：分区列表，或某个插件的详情。
 *
 * `plugin` 是设置内部的视图身份（不进入 URL，也不进入 Dialog payload）；弹窗关闭即丢弃。
 */
type SettingsView =
  | { kind: "section"; section: SettingsSectionId }
  | { kind: "plugin"; section: SettingsSectionId; pluginId: string };

export type SettingsWorkspaceProps = {
  backend: BackendSettingsStore;
  theme: ThemeService;
  extensions: ExtensionManagerFacade;
  /** 扩展自带设置面板（`settings.plugin-config` slot）；有面板的插件卡片也可打开详情。 */
  settingsPanels?: SettingsPanelSource;
  /** 受管扩展安装与卡片操作（change: 2026-10-21-add-extension-marketplace-point，7.2）。 */
  managed?: ManagedExtensionsSource;
  /** 请求关闭整个设置（Header 关闭按钮）。经 Dialog Host guard，dirty 时先确认。 */
  onRequestClose: () => void;
  /**
   * 内部视图切换前的门禁（切分区 / 进插件详情 / 返回列表）。
   * 返回 `false` 表示用户取消或存在进行中的写请求，视图保持不动。
   */
  onRequestNavigate?: (input: {
    kind: "section" | "plugin" | "service";
    section: SettingsSectionId;
    pluginId?: string;
    /** kind === "service" 时的目标核心服务页签。 */
    serviceId?: string;
  }) => Promise<boolean> | boolean;
  /** 本次设置实例的编辑会话：行与扩展面板把 dirty/pending 汇总进来。 */
  editSession?: SettingsEditSession;
  /** 设置专项扩展装配（未激活扩展按需加载 settings.plugin-config）。 */
  extensionSettings?: ExtensionSettingsAssembly;
  /**
   * App 级任务通知服务（change: 2026-10-17-move-settings-into-canvas-dialog，任务 9.1）。
   * 缺失时仍显示分区，但明确说明通知不可用（不伪造开关效果）。
   */
  notifications?: TaskNotificationService;
  /** 弹窗实例身份（渲染/诊断用，不写入 payload）。 */
  instanceId?: string;
  /**
   * 打开本机遥测复盘页（change: 2026-10-20-add-local-client-telemetry，任务 5.5）。
   * 缺省不显示入口：设置可能在没有导航权威的独立语境里渲染。
   */
  onOpenTelemetry?: () => void;
  initialSection?: SettingsSectionId;
  /**
   * 初始直接打开某个插件的详情（`settingsOpen.open({ pluginId })`）。
   *
   * 只是初始视图提示：插件不存在时仍停在插件列表，不报错也不卡在半截视图——设置里少一个
   * 插件不是调用方该处理的异常。打开后切走再由用户自己导航。
   */
  initialPluginId?: string;
};

export function SettingsWorkspace({
  backend,
  theme,
  extensions,
  settingsPanels,
  managed,
  onRequestClose,
  onRequestNavigate,
  editSession,
  extensionSettings,
  notifications,
  instanceId,
  initialSection = "backend",
  initialPluginId,
  onOpenTelemetry
}: SettingsWorkspaceProps) {
  const [view, setView] = useState<SettingsView>(() =>
    initialPluginId
      ? { kind: "plugin", section: "plugins", pluginId: initialPluginId }
      : { kind: "section", section: initialSection }
  );
  /** 当前核心服务页签；缺省时由分区落到第一个有配置的服务。切换沿用 view 实例，切分区后仍保留。 */
  const [serviceId, setServiceId] = useState<string | null>(null);
  // 插件列表滚动位置：进入详情再返回时恢复（同一实例内）。
  const listScrollRef = useRef<number>(0);
  useEffect(() => {
    void backend.load();
  }, [backend]);

  const navigate = (next: SettingsView) => {
    // 同步门禁（通常是布尔）走同步路径：分区切换立即生效，不等待额外微任务。
    if (!onRequestNavigate) {
      commitView(next);
      return;
    }
    const outcome = onRequestNavigate({
      kind: next.kind,
      section: next.section,
      ...(next.kind === "plugin" ? { pluginId: next.pluginId } : {})
    });
    if (typeof outcome === "boolean") {
      if (outcome) commitView(next);
      return;
    }
    void outcome.then((allowed) => {
      if (allowed) commitView(next);
    });
  };

  const commitView = (next: SettingsView) => {
    if (view.kind === "plugin" && next.kind === "section") listScrollRef.current = readScrollPosition();
    setView(next);
  };

  const changeSection = (section: SettingsSectionId) => {
    if (section === view.section) return;
    navigate({ kind: "section", section });
  };

  /**
   * 切换核心服务页签。
   *
   * 页签切换会卸载当前服务的编辑行（行内草稿只在组件内存里），所以必须走与分区切换同一套
   * dirty/pending 门禁；门禁拒绝时停在原页签。
   */
  const changeService = (nextServiceId: string) => {
    if (nextServiceId === serviceId) return;
    if (!onRequestNavigate) {
      setServiceId(nextServiceId);
      return;
    }
    const outcome = onRequestNavigate({ kind: "service", section: "backend", serviceId: nextServiceId });
    if (typeof outcome === "boolean") {
      if (outcome) setServiceId(nextServiceId);
      return;
    }
    void outcome.then((allowed) => {
      if (allowed) setServiceId(nextServiceId);
    });
  };

  const openPlugin = (pluginId: string) => {
    navigate({ kind: "plugin", section: "plugins", pluginId });
  };

  const backToList = () => {
    navigate({ kind: "section", section: "plugins" });
  };

  return (
    <SettingsDialogChrome
      {...(instanceId ? { instanceId } : {})}
      onRequestClose={onRequestClose}
      section={view.section}
      nav={
        <nav className="settings-workbench__nav" aria-label="设置分区">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={entry.id === view.section ? "settings-workbench__nav-item is-active" : "settings-workbench__nav-item"}
              onClick={() => changeSection(entry.id)}
              data-testid={`settings-nav-${entry.id}`}
            >
              {entry.label}
            </button>
          ))}
        </nav>
      }
    >
      {view.kind === "plugin" ? (
        <PluginConfigContent
          pluginId={view.pluginId}
          store={backend}
          manager={extensions}
          {...(settingsPanels ? { settingsPanels } : {})}
          {...(editSession ? { editSession } : {})}
          {...(extensionSettings ? { extensionSettings } : {})}
          onBack={backToList}
        />
      ) : view.section === "backend" ? (
        <Panel
          title="核心服务"
          hint="本机运行的核心服务自己的配置，按服务分开；只列有配置的服务，插件声明的配置在「插件配置」里各自的详情上。写入本地配置文件，标注「即时生效」的项保存后立刻生效。"
          action={
            <Button size="sm" tone="ghost" onClick={() => changeSection("plugins")} data-testid="settings-goto-plugins">
              去插件配置
            </Button>
          }
        >
          <BackendSettingsSection
            store={backend}
            activeServiceId={serviceId}
            onSelectService={changeService}
            onGoToPlugins={() => changeSection("plugins")}
            extensions={extensions}
            onOpenPlugin={openPlugin}
            {...(editSession ? { editSession } : {})}
            {...(onOpenTelemetry ? { onOpenTelemetry } : {})}
          />
        </Panel>
      ) : view.section === "plugins" ? (
        <Panel
          title="插件配置"
          hint="宿主插件树与站点、浏览器插件都在这里；点卡片进去改这个插件的配置，启停就在卡片上。"
          wide
        >
          <PluginSettingsSection
            store={backend}
            manager={extensions}
            onOpenPlugin={openPlugin}
            {...(settingsPanels ? { settingsPanels } : {})}
            {...(managed ? { managed } : {})}
          />
          <ScrollRestore position={listScrollRef.current} />
        </Panel>
      ) : view.section === "runtimes" ? (
        <Panel title="运行时组件" hint="管理按需下载的可选功能。"><RuntimeComponentsSection /></Panel>
      ) : view.section === "appearance" ? (
        <Panel title="外观" hint="主题只保存在此浏览器。">
          <ThemeSection theme={theme} />
        </Panel>
      ) : (
        <Panel title="通知" hint="任务结果提醒。开关是本地偏好，立即生效，不需要保存。">
          {notifications ? (
            <NotificationSettingsSection notifications={notifications} />
          ) : (
            <p className="settings-page__hint" data-testid="notification-settings-unavailable">
              当前实例没有可用的任务通知服务。
            </p>
          )}
        </Panel>
      )}
    </SettingsDialogChrome>
  );
}

/** 当前右栏滚动位置（用于插件列表返回恢复）。 */
function readScrollPosition(): number {
  const scroller = globalThis.document?.querySelector<HTMLElement>(".settings-workbench__body");
  return scroller?.scrollTop ?? 0;
}

/** 插件列表重新挂载后恢复滚动位置（只在挂载时执行一次）。 */
function ScrollRestore({ position }: { position: number }) {
  useEffect(() => {
    if (position <= 0) return;
    const scroller = globalThis.document?.querySelector<HTMLElement>(".settings-workbench__body");
    if (scroller) scroller.scrollTop = position;
  }, [position]);
  return null;
}

function Panel({
  title,
  hint,
  action,
  wide = false,
  children
}: {
  title: string;
  hint: string;
  action?: ReactNode;
  /** 卡片网格类内容用满内容列；表单分区保持默认可读行宽。 */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={wide ? "settings-workbench__panel is-wide" : "settings-workbench__panel"}>
      <div className="settings-workbench__panel-head">
        <h2>{title}</h2>
        {action}
      </div>
      <p className="settings-page__hint">{hint}</p>
      {children}
    </section>
  );
}

function ThemeSection({ theme }: { theme: ThemeService }) {
  const snapshot = useSyncExternalStore(theme.subscribe, theme.getSnapshot, theme.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const ids = theme.presetIds();
  return (
    <>
      <SegmentedControl
        label="主题"
        value={snapshot.id}
        onValueChange={(id) => {
          const result = theme.select(id);
          setError(result.ok ? null : result.error);
        }}
        options={ids.map((id) => ({ value: id, label: THEME_LABELS[id] ?? id }))}
        dataAttributes={{ "data-testid": "settings-theme" }}
      />
      {ids.length <= 1 ? <p className="settings-page__hint">目前只内置了一套主题。</p> : null}
      {error ? <p className="settings-page__error" role="alert">{error}</p> : null}
    </>
  );
}
