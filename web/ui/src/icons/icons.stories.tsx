import type { StoryDefault } from "@ladle/react";
import { ZoomInIcon, ZoomOutIcon, FitScreenIcon, CloseIcon, CopyIcon, RestoreWindowIcon, CheckIcon, PlayIcon, PauseIcon, MuteIcon, VolumeIcon, TrashIcon, CanvasSwitcherIcon, ChevronDownIcon, ChevronRightIcon, MenuIcon, MenuListIcon, LocateIcon, MapIcon, BackIcon, GenerationHistoryIcon, SnippetLibraryIcon, EllipsisIcon, WandSparklesIcon, LoadingIcon, PlusIcon, MinusIcon, ExpandIcon, CollapseIcon, DiamondIcon, SendIcon, HandIcon, PenIcon, RectangleIcon, UndoIcon, RedoIcon, EraserIcon, VideoIcon, HourglassIcon, InvalidIcon, UnavailableIcon, WarningIcon, ClockIcon, RefreshIcon, SwapColorsIcon, LinkIcon, UnlinkIcon, SunIcon, MoonIcon, SearchIcon, SettingsIcon, AppSettingsIcon, SparklesIcon, ActivityIcon, FileImageIcon, FileTextIcon, FilmIcon, MusicIcon, LayoutGridIcon, ImageIcon, DownloadIcon, PluginIcon, LogsIcon, NetworkIcon, IdentityIcon, ConfigIcon, StorageIcon, CloudIcon, MediaIcon, ProviderIcon, TaskListIcon, ClapperboardIcon, GameIcon, ToolsIcon, AppsIcon, ChatIcon, AgentIcon, PerformanceIcon, HistoryIcon, MigrationIcon, AdaptiveRatioIcon, CropIcon, EyeIcon, EyeOffIcon, FolderPlusIcon, LassoIcon, LayersIcon, MaskIcon, AdjustmentIcon, MarqueeIcon, EllipseMarqueeIcon, TypeIcon, MoveIcon, LockIcon, AlignLeftIcon, AlignCenterXIcon, AlignRightIcon, AlignTopIcon, AlignCenterYIcon, AlignBottomIcon, ClippingMaskIcon, ServiceLogo, McpClientLogo } from "./index.js";
export default { title: "公共 UI/图标与 Logo" } satisfies StoryDefault;
export function Catalog() {
  const icons = { ZoomInIcon, ZoomOutIcon, FitScreenIcon, CloseIcon, CopyIcon, RestoreWindowIcon, CheckIcon, PlayIcon, PauseIcon, MuteIcon, VolumeIcon, TrashIcon, CanvasSwitcherIcon, ChevronDownIcon, ChevronRightIcon, MenuIcon, MenuListIcon, LocateIcon, MapIcon, BackIcon, GenerationHistoryIcon, SnippetLibraryIcon, EllipsisIcon, WandSparklesIcon, LoadingIcon, PlusIcon, MinusIcon, ExpandIcon, CollapseIcon, DiamondIcon, SendIcon, HandIcon, PenIcon, RectangleIcon, UndoIcon, RedoIcon, EraserIcon, VideoIcon, HourglassIcon, InvalidIcon, UnavailableIcon, WarningIcon, ClockIcon, RefreshIcon, SwapColorsIcon, LinkIcon, UnlinkIcon, SunIcon, MoonIcon, SearchIcon, SettingsIcon, AppSettingsIcon, SparklesIcon, ActivityIcon, FileImageIcon, FileTextIcon, FilmIcon, MusicIcon, LayoutGridIcon, ImageIcon, DownloadIcon, PluginIcon, LogsIcon, NetworkIcon, IdentityIcon, ConfigIcon, StorageIcon, CloudIcon, MediaIcon, ProviderIcon, TaskListIcon, ClapperboardIcon, GameIcon, ToolsIcon, AppsIcon, ChatIcon, AgentIcon, PerformanceIcon, HistoryIcon, MigrationIcon, AdaptiveRatioIcon, CropIcon, EyeIcon, EyeOffIcon, FolderPlusIcon, LassoIcon, LayersIcon, MaskIcon, AdjustmentIcon, MarqueeIcon, EllipseMarqueeIcon, TypeIcon, MoveIcon, LockIcon, AlignLeftIcon, AlignCenterXIcon, AlignRightIcon, AlignTopIcon, AlignCenterYIcon, AlignBottomIcon, ClippingMaskIcon };
  return <section style={{ display: "flex", flexWrap: "wrap", gap: 20, maxWidth: 860 }}>
    {Object.entries(icons).map(([name, Icon]) => <figure key={name} style={{ width: 120, margin: 0 }}><Icon size={24} /><figcaption>{name}</figcaption></figure>)}
    {["openai", "anthropic", "unknown"].map(service => <figure key={service}><ServiceLogo service={service} /><figcaption>{service}</figcaption></figure>)}
    {["claude-code", "cursor", "unknown"].map(client => <figure key={client}><McpClientLogo client={client} /><figcaption>{client}</figcaption></figure>)}
    <p>服务/MCP 标记归属与许可证见包内 ServiceLogo.LICENSE.md。</p>
  </section>;
}

/** 未知标识：服务 Logo 返回 null 由调用方回退文字；MCP 客户端回退通用图标。 */
export function UnknownFallback() {
  return <section style={{ display: "grid", gap: 12, maxWidth: 860 }}>
    {["openai", "codex-appserver", "unknown-service"].map(service => <div key={service} className="showcase__row">
      <code>{service}</code>
      {service === "unknown-service" ? <span>（无品牌图形，回退服务名）</span> : <ServiceLogo service={service} />}
    </div>)}
    {["claude-code", "unknown-client"].map(client => <div key={client} className="showcase__row">
      <code>{client}</code><McpClientLogo client={client} />
    </div>)}
  </section>;
}

/** 尺寸：16/20/28/32 的 Logo 与 16/24/32 的图标，保持同一视觉重量。 */
export function Sizes() {
  return <section style={{ display: "grid", gap: 16, maxWidth: 860 }}>
    <div className="showcase__row">{([16, 20, 28, 32] as const).map(size => <ServiceLogo key={size} service="anthropic" size={size} />)}</div>
    <div className="showcase__row">{([16, 20, 28, 32] as const).map(size => <McpClientLogo key={size} client="claude-code" size={size} />)}</div>
    <div className="showcase__row">{([16, 24, 32] as const).map(size => <SettingsIcon key={size} size={size} />)}</div>
  </section>;
}
