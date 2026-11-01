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
  PanelLeft,
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

/**
 * 实心图标（Font Awesome 6 Solid 图形，路径内联）。
 *
 * Lucide 是**线条**风格，四喜的产品图标是**实心**（`@fortawesome/free-solid-svg-icons`，
 * 署名见 THIRD_PARTY_NOTICES.md）。两者并排一眼就能看出不是一套 —— 把字号与颜色调齐也没用，
 * 因为图形语言本身不同。需要与四喜界面并排出现的图标（画布左侧资源栏）走这一个工厂，
 * 其余宿主自己的界面继续用 Lucide，不要混着用。
 *
 * **路径是构建期从 FA 包里取的常量**，运行时不依赖 FA 包（与四喜 `src/components/icons.tsx` 同法）：
 * 宿主 workspace 没装 FA，也不该为一个图标面多装一份依赖。
 */
function makeSolidIcon(d: string, viewBoxW: number, viewBoxH: number) {
  const Wrapped = ({ size = 18, ...rest }: UiIconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={`0 0 ${viewBoxW} ${viewBoxH}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
      focusable="false"
      style={{ display: "block", flexShrink: 0, overflow: "visible", margin: "auto" }}
      {...rest}
    >
      <path fill="currentColor" d={d} />
    </svg>
  );
  Wrapped.displayName = `UiSolidIcon(${viewBoxW}x${viewBoxH})`;
  return Wrapped;
}

/* ------------------------------------------------------------------ *
 * 实心图标（Font Awesome 6 Solid，图形与四喜一致）
 * 只用于与四喜界面并排出现的图标（画布左侧资源栏）。
 * ------------------------------------------------------------------ */

export const LayerGroupSolidIcon = makeSolidIcon("M232.5 5.2c14.9-6.9 32.1-6.9 47 0l218.6 101c8.5 3.9 13.9 12.4 13.9 21.8s-5.4 17.9-13.9 21.8l-218.6 101c-14.9 6.9-32.1 6.9-47 0L13.9 149.8C5.4 145.8 0 137.3 0 128s5.4-17.9 13.9-21.8L232.5 5.2zM48.1 218.4l164.3 75.9c27.7 12.8 59.6 12.8 87.3 0l164.3-75.9 34.1 15.8c8.5 3.9 13.9 12.4 13.9 21.8s-5.4 17.9-13.9 21.8l-218.6 101c-14.9 6.9-32.1 6.9-47 0L13.9 277.8C5.4 273.8 0 265.3 0 256s5.4-17.9 13.9-21.8l34.1-15.8zM13.9 362.2l34.1-15.8 164.3 75.9c27.7 12.8 59.6 12.8 87.3 0l164.3-75.9 34.1 15.8c8.5 3.9 13.9 12.4 13.9 21.8s-5.4 17.9-13.9 21.8l-218.6 101c-14.9 6.9-32.1 6.9-47 0L13.9 405.8C5.4 401.8 0 393.3 0 384s5.4-17.9 13.9-21.8z", 512, 512);
export const CubeSolidIcon = makeSolidIcon("M224.3-2.5c19.8-11.4 44.2-11.4 64 0L464.2 99c19.8 11.4 32 32.6 32 55.4l0 203c0 22.9-12.2 44-32 55.4L288.3 514.5c-19.8 11.4-44.2 11.4-64 0L48.5 413c-19.8-11.4-32-32.6-32-55.4l0-203c0-22.9 12.2-44 32-55.4L224.3-2.5zm207.8 360l0-166.1-143.8 83 0 166.1 143.8-83z", 512, 512);
export const FolderPlusSolidIcon = makeSolidIcon("M512 384c0 35.3-28.7 64-64 64L64 448c-35.3 0-64-28.7-64-64L0 96C0 60.7 28.7 32 64 32l138.7 0c13.8 0 27.3 4.5 38.4 12.8l38.4 28.8c5.5 4.2 12.3 6.4 19.2 6.4L448 80c35.3 0 64 28.7 64 64l0 240zM256 160c-13.3 0-24 10.7-24 24l0 48-48 0c-13.3 0-24 10.7-24 24s10.7 24 24 24l48 0 0 48c0 13.3 10.7 24 24 24s24-10.7 24-24l0-48 48 0c13.3 0 24-10.7 24-24s-10.7-24-24-24l-48 0 0-48c0-13.3-10.7-24-24-24z", 512, 512);
export const ImageSolidIcon = makeSolidIcon("M64 32C28.7 32 0 60.7 0 96L0 416c0 35.3 28.7 64 64 64l320 0c35.3 0 64-28.7 64-64l0-320c0-35.3-28.7-64-64-64L64 32zm64 80a48 48 0 1 1 0 96 48 48 0 1 1 0-96zM272 224c8.4 0 16.1 4.4 20.5 11.5l88 144c4.5 7.4 4.7 16.7 .5 24.3S368.7 416 360 416L88 416c-8.9 0-17.2-5-21.3-12.9s-3.5-17.5 1.6-24.8l56-80c4.5-6.4 11.8-10.2 19.7-10.2s15.2 3.8 19.7 10.2l26.4 37.8 61.4-100.5c4.4-7.1 12.1-11.5 20.5-11.5z", 448, 512);
export const GoogleDriveSolidIcon = makeSolidIcon("M339 314.9L175.4 32 336.6 32 500.2 314.9 339 314.9zM201.5 338.5l-80.6 141.5 310.5 0 80.6-141.5-310.5 0zM154.1 67.4L0 338.5 80.6 480 237 208.8 154.1 67.4z", 512, 512);
export const PinterestSolidIcon = makeSolidIcon("M504 256c0 137-111 248-248 248-25.6 0-50.2-3.9-73.4-11.1 10.1-16.5 25.2-43.5 30.8-65 3-11.6 15.4-59 15.4-59 8.1 15.4 31.7 28.5 56.8 28.5 74.8 0 128.7-68.8 128.7-154.3 0-81.9-66.9-143.2-152.9-143.2-107 0-163.9 71.8-163.9 150.1 0 36.4 19.4 81.7 50.3 96.1 4.7 2.2 7.2 1.2 8.3-3.3 .8-3.4 5-20.3 6.9-28.1 .6-2.5 .3-4.7-1.7-7.1-10.1-12.5-18.3-35.3-18.3-56.6 0-54.7 41.4-107.6 112-107.6 60.9 0 103.6 41.5 103.6 100.9 0 67.1-33.9 113.6-78 113.6-24.3 0-42.6-20.1-36.7-44.8 7-29.5 20.5-61.3 20.5-82.6 0-19-10.2-34.9-31.4-34.9-24.9 0-44.9 25.7-44.9 60.2 0 22 7.4 36.8 7.4 36.8s-24.5 103.8-29 123.2C161.5 437.2 163.5 467.4 165.6 487 73.4 450.9 8 361.1 8 256 8 119 119 8 256 8S504 119 504 256z", 512, 512);

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
/** 侧栏：一个长方形，左侧一条竖线 —— 收起/展开侧边栏用 */
export const SidebarIcon = withDefaults(PanelLeft);
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
