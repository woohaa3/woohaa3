/**
 * 编辑器工具参数与画布坐标映射（纯函数）
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 3.4/3.5/3.6 / design D1/D3）。
 *
 * 界面是我们自己的 React 组件，工具手势发生在自己的 DOM 画布上（不是命中测试：画布只把指针
 * 位置换算成文档坐标，选层与移动由内核受控接口处理）。本模块把界面状态编译成
 * 内核命令参数，并把屏幕坐标换算成文档坐标——全部是纯函数，可在无浏览器环境下回归。
 *
 * 参数形状直接取自上游命令注册表（`crates/engine/src/{commands,brush_cmds,adjust_params}.rs`）：
 * - `select.rect` `{x,y,width,height,mode,ellipse,line,antiAlias,feather}`
 * - `select.lasso` `{points:[[x,y],…]}`（至少 3 点）
 * - `select.modify.feather` `{radius}`
 * - `paint.stroke` `{points:[[x,y],…],size,hardness,opacity,flow,spacing,color,mode,erase,smoothing,zoom,target}`
 * - `type.create` `{x,y,text,size,color,align,font?,bold?}`
 * - `layer.newAdjustmentLayer.brightnessContrast|hueSaturation` `{brightness,contrast}` / `{hue,saturation,lightness}`
 */
import { IMAGE_PROJECT_LIMITS } from "@woohaa3/photocraft-protocol";

/** 首期画布工具。 */
export type EditorToolId = "none" | "pan" | "zoom" | "bucket" | "pencil" | "eyedropper" | "move" | "marquee" | "lasso" | "magicWand" | "brush" | "eraser" | "retouch" | "text";

/** 选区运算方式（与内核 `mode` 取值一致）。 */
export type SelectionMode = "replace" | "add" | "subtract" | "intersect";

/** 文档坐标下的像素矩形。 */
export type PixelRect = { x: number; y: number; width: number; height: number };

/** 文档坐标点。 */
export type DocumentPoint = { x: number; y: number; pressure?: number };

/** Shift 移动吸附到四/八方向，越过分界线 8° 后才切换，避免对角附近抖动。 */
export function constrainMoveOffset(offset:DocumentPoint,previous:DocumentPoint|null,directions:4|8):DocumentPoint {
  if(!Number.isFinite(offset.x) || !Number.isFinite(offset.y) || Math.hypot(offset.x,offset.y)===0) return offset;
  const step=Math.PI*2/directions,angle=Math.atan2(offset.y,offset.x);
  let direction=Math.round(angle/step);
  if(previous && Math.hypot(previous.x,previous.y)>0) {
    const last=Math.round(Math.atan2(previous.y,previous.x)/step);
    const difference=Math.abs(Math.atan2(Math.sin(angle-last*step),Math.cos(angle-last*step)));
    if(difference<step/2+8*Math.PI/180) direction=last;
  }
  const x=Math.cos(direction*step),y=Math.sin(direction*step),distance=Math.max(0,offset.x*x+offset.y*y);
  const clean=(value:number)=>Math.abs(value)<1e-9 ? 0 : value;
  return {x:clean(distance*x),y:clean(distance*y)};
}

/** 对掩码边界做奇偶射线判定，支持不相连选区和减选形成的孔洞。 */
export function pointInSelection(point: DocumentPoint, segments: readonly (readonly number[])[]): boolean {
  let inside = false;
  for (const [x0, y0, x1, y1] of segments) {
    const cross = (point.x - x0) * (y1 - y0) - (point.y - y0) * (x1 - x0);
    if (Math.abs(cross) < 1e-6 && point.x >= Math.min(x0, x1) && point.x <= Math.max(x0, x1)
      && point.y >= Math.min(y0, y1) && point.y <= Math.max(y0, y1)) return true;
    if ((y0 > point.y) !== (y1 > point.y) && point.x < x0 + (point.y - y0) * (x1 - x0) / (y1 - y0)) inside = !inside;
  }
  return inside;
}

/** 笔刷设置（首期范围见 notes/scope.md）。 */
export type BrushSettings = {
  angle?:number;
  autoErase?:boolean;
  eraserMode?:"brush"|"pencil"|"block";
  /** 会话级画笔混合模式，不是图层混合模式。 */
  mode?:string;
  /** 笔头尺寸（源像素），1–512。 */
  size: number;
  /** 硬度 0–1。 */
  hardness: number;
  /** 不透明度 0–1。 */
  opacity: number;
  /** Flow 0–1。 */
  flow: number;
  /** 基础平滑 0–1。 */
  smoothing: number;
  /** 前景色 `#rrggbb`。 */
  color: string;
  /** 作用目标：像素层或蒙版。 */
  target: "pixels" | "mask";
};

/** 默认笔刷：小尺寸、硬边、满不透明度，作用于像素层。 */
export const DEFAULT_BRUSH: BrushSettings = {
  size: 24,
  hardness: 0.8,
  opacity: 1,
  flow: 1,
  smoothing: 0.2,
  color: "#000000",
  target: "pixels"
};

/** 画布视图：使用共享取景换算的图片客户矩形反映射。 */
export type CanvasViewport = {
  /** 图片在当前聚焦取景下的客户坐标左/上/宽/高。 */
  left: number;
  top: number;
  width: number;
  height: number;
  /** 文档尺寸（画布坐标 = 文档像素）。 */
  documentWidth: number;
  documentHeight: number;
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function roundPixel(value: number): number {
  return Math.round(value);
}

/** 笔头尺寸钳制到首期公开范围。 */
export function clampBrushSize(size: number): number {
  return clamp(size, IMAGE_PROJECT_LIMITS.minBrushSizeSourcePixels, IMAGE_PROJECT_LIMITS.maxBrushSizeSourcePixels);
}

/** 羽化半径钳制到首期公开范围（0–100 源像素）。 */
export function clampFeather(radius: number): number {
  return clamp(radius, 0, IMAGE_PROJECT_LIMITS.maxFeatherSourcePixels);
}

/** 归一化拖拽框：任意方向的起止点都得到左上原点 + 正尺寸。 */
export function normalizeMarquee(start: DocumentPoint, end: DocumentPoint): PixelRect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x: roundPixel(x),
    y: roundPixel(y),
    width: Math.max(0, roundPixel(Math.abs(end.x - start.x))),
    height: Math.max(0, roundPixel(Math.abs(end.y - start.y)))
  };
}

/**
 * 屏幕（`clientX`/`clientY`）→ 文档坐标。
 *
 * 用画布元素的**变换后**客户矩形做线性反映射：`文档尺寸 / 客户矩形尺寸` 即总比例，因此不必
 * 关心 CSS 缩放/平移/变换原点。选区默认钳制；绘画传入 false 保留图外采样，避免将路径压到边缘。
 * 元素未布局（宽或高为 0）或输入非有限数时返回 `null`
 * （不做静默 0 值）。
 */
export function screenToDocument(clientX: number, clientY: number, viewport: CanvasViewport, constrain = true): DocumentPoint | null {
  const { left, top, width, height, documentWidth, documentHeight } = viewport;
  if (![clientX, clientY, left, top, width, height, documentWidth, documentHeight].every(Number.isFinite)
    || width <= 0 || height <= 0 || documentWidth <= 0 || documentHeight <= 0) return null;
  const x = ((clientX - left) / width) * documentWidth;
  const y = ((clientY - top) / height) * documentHeight;
  return {
    x: constrain ? clamp(x, 0, documentWidth) : x,
    y: constrain ? clamp(y, 0, documentHeight) : y
  };
}

/** `select.rect` 参数。 */
export function buildRectSelection(
  rect: PixelRect,
  options: { mode?: SelectionMode; ellipse?: boolean; line?: "row"|"column"; feather?: number } = {}
): Record<string, unknown> {
  return {
    x: roundPixel(rect.x),
    y: roundPixel(rect.y),
    width: Math.max(0, roundPixel(rect.width)),
    height: Math.max(0, roundPixel(rect.height)),
    mode: options.mode ?? "replace",
    ellipse: options.line ? false : options.ellipse ?? false,
    ...(options.line ? {line:options.line} : {}),
    antiAlias: true,
    feather: clampFeather(options.feather ?? 0)
  };
}

/** `select.modify.feather` 参数。 */
export function buildFeather(radius: number): Record<string, unknown> {
  return { radius: clampFeather(radius) };
}

/** 选框维护命令的公开半径范围；与固定引擎注册表一致。 */
export const SELECTION_MODIFY_RANGES = {
  "select.modify.border": { min: 1, max: 200, label: "边框宽度" },
  "select.modify.smooth": { min: 1, max: 500, label: "平滑半径" },
  "select.modify.expand": { min: 1, max: 500, label: "扩展量" },
  "select.modify.contract": { min: 1, max: 500, label: "收缩量" }
} as const;
export type SelectionModifyId = keyof typeof SELECTION_MODIFY_RANGES;

export function clampSelectionRadius(id: SelectionModifyId, radius: number): number {
  const range = SELECTION_MODIFY_RANGES[id];
  if (!Number.isFinite(radius)) return range.min;
  return Math.round(Math.min(range.max, Math.max(range.min, radius)));
}

/** `select.modify.border|smooth|expand|contract` 参数。 */
export function buildSelectionModify(id: SelectionModifyId, radius: number): Record<string, unknown> {
  return { radius: clampSelectionRadius(id, radius) };
}

/** 魔棒设置属于本机工具记忆；参数边界与原生注册表一致。 */
export type MagicWandSettings = { tolerance: number; antialias: boolean; contiguous: boolean; sampleAllLayers: boolean };
export const DEFAULT_MAGIC_WAND: MagicWandSettings = { tolerance: 32, antialias: true, contiguous: true, sampleAllLayers: false };
export function buildMagicWand(point: DocumentPoint, settings: MagicWandSettings, mode: SelectionMode): Record<string, unknown> {
  return {
    x: roundPixel(point.x), y: roundPixel(point.y),
    tolerance: Math.round(clamp(settings.tolerance, 0, 255)),
    antiAlias: settings.antialias, contiguous: settings.contiguous,
    sampleAllLayers: settings.sampleAllLayers, mode
  };
}

/** 颜色范围预置；`sampledColors` 使用取样颜色，色调预设使用固定明度范围。 */
export const COLOR_RANGE_SELECTIONS = [
  ["sampledColors", "取样颜色"], ["reds", "红色"], ["yellows", "黄色"], ["greens", "绿色"],
  ["cyans", "青色"], ["blues", "蓝色"], ["magentas", "洋红"], ["highlights", "高光"],
  ["midtones", "中间调"], ["shadows", "阴影"], ["skinTones", "肤色"], ["outOfGamut", "溢色"]
] as const;
export type ColorRangeSelection = (typeof COLOR_RANGE_SELECTIONS)[number][0];
export type ColorRangeSettings = {
  select: ColorRangeSelection; color: string; fuzziness: number;
  localized: boolean; range: number; invert: boolean; sampleAllLayers: boolean; mode: SelectionMode;
  /**
   * 画布取色取样点（I269）：`points` 加到取样集合、`subtractPoints` 从集合里减去。
   * 位置是文档像素；由画布点击收集，命令只读取样并生成选区。
   */
  points?: readonly [number, number][];
  subtractPoints?: readonly [number, number][];
};
export const DEFAULT_COLOR_RANGE: ColorRangeSettings = { select: "sampledColors", color: "#ff0000", fuzziness: 40, localized: false, range: 100, invert: false, sampleAllLayers: true, mode: "replace" };

/** `select.colorRange` 参数：取样颜色来自显式颜色字段，不读取 DOM 或隐藏状态。 */
export function buildColorRange(settings: ColorRangeSettings): Record<string, unknown> {
  const tonal = !["sampledColors", "outOfGamut"].includes(settings.select);
  return {
    select: settings.select,
    ...(settings.select === "sampledColors" ? { color: settings.color, fuzziness: Math.round(clamp(settings.fuzziness, 0, 200)) } : {}),
    ...(tonal ? { fuzziness: Math.round(clamp(settings.fuzziness, 0, 100)) } : {}),
    ...(settings.select === "sampledColors" && settings.localized ? { localized: true, range: Math.round(clamp(settings.range, 0, 100)) } : {}),
    // 画布取样点只对「取样颜色」有意义；空数组不下发，避免把「没点过」当成显式空集合。
    ...(settings.select === "sampledColors" && settings.points?.length ? { points: settings.points.map(point => [roundPixel(point[0]), roundPixel(point[1])]) } : {}),
    ...(settings.select === "sampledColors" && settings.subtractPoints?.length ? { subtractPoints: settings.subtractPoints.map(point => [roundPixel(point[0]), roundPixel(point[1])]) } : {}),
    invert: settings.invert, sampleAllLayers: settings.sampleAllLayers, mode: settings.mode
  };
}

/** 套索至少需要 3 个点；不足时返回 `null`（调用方不提交半截手势）。 */
export function buildLasso(
  points: readonly DocumentPoint[],
  options: { mode?: SelectionMode; feather?: number } = {}
): Record<string, unknown> | null {
  if (points.length < 3) return null;
  return {
    points: points.map((point) => [roundPixel(point.x), roundPixel(point.y)]),
    mode: options.mode ?? "replace",
    feather: clampFeather(options.feather ?? 0)
  };
}

/** 开始与增量采样共用编码，保留笔压。 */
export function strokePoints(points: readonly DocumentPoint[], preserveCoordinates=false): number[][] {
  const xy=(v:number)=>preserveCoordinates?v:roundPixel(v);
  return points.map((point) => point.pressure === undefined ? [xy(point.x), xy(point.y)] : [xy(point.x), xy(point.y), clamp(point.pressure, 0, 1)]);
}

/** `paint.stroke` 参数：整笔保持同一组设置。 */
export function buildStroke(
  points: readonly DocumentPoint[],
  brush: BrushSettings,
  options: { erase?: boolean; zoom?: number;pencil?:boolean;backgroundColor?:string } = {}
): Record<string, unknown> | null {
  if (points.length === 0) return null;
  const pencil=options.pencil || options.erase && brush.eraserMode!==undefined && brush.eraserMode!=="brush";
  return {
    ...(pencil?{strokeCommand:"paint.pencil",autoErase:!options.erase && !!brush.autoErase,...(brush.eraserMode==="block" && options.erase?{block:true}:{})}:{}),
    ...(options.backgroundColor?{backgroundColor:options.backgroundColor}:{}),
    ...(brush.angle===undefined?{}:{brush:{angle:brush.angle}}),
    points: strokePoints(points,!!pencil),
    size: clampBrushSize(brush.size),
    ...(pencil?{}:{hardness:clamp(brush.hardness,0,1)}),
    opacity: clamp(brush.opacity, 0, 1),
    ...(pencil?{}:{flow:clamp(brush.flow,0,1)}),
    spacing: 0.25,
    smoothing: clamp(brush.smoothing, 0, 1),
    color: brush.color,
    mode: brush.mode ?? "normal",
    erase: options.erase ?? false,
    zoom: options.zoom && options.zoom > 0 ? options.zoom : 1,
    target: brush.target
  };
}

/** `type.create` 参数。 */
export function buildTextCreate(input: {
  x: number;
  y: number;
  text: string;
  size: number;
  color: string;
  align: "left" | "center" | "right";
  bold?: boolean;
  font?: "Noto Sans SC" | "Inter";
  orientation?:"horizontal"|"vertical";
}): Record<string, unknown> {
  return {
    ...(input.orientation?{orientation:input.orientation}:{}),
    x: roundPixel(input.x),
    y: roundPixel(input.y),
    text: input.text,
    size: Math.max(1, input.size),
    color: input.color,
    align: input.align,
    fauxBold: input.bold ?? false,
    font: input.font ?? "Noto Sans SC"
  };
}

/** `layer.newAdjustmentLayer.brightnessContrast` 参数（非 legacy 取值域：亮度 ±150、对比度 −50–100）。 */
export function buildBrightnessContrast(brightness: number, contrast: number): Record<string, unknown> {
  return {
    brightness: clamp(brightness, -150, 150),
    contrast: clamp(contrast, -50, 100)
  };
}

/** `layer.newAdjustmentLayer.hueSaturation` 参数（色相 ±180、饱和度/明度 ±100）。 */
export function buildHueSaturation(hue: number, saturation: number, lightness: number): Record<string, unknown> {
  return {
    hue: clamp(hue, -180, 180),
    saturation: clamp(saturation, -100, 100),
    lightness: clamp(lightness, -100, 100)
  };
}

/** 把 RGB 三元组（0–1）转成内核要求的 `#rrggbb`。 */
export function toHexColor(rgb: readonly [number, number, number]): string {
  const channel = (value: number) =>
    Math.round(clamp(value, 0, 1) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
}

/** `#rrggbb` 是否合法（供参数面板校验）。 */
export function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/.test(value);
}
