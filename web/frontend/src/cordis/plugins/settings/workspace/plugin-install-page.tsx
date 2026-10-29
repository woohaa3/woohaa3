/**
 * 「添加扩展」页（插件层级里的 L2 兄弟页）。
 *
 * 层级导航（2026-10-28）：列表页不放标题——面包屑「设置 / 插件配置 / 添加扩展」就是标题；
 * 进入某个扩展的详情时**整页替换**列表（不保留页头与来源切换，也不再叠一个「返回列表」按钮），
 * 面包屑多一段扩展名，点「添加扩展」回到列表。文件安装与市场共用同一页，靠分段控件切换来源。
 *
 * 页面只组装既有面板（市场列表 / 详情 / 文件安装），不持有第二份状态。
 */
import { useSyncExternalStore } from "react";
import { FileTextIcon, PlusIcon } from "../../../../shared/ui/icons.js";
import { SegmentedControl } from "../../../../shared/ui/SegmentedControl.js";
import type { MarketplaceInstallState } from "../marketplace-install.js";
import type { SettingsSnapshot } from "@woohaa3/contracts";
import type { ManagedExtensionsSource } from "../plugin-settings-section.js";
import { MarketplaceInstallPanel } from "../marketplace-install-ui.js";
import { ManagedInstallBar } from "../managed-extensions-ui.js";
import "../settings.css";

export type PluginInstallMode = "market" | "file";

/** 没有市场控制器时的稳定空态（hook 必须无条件调用）。 */
const NO_MARKET_STATE: MarketplaceInstallState = {
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
const subscribeNone = () => () => undefined;

export type PluginInstallPageProps = {
  mode: PluginInstallMode;
  /** 切换来源；不可用的模式不会出现在分段控件里。 */
  onSelectMode: (mode: PluginInstallMode) => void;
  /** 受管扩展控制器（文件安装需要）；缺省时只有市场安装。 */
  managed?: ManagedExtensionsSource;
  snapshot: SettingsSnapshot | null;
  canManage: boolean;
  /** 从市场安装：需要宿主受管安装能力、管理员与市场控制器。 */
  marketAvailable: boolean;
  fileAvailable: boolean;
};

export function PluginInstallPage({
  mode,
  onSelectMode,
  managed,
  snapshot,
  canManage,
  marketAvailable,
  fileAvailable
}: PluginInstallPageProps) {
  const marketplace = managed?.marketplace;
  const marketState = useSyncExternalStore(
    marketplace ? marketplace.subscribe : subscribeNone,
    marketplace ? marketplace.getState : () => NO_MARKET_STATE,
    marketplace ? marketplace.getState : () => NO_MARKET_STATE
  );
  // 详情打开时整页让位：不再显示来源切换，也不留页头标题。
  const detailOpen = marketAvailable && marketState.selected !== null;

  const modes: Array<{ value: PluginInstallMode; label: string; icon: React.ReactNode }> = [];
  if (marketAvailable) modes.push({ value: "market", label: "从市场安装", icon: <PlusIcon size={14} /> });
  if (fileAvailable) modes.push({ value: "file", label: "从文件安装", icon: <FileTextIcon size={14} /> });
  const active = modes.some((entry) => entry.value === mode) ? mode : modes[0]?.value ?? mode;

  return (
    <section
      className="settings-install-page"
      data-testid="plugin-install-page"
      data-mode={active}
      data-view={detailOpen ? "detail" : "list"}
    >
      {modes.length > 1 && !detailOpen ? (
        <SegmentedControl
          label="安装来源"
          value={active}
          onValueChange={(value) => onSelectMode(value as PluginInstallMode)}
          options={modes.map((entry) => ({ value: entry.value, label: entry.label, icon: entry.icon }))}
          dataAttributes={{ "data-testid": "plugin-install-mode" }}
        />
      ) : null}

      {modes.length === 0 ? (
        <p className="settings-page__hint" data-testid="plugin-install-unavailable">
          当前宿主没有开启受管扩展安装：需要管理员权限，且宿主启用受管安装目录。
        </p>
      ) : active === "market" && marketplace ? (
        <MarketplaceInstallPanel
          controller={marketplace}
          jobs={managed?.controller}
          snapshot={snapshot}
          canManage={canManage}
          defaultOpen
          view
        />
      ) : managed ? (
        <ManagedInstallBar controller={managed.controller} snapshot={snapshot} canManage={canManage} variant="view" />
      ) : (
        <p className="settings-page__hint" data-testid="plugin-install-unavailable">
          当前宿主没有开启受管扩展安装：需要管理员权限，且宿主启用受管安装目录。
        </p>
      )}
    </section>
  );
}

/** 详情是否打开（面包屑据此多一段扩展名）。供工作区读取同一份源。 */
export function installDetailOf(
  marketplace: ManagedExtensionsSource["marketplace"],
  state: MarketplaceInstallState
): { extensionId: string; label: string } | null {
  const selected = state.selected;
  if (!marketplace || !selected) return null;
  const label =
    selected.detail?.extension.label ??
    state.items.find((item) => item.extensionId === selected.extensionId)?.label ??
    selected.extensionId;
  return { extensionId: selected.extensionId, label };
}
