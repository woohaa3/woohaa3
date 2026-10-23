/**
 * 笔刷动态的响应曲线（U30）
 * （change: 2026-10-22-add-photocraft-painting-color-workflows）。
 *
 * 内核 `Dynamic.curve` 是一串 `[input, output]` 点（0–1，最多 16 个，内核会排序、钳制并保证
 * 单调）。这里只做**文本 ↔ 点集**的转换与有界校验，不重新实现曲线求值：像素仍由内核按
 * Fritsch–Carlson 单调三次插值绘制。
 *
 * 为什么要文本输入：曲线编辑器在共享 `rgb-curve-editor` 里属于别的域；本域只提供一个可键盘
 * 输入、可回归验证的等价入口，非法输入明确返回 `null` 并由面板显示原因，而不是悄悄改成线性。
 */
import { normalizeCurvePoints as normalizeProtocolCurve } from "@woohaa3/photocraft-protocol";

export type CurvePoint = [number, number];

/** 线性（内核默认）：显式给出时表示「恢复默认」，不发送曲线字段。 */
export const LINEAR_CURVE: readonly CurvePoint[] = [[0, 0], [1, 1]];

export const MAX_CURVE_POINTS = 16;

/**
 * 解析 `"0,0; 0.5,0.2; 1,1"`。
 *
 * 空串返回 `null`（未填写 ≠ 线性）；非法数字、越界、少于 2 点、超过 16 点、输入不递增都返回
 * `null`。校验本身委托协议包（`normalizeCurvePoints`），保证界面、协议与内核说的是同一个范围。
 */
export function parseCurvePoints(text: string): CurvePoint[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const points: CurvePoint[] = [];
  for (const chunk of trimmed.split(/[;；]/)) {
    const part = chunk.trim();
    if (!part) continue;
    const pair = part.split(/[,，\s]+/).filter(Boolean);
    if (pair.length !== 2) return null;
    points.push([Number(pair[0]), Number(pair[1])]);
  }
  return normalizeProtocolCurve(points);
}

/** 点集 → 文本（供面板回填）。 */
export function formatCurvePoints(points: readonly CurvePoint[] | undefined): string {
  if (!points || points.length === 0) return "";
  return points.map(([x, y]) => `${x},${y}`).join("; ");
}

/** 是否默认线性曲线（两个端点，恒等）。 */
export function isLinearCurve(points: readonly CurvePoint[] | undefined): boolean {
  if (!points || points.length !== 2) return points === undefined || points.length === 0;
  return points[0]![0] === 0 && points[0]![1] === 0 && points[1]![0] === 1 && points[1]![1] === 1;
}

/** 解码内核 `brush.get` 里的曲线字段：非法结构返回 `undefined`（表示「用默认」）。 */
export function decodeCurvePoints(value: unknown): CurvePoint[] | undefined {
  return normalizeProtocolCurve(value) ?? undefined;
}
