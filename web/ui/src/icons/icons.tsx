/**
 * Lucide icon facade（allowlist）
 * （change: adopt-radix-lucide-canvas-ui，任务 2.6 / design D5）。
 *
 * 生产 UI MUST 从本模块具名 import 通用操作图标，不得直接依赖 `lucide-react`。
 * 本模块统一默认 `size`、`strokeWidth`、`absoluteStrokeWidth`、`currentColor` 与
 * `aria-hidden`，使各 consumer 得到一致的 stroke/viewBox/可访问属性；Vite 可 tree-shake
 * 未使用图标（禁止 `import * as` namespace import）。
 *
 * 产品专有图形（Lucide 无等价语义）记录在文件末尾 `CUSTOM_ICON_EXCEPTIONS`，由架构审计
 * 锁定；不得用于复制已有 Lucide 通用操作图标。
 */
import {
  Activity,
  AppWindow,

  AlignHorizontalJustifyStart,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  Move,
  MousePointer2,
  RotateCcw,
  Scaling,
  Orbit,
  MoveVertical,
  LockKeyhole,
  Crop,
  Eye,
  EyeOff,
  FolderPlus,
  Lasso,
  Layers,
  ScanLine,
  Scan,
  SquareDashed,
  CircleDashed,
  Type,
  ArrowLeft,
  ArrowRightLeft,
  ArrowLeftRight,
  Link,
  Unlink,
  Ban,
  Bot,
  Box,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleSlash,
  Clapperboard,
  Clock,
  ClockArrowLeft,
  Cloud,
  Copy,
  CornerDownRight,
  Crosshair,
  Database,
  Diamond,
  Download,
  Ellipsis,
  Eraser,
  FileImage,
  FileText,
  Film,
  Gamepad2,
  Gauge,
  History,
  Hourglass,
  Hand,
  Image,
  Images,
  LayoutGrid,
  Library,
  List,
  ListChecks,
  LoaderCircle,
  Map,
  Maximize,
  Maximize2,
  Menu,
  MessagesSquare,
  Minimize2,
  Minus,
  Moon,
  Music,
  Network,
  PanelTop,
  Pause,
  PenLine,
  Play,
  Plus,
  Puzzle,
  Redo2,
  RefreshCw,
  RectangleHorizontal,
  ScrollText,
  Search,
  Send,
  Settings,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash,
  Undo2,
  Upload,
  Video,
  Volume2,
  VolumeX,
  WandSparkles,
  Wrench,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon
} from "lucide-react";
import type { SVGProps } from "react";

/** 允许保留的产品专有图形（Lucide 无等价语义）；审计据此放行。 */
export const CUSTOM_ICON_EXCEPTIONS: readonly string[] = [
  // Woohaa3 产品标记：无 Lucide 等价图形，保留于 Showcase 壳层自定义图形。
  "WoohaaBrandMark"
];

/** 统一图标契约：默认 stroke/size/currentColor，consumer 只需传 className。 */
export type UiIconProps = Omit<SVGProps<SVGSVGElement>, "ref"> & {
  size?: number | string;
  strokeWidth?: number | string;
  absoluteStrokeWidth?: boolean;
};

/** 应用统一默认值（业务可显式覆盖 size/absoluteStrokeWidth 等）。 */
function withDefaults(Icon: LucideIcon) {
  const Wrapped = ({ size = 18, strokeWidth = 2, absoluteStrokeWidth = false, ...rest }: UiIconProps) => (
    <Icon size={size} strokeWidth={strokeWidth} absoluteStrokeWidth={absoluteStrokeWidth} {...rest} />
  );
  Wrapped.displayName = `UiIcon(${Icon.displayName ?? Icon.name ?? "icon"})`;
  return Wrapped;
}

/* ------------------------------------------------------------------ *
 * 通用操作图标 allowlist（首批迁移消费方）
 * ------------------------------------------------------------------ */

// 缩放 / 适合屏幕（Canvas Zoom Controls、MediaDialog）
export const ZoomInIcon = withDefaults(ZoomIn);
export const ZoomOutIcon = withDefaults(ZoomOut);
export const FitScreenIcon = withDefaults(Maximize);

// 关闭 / 复制 / 确认
export const CloseIcon = withDefaults(X);
export const CopyIcon = withDefaults(Copy);
export const RestoreWindowIcon = withDefaults(Copy);
export const CheckIcon = withDefaults(Check);

// 媒体播放
export const PlayIcon = withDefaults(Play);
export const PauseIcon = withDefaults(Pause);
export const MuteIcon = withDefaults(VolumeX);
export const VolumeIcon = withDefaults(Volume2);
export const TrashIcon = withDefaults(Trash);

// 画布 chrome
export const CanvasSwitcherIcon = withDefaults(PanelTop);
export const ChevronDownIcon = withDefaults(ChevronDown);
export const ChevronRightIcon = withDefaults(ChevronRight);
export const MenuIcon = withDefaults(Menu);
export const MenuListIcon = withDefaults(List);
export const LocateIcon = withDefaults(Crosshair);
/** 小地图开关（概览区显隐，2026-10-26）。 */
export const MapIcon = withDefaults(Map);
export const BackIcon = withDefaults(ArrowLeft);
export const GenerationHistoryIcon = withDefaults(ClockArrowLeft);
export const SnippetLibraryIcon = withDefaults(Library);
/** 更多操作（省略号）。 */
export const EllipsisIcon = withDefaults(Ellipsis);

/** 快捷改写 / AI 润色入口（魔法棒 + 星芒）。 */
export const WandSparklesIcon = withDefaults(WandSparkles);

// 状态 / 反馈
export const LoadingIcon = withDefaults(LoaderCircle);
export const PlusIcon = withDefaults(Plus);
export const MinusIcon = withDefaults(Minus);

// 执行面板（change: adopt-radix-remaining-canvas-ui）
export const ExpandIcon = withDefaults(Maximize2);
export const CollapseIcon = withDefaults(Minimize2);
export const DiamondIcon = withDefaults(Diamond);
/** 发送/执行（Lucide Send；产品专有实心纸飞机见 CUSTOM_ICON_EXCEPTIONS）。 */
export const SendIcon = withDefaults(Send);

// 视频编辑标注工具
export const HandIcon = withDefaults(Hand);
export const PenIcon = withDefaults(PenLine);
export const RectangleIcon = withDefaults(RectangleHorizontal);
export const UndoIcon = withDefaults(Undo2);
export const RedoIcon = withDefaults(Redo2);
export const EraserIcon = withDefaults(Eraser);

// 参考素材 tile / 状态
export const VideoIcon = withDefaults(Video);
export const HourglassIcon = withDefaults(Hourglass);
export const InvalidIcon = withDefaults(CircleSlash);
export const UnavailableIcon = withDefaults(Ban);
export const WarningIcon = withDefaults(CircleAlert);
export const ClockIcon = withDefaults(Clock);

// 刷新（插件管理的「回到画布并应用」等）
export const RefreshIcon = withDefaults(RefreshCw);
export const SwapColorsIcon = withDefaults(ArrowLeftRight);
export const LinkIcon = withDefaults(Link);
export const UnlinkIcon = withDefaults(Unlink);

// Showcase 壳层（生产 facade 也供 Showcase 消费）
export const SunIcon = withDefaults(Sun);
export const MoonIcon = withDefaults(Moon);
export const SearchIcon = withDefaults(Search);
export const SettingsIcon = withDefaults(Settings2);
export const AppSettingsIcon = withDefaults(Settings);
export const SparklesIcon = withDefaults(Sparkles);
export const ActivityIcon = withDefaults(Activity);
export const FileImageIcon = withDefaults(FileImage);
export const FileTextIcon = withDefaults(FileText);
export const FilmIcon = withDefaults(Film);
export const MusicIcon = withDefaults(Music);
export const LayoutGridIcon = withDefaults(LayoutGrid);
export const ImageIcon = withDefaults(Image);

/** 下载（节点操作横条「下载」；change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.2）。 */
export const DownloadIcon = withDefaults(Download);

/** 上传（空白画布右键菜单「上传…」）。 */
export const UploadIcon = withDefaults(Upload);

/* ------------------------------------------------------------------ *
 * 插件图标（设置页「插件配置」按 `PLUGIN_ICON_NAMES` 白名单解析）
 * 名字进契约、图形留前端：映射写在 cordis/plugins/settings/plugin-icons.tsx。
 * ------------------------------------------------------------------ */

/** 通用插件（未声明 icon 时的兜底）。 */
export const PluginIcon = withDefaults(Puzzle);
/** 日志出口。 */
export const LogsIcon = withDefaults(ScrollText);
/** 网关 / 网络入口。 */
export const NetworkIcon = withDefaults(Network);
/** 身份与访问。 */
export const IdentityIcon = withDefaults(ShieldCheck);
/** 配置。 */
export const ConfigIcon = withDefaults(SlidersHorizontal);
/** 存储后端。 */
export const StorageIcon = withDefaults(Database);
/** 云端对象存储。 */
export const CloudIcon = withDefaults(Cloud);
/** 媒体与素材。 */
export const MediaIcon = withDefaults(Images);
/** 3D 模型/立方体。 */
export const BoxIcon = withDefaults(Box);
/** 生成 Provider。 */
export const ProviderIcon = withDefaults(Boxes);
/** 任务编排。 */
export const TaskListIcon = withDefaults(ListChecks);
/** 片场 / 影片。 */
export const ClapperboardIcon = withDefaults(Clapperboard);
/** 游戏生成。 */
export const GameIcon = withDefaults(Gamepad2);
/** MCP 与工具授权。 */
export const ToolsIcon = withDefaults(Wrench);
/** 应用与站点插件宿主。 */
export const AppsIcon = withDefaults(AppWindow);
/** 对话类扩展。 */
export const ChatIcon = withDefaults(MessagesSquare);
/** Agent 来源与运行时。 */
export const AgentIcon = withDefaults(Bot);
/** 开发性能读数。 */
export const PerformanceIcon = withDefaults(Gauge);
/** 历史与撤销。 */
export const HistoryIcon = withDefaults(History);
/** 数据迁移与导入。 */
export const MigrationIcon = withDefaults(ArrowRightLeft);

/** 画幅「自适应」（执行面板比例选择器左侧的四角取景框）。 */
export const AdaptiveRatioIcon = withDefaults(Scan);

/** 原始 Lucide 类型（供 primitive 层内部使用）。 */
export type { LucideIcon };

// 图片编辑工具与图层。
export const CropIcon = withDefaults(Crop);
export const EyeIcon = withDefaults(Eye);
export const EyeOffIcon = withDefaults(EyeOff);
export const FolderPlusIcon = withDefaults(FolderPlus);
export const LassoIcon = withDefaults(Lasso);
export const LayersIcon = withDefaults(Layers);
export const MaskIcon = withDefaults(ScanLine);
export const AdjustmentIcon = withDefaults(SlidersHorizontal);
export const MarqueeIcon = withDefaults(SquareDashed);
export const EllipseMarqueeIcon = withDefaults(CircleDashed);
export const TypeIcon = withDefaults(Type);

export const MoveIcon = withDefaults(Move);
export const PointerIcon = withDefaults(MousePointer2);
export const RotateIcon = withDefaults(RotateCcw);
export const ScaleIcon = withDefaults(Scaling);
export const OrbitIcon = withDefaults(Orbit);
export const ElevationIcon = withDefaults(MoveVertical);
export const LockIcon = withDefaults(LockKeyhole);

// 对象对齐
export const AlignLeftIcon = withDefaults(AlignHorizontalJustifyStart);
export const AlignCenterXIcon = withDefaults(AlignHorizontalJustifyCenter);
export const AlignRightIcon = withDefaults(AlignHorizontalJustifyEnd);
export const AlignTopIcon = withDefaults(AlignVerticalJustifyStart);
export const AlignCenterYIcon = withDefaults(AlignVerticalJustifyCenter);
export const AlignBottomIcon = withDefaults(AlignVerticalJustifyEnd);

/** 图层剪贴到下方基底。 */
export const ClippingMaskIcon = withDefaults(CornerDownRight);
