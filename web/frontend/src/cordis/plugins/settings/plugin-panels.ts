/**
 * 设置弹窗里「插件详情」的扩展设置面板投影
 * （change: 2026-10-17-move-settings-into-canvas-dialog，任务 5.1/5.2 / design D5）。
 *
 * 扩展前端经 `settings.plugin-config` slot 贡献自己的设置面板（例如 Agent 来源的账号 / API Key
 * / 本机 App Server）；设置只按 `pluginId` 把面板挂到对应插件详情，不 import 扩展实现。
 *
 * 面板拿到的能力是**有界**的：
 * - `requestClose`：在设置语境表示「返回插件列表」（经同一草稿门禁），不是关闭设置；
 * - `reportEditState`：把异步动作的 dirty/pending 汇总进设置工作区的退出保护。
 *
 * 面板不获得宿主业务 service、画布写入或模块地址。
 */
import type { ComponentType } from "react";

/** 扩展面板可上报的编辑状态（均为可选；缺省 false）。 */
export type SettingsPanelEditState = {
  /** 面板内是否有未保存输入。 */
  dirty?: boolean;
  /** 面板内是否有写/检测请求进行中。 */
  pending?: boolean;
};

export type SettingsPanelRenderProps = {
  /** 设置语境下的「返回插件列表」（经草稿门禁；不关闭设置）。 */
  requestClose?: () => void;
  /** 把面板的 dirty/pending 汇报给设置工作区（关闭、切分区与返回列表共用一个门禁）。 */
  reportEditState?: (state: SettingsPanelEditState) => void;
};

/** 一个插件自带的设置面板（来自 slot contribution）。 */
export type SettingsPanelContribution = {
  /** contribution 稳定 id。 */
  id: string;
  /** 归属插件 id，与插件卡片 / 站点目录 extensionId 一致。 */
  pluginId: string;
  render: ComponentType<SettingsPanelRenderProps>;
  /** 原始 slot 贡献（宿主据此读取来源身份并上报扩展故障；change: 2026-10-21-harden-extension-fault-isolation）。 */
  source?: object;
};

/** 面板读取口：设置工作区用 `useSyncExternalStore` 订阅 slot 变化。 */
export type SettingsPanelSource = {
  list(): readonly SettingsPanelContribution[];
  subscribe(listener: () => void): () => void;
  /** slot 全局版本号；作为外部 store 的稳定快照。 */
  version(): number;
};

/** 无扩展设置面板时的稳定空实现；测试与未注入场景复用。 */
export const EMPTY_SETTINGS_PANELS: SettingsPanelSource = {
  list: () => [],
  subscribe: () => () => undefined,
  version: () => 0
};

/** 有自带设置面板的插件 id 集合。 */
export function settingsPanelIds(source: SettingsPanelSource): ReadonlySet<string> {
  return new Set(source.list().map((panel) => panel.pluginId));
}

/** 某个插件自己的设置面板（保持 slot 顺序）。 */
export function settingsPanelsOf(
  source: SettingsPanelSource,
  pluginId: string
): readonly SettingsPanelContribution[] {
  return source.list().filter((panel) => panel.pluginId === pluginId);
}
