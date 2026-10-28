/**
 * 插件图标：语义图形名（白名单）或随应用发布的品牌图形路径（跨运行单元的纯词汇表）。
 *
 * 插件在图标的**声明面**只给一个字符串：宿主内置插件在 `host/inventory.ts` 的表里，扩展在
 * `ExtensionPlugin.icon`、`ExtensionFrontendMetadata.icon` 或后端扩展的
 * `extension.json` → `icon.glyph`。两种取值：
 *
 * - `PLUGIN_ICON_NAMES` 里的语义名（`provider` / `storage` / …），由前端
 *   `cordis/plugins/settings/plugin-icons.tsx` 映射到 `shared/ui` 图标 facade 的图形；
 * - `PLUGIN_ICON_ASSET_PREFIX` 下的品牌图形路径（`/plugin-icons/litellm.png`）：第三方品牌没有
 *   Lucide 等价图形，直接放一张随应用发布的 PNG / SVG。
 *
 * 名字进契约、图形留前端，有两个原因：宿主不依赖渲染层（backend 不 import React），插件也塞不进
 * 任意 URL——品牌图形只允许站内固定前缀下的路径，不接受 `http(s):`、协议相对地址与目录穿越。
 * 未声明、未知名字或非法路径一律回退到通用插件图标。
 *
 * 没有浏览器前端的后端扩展（存储槽位、迁移工具等）在 `extension.json` 的 `icon.glyph` 里声明
 * 语义名；宿主只把它透传给插件清单，图形仍由前端按同一份白名单解析。
 */
export const PLUGIN_ICON_NAMES = [
  /** 通用插件（未声明图标时的兜底）。 */
  "plugin",
  /** 结构化日志出口。 */
  "logs",
  /** HTTP / WebSocket 网关。 */
  "network",
  /** 身份与访问控制。 */
  "identity",
  /** 配置文件与设置面。 */
  "config",
  /** 存储后端（本地 / 对象存储）。 */
  "storage",
  /** 云端对象存储。 */
  "cloud",
  /** 媒体与素材。 */
  "media",
  /** 生成能力与模型 Provider。 */
  "provider",
  /** 生成运行时。 */
  "generation",
  /** 任务编排与历史。 */
  "task",
  /** 画布与场景。 */
  "canvas",
  /** 片场 / 影片。 */
  "film",
  /** 游戏生成。 */
  "game",
  /** MCP 与工具授权。 */
  "tools",
  /** 应用与站点插件宿主。 */
  "apps",
  /** 提示词片段库。 */
  "prompt",
  /** 任务动态。 */
  "activity",
  /** 对话类扩展。 */
  "chat",
  /** Agent 来源与运行时（本机 Agent / SDK / OAuth 授权）。 */
  "agent",
  /** 开发性能读数（FPS / Draw Call 等）。 */
  "performance",
  /** 历史与撤销。 */
  "history",
  /** 数据迁移与导入。 */
  "migration"
] as const;

export type PluginIconName = (typeof PLUGIN_ICON_NAMES)[number];

/** 判定一个未知值是否是白名单里的图标名（解码外部 metadata 时用）。 */
export function isPluginIconName(value: unknown): value is PluginIconName {
  return typeof value === "string" && (PLUGIN_ICON_NAMES as readonly string[]).includes(value);
}

/**
 * 品牌图形的固定同源前缀。文件随前端静态资源一起发布（`web/frontend/public/plugin-icons/`），
 * 部署前缀由 `appPublicUrl` 在渲染出口补上，声明面始终是这条逻辑路径。
 */
export const PLUGIN_ICON_ASSET_PREFIX = "/plugin-icons/";

/** 品牌图形路径（固定前缀下的站点内路径，如 `/plugin-icons/litellm.png`）。 */
export type PluginIconAsset = `${typeof PLUGIN_ICON_ASSET_PREFIX}${string}`;

/** 插件图标：语义图形名或品牌图形路径。 */
export type PluginIcon = PluginIconName | PluginIconAsset;

/**
 * 品牌图形路径：只接受固定前缀 + 单层文件名 + 图片后缀。
 *
 * 排除 `/plugin-icons/../x.png`（目录穿越）、`//evil/x.png`（协议相对）、`http(s):`、`data:` 与
 * 查询串——正则里除文件名段外不允许其他字符。
 */
const PLUGIN_ICON_ASSET_PATTERN = /^\/plugin-icons\/[A-Za-z0-9][A-Za-z0-9._-]*\.(png|svg|webp|jpe?g)$/;

export function isPluginIconAsset(value: unknown): value is PluginIconAsset {
  return typeof value === "string" && PLUGIN_ICON_ASSET_PATTERN.test(value);
}

/** 判定一个未知值是否是合法的插件图标（语义名或品牌图形路径）。 */
export function isPluginIcon(value: unknown): value is PluginIcon {
  return isPluginIconName(value) || isPluginIconAsset(value);
}
