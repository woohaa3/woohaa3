/**
 * 插件图标解析：语义图形名 → `shared/ui` 图标组件；品牌图形路径 → `<img>`。
 *
 * 契约（`@woohaa3/contracts` 的 `PLUGIN_ICON_NAMES` / `PLUGIN_ICON_ASSET_PREFIX`）只给字符串，
 * 图形在这里落地：
 *
 * - 语义名（`provider` / `storage` / …）经 `Record<PluginIconName, …>` 映射到图标 facade 的组件，
 *   「白名单里的名字都有图形」在编译期成立；
 * - `/plugin-icons/xxx.png`（第三方品牌没有 Lucide 等价图形）直接当图片渲染，路径由契约校验
 *   （固定前缀、单层文件名、图片后缀），部署前缀在渲染出口经 `appPublicUrl` 补上；
 * - 未声明、未知名字或非法路径统一回退通用插件图标，不会出现空白格子。
 *
 * 新增白名单名字时这里必须同步补一条映射，否则 typecheck 失败。
 */
import type { ComponentType } from "react";
import "./plugin-icons.css";
import { isPluginIconAsset, type PluginIconName } from "@woohaa3/contracts";
import { appPublicUrl } from "../../services/app-base-path.js";
import {
  ActivityIcon,
  AgentIcon,
  AppsIcon,
  ChatIcon,
  ClapperboardIcon,
  CloudIcon,
  ConfigIcon,
  GameIcon,
  HistoryIcon,
  IdentityIcon,
  LayoutGridIcon,
  LogsIcon,
  MediaIcon,
  MigrationIcon,
  NetworkIcon,
  PerformanceIcon,
  PluginIcon,
  ProviderIcon,
  SnippetLibraryIcon,
  SparklesIcon,
  StorageIcon,
  TaskListIcon,
  ToolsIcon,
  type UiIconProps
} from "../../../shared/ui/icons.js";

/** 插件图标的组件类型：facade 的统一图标契约，consumer 只传 className / size。 */
export type PluginIconComponent = ComponentType<UiIconProps>;

export const PLUGIN_ICONS: Record<PluginIconName, PluginIconComponent> = {
  plugin: PluginIcon,
  logs: LogsIcon,
  network: NetworkIcon,
  identity: IdentityIcon,
  config: ConfigIcon,
  storage: StorageIcon,
  cloud: CloudIcon,
  media: MediaIcon,
  provider: ProviderIcon,
  generation: SparklesIcon,
  task: TaskListIcon,
  canvas: LayoutGridIcon,
  film: ClapperboardIcon,
  game: GameIcon,
  tools: ToolsIcon,
  apps: AppsIcon,
  prompt: SnippetLibraryIcon,
  activity: ActivityIcon,
  chat: ChatIcon,
  agent: AgentIcon,
  performance: PerformanceIcon,
  history: HistoryIcon,
  migration: MigrationIcon
};

/** 解析结果：语义图形（组件）或品牌图形（待补部署前缀的逻辑路径）。 */
export type PluginIconResolution =
  | { kind: "glyph"; Icon: PluginIconComponent }
  | { kind: "image"; src: string };

const FALLBACK: PluginIconResolution = { kind: "glyph", Icon: PluginIcon };

/** 解析插件声明的图标；未声明、未知名字或非法路径回退通用插件图标。 */
export function resolvePluginIcon(icon: string | undefined): PluginIconResolution {
  if (!icon) return FALLBACK;
  if (isPluginIconAsset(icon)) return { kind: "image", src: icon };
  const Icon = (PLUGIN_ICONS as Record<string, PluginIconComponent | undefined>)[icon];
  return Icon ? { kind: "glyph", Icon } : FALLBACK;
}

/**
 * 卡片与弹窗共用的图标格：语义图形渲染 facade 组件，品牌图形渲染 `<img>`（补一次部署前缀）。
 *
 * 两种取值都占同一个 30px 格子（`data-plugin-icon` 带声明值，测试与样式据此区分），因此同一行
 * 卡片不会因为有的插件用图形、有的用品牌图而参差不齐。
 */
export function PluginIconMark({ icon, size = 18, testId }: { icon: string | undefined; size?: number; testId?: string }) {
  const resolved = resolvePluginIcon(icon);
  return (
    <span
      className={resolved.kind === "image" ? "plugin-card__icon is-image" : "plugin-card__icon"}
      data-plugin-icon={icon ?? "plugin"}
      {...(testId ? { "data-testid": testId } : {})}
      aria-hidden="true"
    >
      {resolved.kind === "image" ? (
        <img className="plugin-card__icon-image" src={appPublicUrl(resolved.src)} width={30} height={30} alt="" />
      ) : (
        <resolved.Icon size={size} />
      )}
    </span>
  );
}
