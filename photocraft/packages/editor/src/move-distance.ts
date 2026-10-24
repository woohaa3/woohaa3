/**
 * Move 工具智能参考线距离测量（I021）。
 *
 * 上游 `move_distance.rs` 的语义：开启 Smart Guides（本产品以 Extras 可见为开关）且使用 Move 时，
 * 按住 Cmd/Ctrl 悬停另一个图层，显示所选图层与该图层之间的水平/垂直距离线与单位读数；
 * 悬停在空白处（或背景）时量到画布边缘；Alt 拖动复制时显示原件与副本间距。
 *
 * 本模块只做纯几何与格式化，不读文档、不写内容，也不自己绘制：画布把结果投影到屏幕。
 * 距离标签复用现有 `measurement-unit.ts` 的七种单位与 DPI 换算。
 */
import {formatMeasurement, type MeasurementUnit, type PointPicaSize} from "./measurement-unit.js";

export type Box = readonly [number, number, number, number];
/** 一条距离：沿 x 轴（`horizontal`）在 y=`at` 处从 `from` 到 `to`，或沿 y 轴在 x=`at` 处。 */
export type Measure = {horizontal: boolean; at: number; from: number; to: number};
export type MeasureOverlay = {measures: Measure[]; extensions: [number, number, number, number][]};

/**
 * 两框之间的水平/垂直距离。
 *
 * - 两框在测量轴上分离时，取相对边之间的空隙；
 * - 重叠时取对应边之间的距离（左对左、右对右）；
 * - 零距离不显示；
 * - 距离线穿过两框在另一轴上重叠区的中点，不重叠时穿过第一个框（选区）的中心；
 * - 距离线末端没有落在第二个框上时，补一条该框边的虚线延长线。
 *
 * 返回的 `extensions` 与上游一致，供屏幕覆盖层绘制。
 */
export function measureBoxes(a: Box, b: Box): MeasureOverlay {
  const out: MeasureOverlay = {measures: [], extensions: []};
  if (![...a, ...b].every((value) => Number.isFinite(value))) return out;
  for (const horizontal of [true, false]) {
    const [k, o] = horizontal ? [0, 1] : [1, 0];
    const sa: [number, number] = [a[k]!, a[k + 2]!];
    const sb: [number, number] = [b[k]!, b[k + 2]!];
    const oa: [number, number] = [a[o]!, a[o + 2]!];
    const ob: [number, number] = [b[o]!, b[o + 2]!];
    const lo = Math.max(oa[0], ob[0]), hi = Math.min(oa[1], ob[1]);
    const at = lo < hi ? (lo + hi) / 2 : (oa[0] + oa[1]) / 2;
    let pairs: [number, number, number][];
    if (sa[1] <= sb[0]) pairs = [[sa[1], sb[0], sb[0]]];
    else if (sb[1] <= sa[0]) pairs = [[sb[1], sa[0], sb[1]]];
    else pairs = [[Math.min(sa[0], sb[0]), Math.max(sa[0], sb[0]), sb[0]], [Math.min(sa[1], sb[1]), Math.max(sa[1], sb[1]), sb[1]]];
    for (const [from, to, edge] of pairs) {
      if (to - from <= 0) continue;
      out.measures.push({horizontal, at, from, to});
      // 线端落在第二个框旁边：把该框的边延长到线上。
      if (at < ob[0] || at > ob[1]) {
        const near = at < ob[0] ? ob[0] : ob[1];
        out.extensions.push(horizontal ? [edge, near, edge, at] : [near, edge, at, edge]);
      }
    }
  }
  return out;
}

/** 悬停目标框；未命中图层时量到画布边缘。 */
export function targetBox(hovered: Box | null | undefined, canvas: {width: number; height: number}): Box {
  return hovered ?? [0, 0, canvas.width, canvas.height];
}

export type MeasureLabel = {text: string; horizontal: boolean; at: number; mid: number};

/**
 * 距离标签文本：沿用现有测量单位、文档 DPI 与点/派卡标准。
 *
 * 百分比按对应轴（水平用文档宽、垂直用文档高）换算，与选框/Move HUD 一致。
 */
export function measureLabels(overlay: MeasureOverlay, options: {
  unit: MeasurementUnit; dpi: number; width: number; height: number; pointPica: PointPicaSize;
}): MeasureLabel[] {
  return overlay.measures.map((measure) => ({
    text: formatMeasurement(measure.to - measure.from, options.unit, options.dpi, measure.horizontal ? options.width : options.height, options.pointPica),
    horizontal: measure.horizontal,
    at: measure.at,
    mid: (measure.from + measure.to) / 2
  }));
}

/**
 * 是否显示悬停测距。
 *
 * 上游条件：Move 工具、Smart Guides/Extras 开启、没有活动的变换或拖动、按住 Cmd/Ctrl 且
 * 没有按键按下，并且存在所选图层（否则没有「所选图层」可量）。本产品把 Smart Guides 与
 * Extras 合成同一个开关（没有独立的 Smart Guides 菜单），并在矩阵中记录这一点。
 */
export function shouldMeasure(input: {
  tool: string; extrasVisible: boolean; transforming: boolean; pressed: boolean; command: boolean;
  hasSelectedLayers: boolean; hasTarget: boolean;
}): boolean {
  return input.tool === "move" && input.extrasVisible && !input.transforming && input.command && !input.pressed && input.hasSelectedLayers && input.hasTarget;
}

/** Alt 拖动复制时的原件/副本间距：副本框按位移平移。 */
export function duplicateDistance(original: Box, delta: {x: number; y: number}): MeasureOverlay {
  const copy: Box = [original[0] + delta.x, original[1] + delta.y, original[2] + delta.x, original[3] + delta.y];
  return measureBoxes(original, copy);
}
