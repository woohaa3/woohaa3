import sharp from 'sharp';

export interface AlphaPlane {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface AlphaStats {
  width: number;
  height: number;
  empty: boolean;
  coverage: number;
  minAlpha: number;
  maxAlpha: number;
  softRatio: number;
  bbox: { left: number; top: number; width: number; height: number } | null;
  safeMarginRatio: number;
  centerX: number | null;
  subjectHeight: number | null;
  footBaseline: number | null;
  touchesEdge: boolean;
}

export async function readAlpha(file: string): Promise<AlphaPlane> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const plane = new Uint8Array(info.width * info.height);
  for (let index = 0; index < plane.length; index += 1) plane[index] = data[index * 4 + 3] as number;
  return { data: plane, width: info.width, height: info.height };
}

export async function readMask(file: string, threshold = 127): Promise<AlphaPlane> {
  const { data, info } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true });
  const plane = new Uint8Array(info.width * info.height);
  for (let index = 0; index < plane.length; index += 1) plane[index] = (data[index] as number) > threshold ? 1 : 0;
  return { data: plane, width: info.width, height: info.height };
}

export function alphaStatsOf(plane: AlphaPlane, floor: number): AlphaStats {
  let minAlpha = 255;
  let maxAlpha = 0;
  let visible = 0;
  let soft = 0;
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < plane.height; y += 1) {
    for (let x = 0; x < plane.width; x += 1) {
      const alpha = plane.data[y * plane.width + x] as number;
      minAlpha = Math.min(minAlpha, alpha);
      maxAlpha = Math.max(maxAlpha, alpha);
      if (alpha > floor) {
        visible += 1;
        if (alpha < 255) soft += 1;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }
  const total = plane.width * plane.height;
  if (visible === 0) {
    return {
      width: plane.width,
      height: plane.height,
      empty: true,
      coverage: 0,
      minAlpha,
      maxAlpha,
      softRatio: 0,
      bbox: null,
      safeMarginRatio: 0,
      centerX: null,
      subjectHeight: null,
      footBaseline: null,
      touchesEdge: false,
    };
  }
  const bbox = { left, top, width: right - left + 1, height: bottom - top + 1 };
  const margin = Math.min(left, top, plane.width - 1 - right, plane.height - 1 - bottom);
  return {
    width: plane.width,
    height: plane.height,
    empty: false,
    coverage: visible / total,
    minAlpha,
    maxAlpha,
    softRatio: soft / visible,
    bbox,
    safeMarginRatio: margin / Math.min(plane.width, plane.height),
    centerX: (left + right + 1) / 2 / plane.width,
    subjectHeight: bbox.height / plane.height,
    footBaseline: (bottom + 1) / plane.height,
    touchesEdge: left === 0 || top === 0 || right === plane.width - 1 || bottom === plane.height - 1,
  };
}

export async function alphaStats(file: string, floor: number): Promise<AlphaStats> {
  return alphaStatsOf(await readAlpha(file), floor);
}

export function alphaIoU(left: AlphaPlane, right: AlphaPlane, floor: number): number {
  if (left.width !== right.width || left.height !== right.height) return 0;
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < left.data.length; index += 1) {
    const a = (left.data[index] as number) > floor;
    const b = (right.data[index] as number) > floor;
    if (a || b) union += 1;
    if (a && b) intersection += 1;
  }
  return union === 0 ? 1 : intersection / union;
}

/** 只在任一帧可见的像素上统计 RGB 平均绝对差，避免背景色差异污染硬切结论。 */
export async function visibleRgbMad(leftFile: string, rightFile: string, floor: number): Promise<number> {
  const left = await sharp(leftFile).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const right = await sharp(rightFile).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (left.info.width !== right.info.width || left.info.height !== right.info.height) return 1;
  let sum = 0;
  let count = 0;
  const pixels = left.info.width * left.info.height;
  for (let index = 0; index < pixels; index += 1) {
    const leftAlpha = left.data[index * 4 + 3] as number;
    const rightAlpha = right.data[index * 4 + 3] as number;
    if (leftAlpha <= floor && rightAlpha <= floor) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      sum += Math.abs((left.data[index * 4 + channel] as number) - (right.data[index * 4 + channel] as number));
    }
    count += 3;
  }
  return count === 0 ? 0 : sum / count / 255;
}

/** 全图单窗口 SSIM，作为硬切一致性估计；只用于门槛告警，不宣称逐块指标。 */
export async function globalSsim(leftFile: string, rightFile: string, floor: number): Promise<number> {
  const left = await sharp(leftFile).ensureAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  const right = await sharp(rightFile).ensureAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  if (left.info.width !== right.info.width || left.info.height !== right.info.height) return 0;
  const pixels = left.info.width * left.info.height;
  const stride = left.info.channels;
  const alphaOffset = stride - 1;
  const visible = (buffer: Buffer, index: number) => (buffer[index * stride + alphaOffset] as number) > floor;
  let sumA = 0;
  let sumB = 0;
  let count = 0;
  for (let index = 0; index < pixels; index += 1) {
    if (!visible(left.data, index) && !visible(right.data, index)) continue;
    sumA += left.data[index * stride] as number;
    sumB += right.data[index * stride] as number;
    count += 1;
  }
  if (count === 0) return 1;
  const meanA = sumA / count;
  const meanB = sumB / count;
  let varA = 0;
  let varB = 0;
  let covariance = 0;
  for (let index = 0; index < pixels; index += 1) {
    if (!visible(left.data, index) && !visible(right.data, index)) continue;
    const a = (left.data[index * stride] as number) - meanA;
    const b = (right.data[index * stride] as number) - meanB;
    varA += a * a;
    varB += b * b;
    covariance += a * b;
  }
  varA /= count;
  varB /= count;
  covariance /= count;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  return ((2 * meanA * meanB + c1) * (2 * covariance + c2)) / ((meanA ** 2 + meanB ** 2 + c1) * (varA + varB + c2));
}
