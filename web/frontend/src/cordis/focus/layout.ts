/**
 * 公共聚焦布局几何
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D2/D4）。
 *
 * 唯一从画布尺寸与显式布局配置计算 contentRect 的纯函数：窗口尺寸与 narrow 策略由这里统一
 * 处理，各 editor 以**配置**表达差异（工具列宽、播放器占位、检查面板尺寸），公共层不再按
 * image/video/model 类型分支决定专用控件或占位。
 *
 * 所有控件都落在 contentRect 之外；返回的 CSS 变量由公共容器投影。
 */
import type { FocusContentRect, FocusInsets } from "./types.js";

/**
 * 插件提供的布局配置（design D2/D3）：只描述布局尺寸与开关，**不**携带 DOM 查询、
 * 第二 runtime 或类型分支。公共几何据此 + 画布尺寸计算唯一 contentRect。
 */
export type FocusLayoutConfig = {
  /** 固定桌面工具布局，不随窗口宽度将工具列与检查器移到上下。 */
  desktop?: boolean;
  /** Independent left navigation width (CSS px). */
  navigationWidth?: number;
  /** Bottom operation area height; replaces the default footer/player reserve. */
  bottomBar?: number;
  /** 是否呈现右侧（桌面）/底部（窄屏）检查面板（工具或历史）。 */
  panel?: boolean;
  /** 动画预览占位（模型编辑器子模式）。 */
  animationPreview?: boolean;
  /** 左侧竖排工具列宽度（CSS px）；缺省 0（模型编辑器使用）。 */
  toolColumn?: number;
  /** 公共标题栏下的工具选项区高度（CSS px）。 */
  toolbar?: number;
  /** 底部播放器占位高度（CSS px，或按画布宽度求值）；缺省 0（video-editor 使用）。 */
  player?: number | ((width: number) => number);
  /** 检查面板最大宽度（桌面）；缺省 320。 */
  panelMaxWidth?: number;
  /** 检查面板最大高度（窄屏）；缺省 280。 */
  panelMaxHeight?: number;
  /**
   * 顶部/底部 chrome 由谁自绘（change: 2026-10-27-add-image-history-to-photocraft-focus，design D1）。
   *
   * 缺省 `"host"`：公共布局预留标题栏与底部基座；`"workspace"`：工作区自己绘制顶部/底部
   * chrome，公共布局不再预留，contentRect 只扣面板与工具占位。该字段只影响几何计算，不回写
   * 到 layout 结果（避免与窗口 chrome 偏移混淆）。
   */
  chromeOwner?: "host" | "workspace";
  /**
   * 浮动卡片的四周留白（CSS px，2026-11-04 模型聚焦卡片外观）。
   *
   * 四边各加这么多内距，内容矩形因此缩成居中的一块「卡片」；卡片外的区域由工作区自绘画布
   * 底色，呈现「窗口浮在画布上」的观感。缺省 0 = 保持铺满，不影响其它工作区。
   *
   * 该值同时进入 `framingDistance` 的有效视口计算：内容矩形变小，模型会自动按卡片尺寸取景。
   */
  cardInset?: number;
};
/**
 * 插件提供给公共宿主的布局来源（design D3）：静态配置，或**可订阅布局快照**。
 *
 * 可订阅来源让插件把工具开关等局部状态以布局快照暴露，公共宿主在变化时重算 contentRect，
 * 无需让公共 provider 拥有各 editor 的 toolsOpen。
 */
export type FocusLayoutSource = FocusLayoutConfig | {
  get(): FocusLayoutConfig;
  subscribe(listener: () => void): () => void;
};

/**
 * 插件拥有的可订阅布局快照（design D3）。
 *
 * 让工作区把工具开关等局部布局状态（如 video 的 toolsOpen）以快照形式暴露给公共宿主，
 * 公共 provider 不拥有各 editor 的 toolsOpen，也不按类型分支。
 */
export type FocusLayoutStore = {
  get(): FocusLayoutConfig;
  subscribe(listener: () => void): () => void;
  patch(next: FocusLayoutConfig): void;
};

/** 创建可订阅布局快照；`patch` 合并字段并通知宿主重算 contentRect。 */
export function createFocusLayoutStore(initial: FocusLayoutConfig = {}): FocusLayoutStore {
  let value: FocusLayoutConfig = { ...initial };
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    patch(next) {
      value = { ...value, ...next };
      for (const listener of listeners) listener();
    }
  };
}

export type FocusLayoutInput = FocusLayoutConfig & {
  width: number;
  height: number;
};

export type FocusLayout = {
  narrow: boolean;
  rail: number;
  header: number;
  footer: number;
  /** 左侧工具列占位宽度。 */
  tools: number;
  toolbar: number;
  /** 底部播放器占位高度。 */
  player: number;
  navigationWidth: number;
  panelWidth: number;
  panelHeight: number;
  /** 浮动卡片矩形（相对画布表面）；无 `cardInset` 时即整个表面。 */
  cardRect: FocusContentRect;
  insets: FocusInsets;
  contentRect: FocusContentRect;
};

/** 连接入口已移至标题栏；保留零宽 rail 供现有 editor CSS 消费。 */
export const FOCUS_RAIL_WIDE = 0;
/** 窄屏同样不保留连接侧栏。 */
export const FOCUS_RAIL_NARROW = 0;
/** 顶部栏高度（CSS px）。 */
export const FOCUS_HEADER = 56;
/** 底部状态/播放基座高度（CSS px，不含播放器与预览占位）。 */
export const FOCUS_FOOTER_BASE = 44;
/** narrow 断点（CSS px）。 */
export const FOCUS_NARROW_BREAKPOINT = 900;

/**
 * 纯几何：由画布尺寸与显式配置计算唯一 contentRect。
 *
 * 尺寸来自画布输入表面自身，而窗口横栏（Tauri）已经在页面布局里占位、把这层表面整体下移，
 * 因此这里**不再**重复减去横栏高度：否则聚焦内容会二次下移 26px 并缩短同样高度。
 */
export function focusLayout(input: FocusLayoutInput): FocusLayout {
  const { width, height } = input;
  const narrow = !input.desktop && width < FOCUS_NARROW_BREAKPOINT;
  const rail = width < 480 ? FOCUS_RAIL_NARROW : FOCUS_RAIL_WIDE;
  // 自绘 chrome 的工作区（如图片编辑器）自己占用顶部/底部：公共层留 0，播放器/预览占位也
  // 不再由公共层扣减，否则会和工作区自绘的栏重复留白。
  const workspaceChrome = input.chromeOwner === "workspace";
  const header = workspaceChrome ? 0 : narrow ? 100 : FOCUS_HEADER;
  const player = workspaceChrome ? 0 : resolvePlayer(input.player, width);
  const footer = workspaceChrome ? 0 : input.bottomBar !== undefined ? Math.max(0, input.bottomBar) : FOCUS_FOOTER_BASE + player + (input.animationPreview ? (narrow ? 160 : 100) : 0);
  const navigationWidth = Math.max(0, input.navigationWidth ?? 0);
  const tools = Math.max(0, input.toolColumn ?? 0);
  const toolbar = Math.max(0, input.toolbar ?? 0);
  const panelMaxWidth = Math.max(0, input.panelMaxWidth ?? 320);
  const panelMaxHeight = Math.max(0, input.panelMaxHeight ?? 280);
  // 浮动卡片：整个工作区（顶栏 + 检查器 + 内容）收进一张居中卡片，卡片外由工作区自绘
  // 画布底色。留白不超过可用空间的一半，保证卡片尺寸始终为正（极小窗口也不会算出负值）。
  const cardInset = Math.max(0, input.cardInset ?? 0);
  const insetH = Math.min(cardInset, Math.max(0, width / 2 - 1));
  const insetV = Math.min(cardInset, Math.max(0, height / 2 - 1));
  // 卡片矩形（相对画布表面）。卡片内的一切——顶栏、检查器、内容区——都相对于它布局。
  const cardRect = {
    x: insetH,
    y: insetV,
    width: Math.max(1, width - insetH * 2),
    height: Math.max(1, height - insetV * 2)
  };
  const panel = input.panel ?? false;
  const panelWidth = panel && !narrow ? Math.min(panelMaxWidth, cardRect.width * 0.3) : 0;
  const panelHeight = panel && narrow
    ? Math.min(panelMaxHeight, Math.max(120, cardRect.height * 0.34), Math.max(0, cardRect.height - header - footer - tools - 96))
    : 0;
  // 内容矩形 = 卡片矩形扣掉卡片内的顶栏/工具/检查器/底栏占位。
  const innerLeft = rail + navigationWidth + (narrow ? 0 : tools);
  const innerRight = rail + panelWidth;
  const innerTop = header + toolbar + (narrow ? tools : 0);
  const innerBottom = footer + panelHeight;
  const insets: FocusInsets = {
    left: cardRect.x + innerLeft,
    right: cardRect.x + innerRight,
    top: cardRect.y + innerTop,
    bottom: cardRect.y + innerBottom
  };
  return {
    narrow, rail, header, footer, tools, toolbar, player, navigationWidth, panelWidth, panelHeight, cardRect, insets,
    contentRect: {
      x: insets.left, y: insets.top,
      width: Math.max(1, cardRect.width - innerLeft - innerRight),
      height: Math.max(1, cardRect.height - innerTop - innerBottom)
    }
  };
}

function resolvePlayer(player: FocusLayoutInput["player"], width: number): number {
  if (player === undefined) return 0;
  const value = typeof player === "function" ? player(width) : player;
  return Number.isFinite(value) && value > 0 ? value : 0;
}
