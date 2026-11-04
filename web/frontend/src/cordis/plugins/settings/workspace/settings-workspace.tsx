/**
 * 设置工作区：画布内的唯一设置弹窗内容。
 *
 * 层级导航（画布设置-扩展层级导航，2026-10-28 / 交互设计说明 v1）：
 * 左栏永远是右栏内容的父级，进入下一级时右栏的内容成为父级导航、右栏换新内容——
 * - L1 分区：左栏是设置分区（核心服务 / 插件配置 / …），右栏是分区正文；
 * - L2 插件概览：左栏换成插件列表（含返回与搜索），右栏是该插件的概览；
 * - L3 插件子页：左栏换成子页导航（概览 / 配置 / 模型 / 管理），右栏是子页正文。
 *
 * 两条不变式：
 * 1. **关闭按钮语义单一**：X 只关整棵设置树，从不在内部分层关闭；
 * 2. **草稿门禁唯一**：分区切换、进插件、切子页、返回全部走同一个 `onRequestNavigate`，
 *    写请求中直接拒绝，未保存草稿先确认。
 *
 * 过渡动效约 300ms、进入与返回对称；动效期间左栏与正文不接受点击，防止栈错乱。
 * 面包屑可跨级直达目标层（无中间帧）。
 *
 * 不持有第二份配置：各分区读写注入的既有服务（设置 store / 插件管理 facade / ThemeService）。
 * 组件本身不创建 popup/poller/socket，也不因打开设置而刷新、重启或重装扩展。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "@woohaa3/ui/primitives";
import { SegmentedControl } from "@woohaa3/ui/primitives";
import { ActivityIcon, ChatIcon, PluginIcon, SettingsIcon, SparklesIcon, SunIcon } from "@woohaa3/ui/icons";
import type { ThemeService } from "../../../contract/platform.js";
import type { ExtensionManagerFacade } from "../../extension-manager/contract.js";
import { RuntimeComponentsSection } from "../runtime-components-section.js";
import { BackendSettingsSection } from "../backend-settings-section.js";
import { AboutSection } from "../about-section.js";
import { PluginSettingsSection, type ManagedExtensionsSource } from "../plugin-settings-section.js";
import { indexPlugins } from "../plugin-groups.js";
import { EMPTY_SETTINGS_PANELS, settingsPanelIds, type SettingsPanelSource } from "../plugin-panels.js";
import type { BackendSettingsStore } from "../backend-settings-store.js";
import type { SettingsEditSession } from "../edit-session.js";
import type { ExtensionSettingsAssembly } from "../plugin.js";
import type { MarketplaceInstallState } from "../marketplace-install.js";
import { NotificationSettingsSection } from "../notification-settings-section.js";
import type { TaskNotificationService } from "../../../contract/notification.js";
import { pluginPages, resolvePluginPage, type PluginPageDescriptor, type PluginPageId } from "../plugin-pages.js";
import { PluginConfigContent } from "./plugin-config-content.js";
import { PluginInstallPage, installDetailOf, type PluginInstallMode } from "./plugin-install-page.js";
import { SettingsBreadcrumb } from "./settings-breadcrumb.js";
import { PluginListRail, PluginPageRail, SectionRailNav } from "./rail-navigation.js";
import { SettingsDialogChrome } from "./settings-dialog-chrome.js";

export type SettingsSectionId = "backend" | "plugins" | "appearance" | "notifications" | "runtimes" | "about";

const SECTION_LABEL: Record<SettingsSectionId, string> = {
  backend: "核心服务",
  plugins: "插件配置",
  appearance: "外观",
  runtimes: "运行时组件",
  notifications: "通知",
  about: "关于"
};

// ─── 四喜发行形态：左栏只留「插件配置 + 外观」 ───
// 分区数据在本目录的 `settings-sections-sixi.ts`，不直接改下面的常量：
// 上游每次动 `SECTIONS` 都会和我们冲突，而这里的渲染分支一个都没删，要放开某个分区
// 只需往 `SIXI_SETTINGS_SECTIONS` 加一行。被藏掉的分区（核心服务 / 运行时组件 /
// 通知 / 关于）的正文实现仍保留，供类型与 `settingsOpen` 的签名继续使用。
import { SIXI_SETTINGS_SECTIONS, SIXI_SETTINGS_DEFAULT_SECTION } from "./settings-sections-sixi.js";
// 插件列表里要摘掉的 id（ppserver、两个存储后端、四喜本体），见 `settings-plugins-sixi.ts`。
import { SIXI_HIDDEN_SETTINGS_PLUGINS, SIXI_ALLOW_EXTENSION_INSTALL } from "./settings-plugins-sixi.js";

/** 全部分区（上游的完整集合）；实际显示哪些由 `sections`（缺省 `SIXI_SETTINGS_SECTIONS`）决定。 */
const ALL_SECTIONS: ReadonlyArray<{ id: SettingsSectionId; label: string }> = [
  { id: "backend", label: SECTION_LABEL.backend },
  { id: "plugins", label: SECTION_LABEL.plugins },
  { id: "appearance", label: SECTION_LABEL.appearance },
  { id: "runtimes", label: SECTION_LABEL.runtimes },
  { id: "notifications", label: SECTION_LABEL.notifications },
  { id: "about", label: SECTION_LABEL.about }
];

const SECTION_ICONS: Record<SettingsSectionId, ReactNode> = {
  backend: <SettingsIcon size={16} />,
  plugins: <PluginIcon size={16} />,
  appearance: <SunIcon size={16} />,
  runtimes: <ActivityIcon size={16} />,
  notifications: <ChatIcon size={16} />,
  about: <SparklesIcon size={16} />
};

const THEME_LABELS: Record<string, string> = { default: "浅色", dark: "暗色" };

/** 层级：0 = 分区，1 = 插件概览（左栏是插件列表），2 = 插件子页（左栏是子页导航）。 */
type SettingsLevel = 0 | 1 | 2;

/** 过渡方向：进入下一级 / 返回上一级 / 同级切换（只换右栏）。 */
type MotionDirection = "forward" | "back" | "sibling";

/** 左右栏同步平移的时长：与设计稿一致（300–320ms），动效期间不接受重复点击。 */
const MOTION_MS = 320;

/**
 * 右栏视图：分区，或某个插件的某个子页。
 *
 * `page` 是设置内部的视图身份（不进入 URL，也不进入 Dialog payload）；弹窗关闭即丢弃。
 * `subNav` 表示已经进过这个插件的子页：此时左栏是子页导航（L3），其中「概览」也留在 L3——
 * 这样从「配置」回「概览」只需一次同级点击，不会把左栏退化回插件列表。
 */
export type SettingsView =
  | { kind: "section"; section: SettingsSectionId }
  | { kind: "plugin"; pluginId: string; page: PluginPageId; subNav?: boolean }
  /** 「添加扩展」页：插件列表的兄弟页（同一层级），不再常驻在列表顶部。 */
  | { kind: "install"; mode: PluginInstallMode };

/** 内部导航请求：交给 Host 的草稿 / 写请求门禁。 */
export type SettingsNavRequest =
  | { kind: "section"; section: SettingsSectionId }
  | { kind: "plugin"; section: "plugins"; pluginId: string }
  | { kind: "plugin-page"; section: "plugins"; pluginId: string; page: PluginPageId }
  | { kind: "install"; section: "plugins"; mode: PluginInstallMode }
  | { kind: "service"; section: "backend"; serviceId: string };

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
   * 内部视图切换前的门禁（切分区 / 进插件 / 切子页 / 返回）。
   * 返回 `false` 表示用户取消或存在进行中的写请求，视图保持不动。
   */
  onRequestNavigate?: (input: SettingsNavRequest) => Promise<boolean> | boolean;
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
   * 左栏显示哪些分区。缺省是四喜发行形态的 `SIXI_SETTINGS_SECTIONS`（只留插件配置 + 外观）；
   * 传别的集合用于测试或将来放开某个分区 —— 各分区的正文实现一直都在。
   */
  sections?: readonly SettingsSectionId[];
  /**
   * 初始直接打开某个插件的概览（`settingsOpen.open({ pluginId })`）。
   *
   * 只是初始视图提示：插件不存在时停在「插件不存在」的稳定提示，不报错也不卡在半截视图。
   */
  initialPluginId?: string;
  /**
   * 从插件列表里摘掉的插件 id。缺省是四喜发行形态的 `SIXI_HIDDEN_SETTINGS_PLUGINS`
   * （ppserver、两个存储后端、四喜本体）；传 `[]` 用于查看完整清单（内部排障、测试）。
   */
  hiddenPluginIds?: readonly string[];
  /**
   * 是否渲染「添加扩展」（市场 / 文件安装）入口。缺省取 `SIXI_ALLOW_EXTENSION_INSTALL`（false）；
   * 传 true 用于内部排障与测安装流的用例。
   */
  allowExtensionInstall?: boolean;
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
  initialSection,
  sections = SIXI_SETTINGS_SECTIONS,
  hiddenPluginIds = SIXI_HIDDEN_SETTINGS_PLUGINS,
  allowExtensionInstall = SIXI_ALLOW_EXTENSION_INSTALL,
  initialPluginId,
  onOpenTelemetry
}: SettingsWorkspaceProps) {
  // 实际显示的分区：按传入顺序从完整集合里取，保持真正的左栏顺序。
  const visibleSections = useMemo(
    () => sections.map((id) => ALL_SECTIONS.find((entry) => entry.id === id)).filter((entry) => entry !== undefined),
    [sections]
  );
  const defaultSection: SettingsSectionId = visibleSections[0]?.id ?? SIXI_SETTINGS_DEFAULT_SECTION;
  const [view, setView] = useState<SettingsView>(() => {
    if (initialPluginId) return { kind: "plugin", pluginId: initialPluginId, page: "overview" };
    // 请求的分区可能已被 `sections` 藏掉（例如 `settingsOpen.open({ section: "backend" })`）：
    // 落到第一个可见分区，而不是打开一个左栏没有选中项、正文却是存储/遥测的孤儿视图。
    const wanted = initialSection ?? defaultSection;
    return { kind: "section", section: visibleSections.some((entry) => entry.id === wanted) ? wanted : defaultSection };
  });
  /** 当前核心服务页签；缺省时由分区落到第一个有配置的服务。切换沿用 view 实例，切分区后仍保留。 */
  const [serviceId, setServiceId] = useState<string | null>(null);
  /** 本次层级平移的方向；`null` 表示没有进行中的动效。 */
  const [motion, setMotion] = useState<MotionDirection | null>(null);
  const motionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 回到插件列表时要恢复的滚动位置（列表在离开层级时卸载）。 */
  const listScrollRef = useRef(0);
  const settingsState = useSyncExternalStore(backend.subscribe, backend.getState, backend.getState);
  const managerView = useSyncExternalStore(extensions.subscribe, extensions.getSnapshot, extensions.getSnapshot);
  const panels = settingsPanels ?? EMPTY_SETTINGS_PANELS;
  const panelsVersion = useSyncExternalStore(panels.subscribe, panels.version, panels.version);
  const index = indexPlugins(settingsState.status === "ready" ? settingsState.snapshot : null, managerView, hiddenPluginIds);
  // 订阅 slot 版本：扩展前端按需加载、注册面板后，左栏与概览的「配置」入口立即出现。
  const panelIds = useMemo(() => settingsPanelIds(panels), [panels, panelsVersion]);
  const pluginCount = settingsState.status === "ready" ? index.groups.length : null;
  const snapshot = settingsState.status === "ready" ? settingsState.snapshot : null;
  const canManage = backend.canManage();
  // 受管安装能力：宿主启用受管目录 + 管理员；市场安装还要求市场控制器在场。
  const fileAvailable = Boolean(snapshot?.extensionInstallations && canManage);
  const marketAvailable = Boolean(fileAvailable && managed?.marketplace);
  // 安装详情的身份只在「添加扩展」页里可见：面包屑据此多一段扩展名，返回靠点「添加扩展」。
  const marketplace = managed?.marketplace;
  const readMarketState = marketplace ? marketplace.getState : () => emptyMarketState;
  const marketState = useSyncExternalStore(
    marketplace ? marketplace.subscribe : noopSubscribe,
    readMarketState,
    readMarketState
  );
  const installDetail = view.kind === "install" ? installDetailOf(marketplace, marketState) : null;

  useEffect(() => {
    void backend.load();
  }, [backend]);
  useEffect(() => {
    return () => {
      if (motionTimer.current) clearTimeout(motionTimer.current);
    };
  }, []);

  const activeGroup = view.kind === "plugin" ? index.groups.find((group) => group.id === view.pluginId) : undefined;
  const pages: readonly PluginPageDescriptor[] = activeGroup ? pluginPages(index, activeGroup, panelIds) : [];
  // 目标子页已不存在（例如插件停用后模型页消失）时回落到概览：右栏与左栏读同一个解析结果。
  const currentPage = view.kind === "plugin" ? resolvePluginPage(pages, view.page) : null;
  // 左栏形态由「是否进过子页」决定，而不是由当前页是不是概览决定（L3 也有概览）。
  const level: SettingsLevel =
    view.kind === "section" ? 0 : view.kind === "install" ? 1 : view.subNav === true && activeGroup ? 2 : 1;

  /** 某个视图落在第几级；用于判断这次切换是进入、返回还是同级。 */
  const levelOf = (candidate: SettingsView): SettingsLevel =>
    candidate.kind === "section"
      ? 0
      : candidate.kind === "plugin" && candidate.subNav === true && index.groups.some((group) => group.id === candidate.pluginId)
        ? 2
        : 1;

  const commit = (next: SettingsView) => {
    const from = levelOf(view);
    const to = levelOf(next);
    // 离开插件层级时记下列表滚动位置（左栏列表与一级页是同一份内容）。
    if (from > 0 && to === 0) listScrollRef.current = readScrollPosition();
    else if (from === 1 && to === 2) listScrollRef.current = 0;
    // 离开「添加扩展」：详情属于那一层的私有状态，下次进来回到列表。
    if (view.kind === "install" && next.kind !== "install") managed?.marketplace?.close();
    setView(next);
    setMotion(from === to ? "sibling" : to > from ? "forward" : "back");
    if (motionTimer.current) clearTimeout(motionTimer.current);
    motionTimer.current = setTimeout(() => setMotion(null), MOTION_MS);
  };

  /** 同一个视图不重复导航：点当前项、点当前子页都是无操作。 */
  const sameView = (candidate: SettingsView): boolean => {
    if (view.kind !== candidate.kind) return false;
    if (view.kind === "section" && candidate.kind === "section") return view.section === candidate.section;
    if (view.kind === "install" && candidate.kind === "install") return view.mode === candidate.mode;
    if (view.kind === "plugin" && candidate.kind === "plugin") {
      return (
        view.pluginId === candidate.pluginId &&
        (view.subNav === true) === (candidate.subNav === true) &&
        currentPage?.id === resolvePluginPage(pages, candidate.page).id
      );
    }
    return false;
  };

  const navigate = (next: SettingsView) => {
    if (sameView(next)) return;
    // 同步门禁（通常是布尔）走同步路径：分区切换立即生效，不等待额外微任务。
    if (!onRequestNavigate) {
      commit(next);
      return;
    }
    const outcome = onRequestNavigate(navRequestFor(view, next));
    if (typeof outcome === "boolean") {
      if (outcome) commit(next);
      return;
    }
    void outcome.then((allowed) => {
      if (allowed) commit(next);
    });
  };

  const changeSection = (section: SettingsSectionId) => {
    if (view.kind === "section" && section === view.section) return;
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
    const request: SettingsNavRequest = { kind: "service", section: "backend", serviceId: nextServiceId };
    if (!onRequestNavigate) {
      setServiceId(nextServiceId);
      return;
    }
    const outcome = onRequestNavigate(request);
    if (typeof outcome === "boolean") {
      if (outcome) setServiceId(nextServiceId);
      return;
    }
    void outcome.then((allowed) => {
      if (allowed) setServiceId(nextServiceId);
    });
  };

  const openPlugin = (pluginId: string) => navigate({ kind: "plugin", pluginId, page: "overview" });
  /** 进入插件的子页导航（L3）：含「概览」，子页之间只换右栏。 */
  const openPluginPage = (pluginId: string) => (page: PluginPageId) =>
    navigate({ kind: "plugin", pluginId, page, subNav: true });
  const backToSections = () => {
    // 返回「插件配置」一级页：那是这棵插件树的父级。
    changeSection("plugins");
  };

  const railKey =
    view.kind === "section" ? "sections" : level === 2 && view.kind === "plugin" ? `plugin:${view.pluginId}` : "plugins";
  const rail =
    view.kind === "section" ? (
      <SectionRailNav
        entries={visibleSections.map((entry) => ({ id: entry.id, label: entry.label, icon: SECTION_ICONS[entry.id] }))}
        activeId={view.section}
        pluginCount={pluginCount}
        onSelect={(id) => changeSection(id as SettingsSectionId)}
      />
    ) : level === 2 && activeGroup && currentPage ? (
      <PluginPageRail
        pluginId={activeGroup.id}
        label={activeGroup.label}
        pages={pages}
        activeId={currentPage.id}
        onSelect={openPluginPage(activeGroup.id)}
        // 返回上一级 = 插件概览（L2）；离开这棵插件树才用左栏列表的返回。
        onBack={() => openPlugin(activeGroup.id)}
      />
    ) : (
      <PluginListRail
        index={index}
        {...(activeGroup ? { activeId: activeGroup.id } : {})}
        onSelect={openPlugin}
        onBack={backToSections}
      />
    );

  const viewKey =
    view.kind === "section"
      ? `section:${view.section}`
      : view.kind === "install"
        ? `install:${view.mode}`
        : `plugin:${view.pluginId}:${currentPage?.id ?? "overview"}`;

  // 每次换视图把正文滚回顶部；回到插件列表时恢复离开前的位置。
  useEffect(() => {
    const scroller = globalThis.document?.querySelector<HTMLElement>(".settings-workbench__body");
    if (!scroller) return;
    scroller.scrollTop = listScrollRef.current;
    listScrollRef.current = 0;
  }, [viewKey]);

  return (
    <SettingsDialogChrome
      {...(instanceId ? { instanceId } : {})}
      onRequestClose={onRequestClose}
      section={view.kind === "section" ? view.section : "plugins"}
      level={level}
      motion={motion}
      nav={
        <div className="settings-rail__level" key={railKey}>
          {rail}
        </div>
      }
    >
      <div className="settings-view" key={viewKey}>
        {view.kind !== "section" ? (
          <div className="settings-sticky-head">
            <SettingsBreadcrumb
              testId="settings-breadcrumbs"
              crumbs={
                view.kind === "install"
                  ? [
                      { label: "设置" },
                      { label: "插件配置", onClick: backToSections },
                      {
                        label: "添加扩展",
                        ...(installDetail ? { onClick: () => marketplace?.close() } : {})
                      },
                      ...(installDetail ? [{ label: installDetail.label }] : [])
                    ]
                  : [
                      { label: "设置" },
                      { label: "插件配置", onClick: backToSections },
                      {
                        label: activeGroup?.label ?? view.pluginId,
                        ...(level === 2 ? { onClick: () => openPlugin(view.pluginId) } : {})
                      },
                      ...(level === 2 && currentPage ? [{ label: currentPage.label }] : [])
                    ]
              }
            />
          </div>
        ) : null}
        {view.kind === "plugin" ? (
          <PluginConfigContent
            pluginId={view.pluginId}
            {...(currentPage ? { page: currentPage.id } : {})}
            store={backend}
            manager={extensions}
            {...(managed ? { managed: managed.controller } : {})}
            {...(settingsPanels ? { settingsPanels } : {})}
            {...(editSession ? { editSession } : {})}
            {...(extensionSettings ? { extensionSettings } : {})}
            hiddenPluginIds={SIXI_HIDDEN_SETTINGS_PLUGINS}
            onBack={backToSections}
            onSelectPage={openPluginPage(view.pluginId)}
          />
        ) : view.kind === "install" ? (
          <PluginInstallPage
            mode={view.mode}
            onSelectMode={(mode) => navigate({ kind: "install", mode })}
            {...(managed ? { managed } : {})}
            snapshot={snapshot}
            canManage={canManage}
            marketAvailable={marketAvailable}
            fileAvailable={fileAvailable}
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
          <PluginSettingsSection
            store={backend}
            manager={extensions}
            onOpenPlugin={openPlugin}
            onRequestInstall={(mode) => navigate({ kind: "install", mode })}
            {...(settingsPanels ? { settingsPanels } : {})}
            {...(managed ? { managed } : {})}
            hiddenPluginIds={hiddenPluginIds}
            allowExtensionInstall={allowExtensionInstall}
          />
        ) : view.section === "runtimes" ? (
          <Panel title="运行时组件" hint="管理按需下载的可选功能。"><RuntimeComponentsSection /></Panel>
        ) : view.section === "appearance" ? (
          <Panel title="外观" hint="主题只保存在此浏览器。">
            <ThemeSection theme={theme} />
          </Panel>
        ) : view.section === "about" ? (
          <Panel
            title="关于"
            hint="当前应用与宿主环境的事实；只展示运行时能判定的信息，不推测版本或环境。"
          >
            <AboutSection snapshot={snapshot} />
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
      </div>
    </SettingsDialogChrome>
  );
}

const noopSubscribe = () => () => undefined;
/** 没有市场控制器时的稳定空态：getSnapshot 必须每次返回同一个引用。 */
const emptyMarketState: MarketplaceInstallState = {
  sources: [],
  sourceId: null,
  query: "",
  searching: false,
  refreshing: false,
  fetchedAt: null,
  items: [],
  unavailableReason: null,
  selected: null,
  installing: false,
  installingId: null,
  trusting: null,
  error: null,
  notice: null
};

/** 两个视图之间的导航请求：交给 Host 判定能否切换。 */
function navRequestFor(from: SettingsView, next: SettingsView): SettingsNavRequest {
  if (next.kind === "section") return { kind: "section", section: next.section };
  if (next.kind === "install") return { kind: "install", section: "plugins", mode: next.mode };
  const samePlugin = from.kind === "plugin" && from.pluginId === next.pluginId;
  return samePlugin
    ? { kind: "plugin-page", section: "plugins", pluginId: next.pluginId, page: next.page }
    : { kind: "plugin", section: "plugins", pluginId: next.pluginId };
}

/** 当前右栏滚动位置（用于回到插件列表时恢复）。 */
function readScrollPosition(): number {
  const scroller = globalThis.document?.querySelector<HTMLElement>(".settings-workbench__body");
  return scroller?.scrollTop ?? 0;
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
