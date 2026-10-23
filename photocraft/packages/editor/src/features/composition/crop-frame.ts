/**
 * 裁剪框的纯几何（U50）：拖动、八向缩放、比例约束与拉直角度。
 *
 * 与 `workflows.ts` 的参数编译分开：这里只算**文档像素**的框，不碰命令参数，也不持文档。
 * 画布叠加层（`crop-overlay.tsx`）与面板共用同一份几何，避免手柄和数字输入两套判据。
 */

export type CropFrameRect = { x: number; y: number; width: number; height: number };
export type CropHandle = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rotate";

export const CROP_HANDLES: readonly CropHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w", "rotate"];

/** 裁剪框最小边长（文档像素）。低于 1 像素上游会拒绝。 */
export const MIN_CROP_SIZE = 1;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** 手柄在框上的文档坐标；`rotate` 用框顶边中点（叠加层再上移一段距离显示）。 */
export function cropHandlePoint(frame: CropFrameRect, handle: CropHandle): { x: number; y: number } {
  const centerX = frame.x + frame.width / 2;
  const centerY = frame.y + frame.height / 2;
  const right = frame.x + frame.width;
  const bottom = frame.y + frame.height;
  switch (handle) {
    case "nw": return { x: frame.x, y: frame.y };
    case "n": return { x: centerX, y: frame.y };
    case "ne": return { x: right, y: frame.y };
    case "e": return { x: right, y: centerY };
    case "se": return { x: right, y: bottom };
    case "s": return { x: centerX, y: bottom };
    case "sw": return { x: frame.x, y: bottom };
    case "w": return { x: frame.x, y: centerY };
    case "rotate": return { x: centerX, y: frame.y };
    case "move": return { x: centerX, y: centerY };
  }
}

/** 框是否为可提交的合法裁剪框（有限、至少 1 像素）。 */
export function isValidCropFrame(frame: CropFrameRect): boolean {
  return [frame.x, frame.y, frame.width, frame.height].every(Number.isFinite)
    && frame.width >= MIN_CROP_SIZE
    && frame.height >= MIN_CROP_SIZE;
}

export type DragCropOptions = {
  /** 允许越界（裁剪框可以扩展画布）；默认允许，与内核一致。 */
  allowOutside?: boolean;
  /** 画布尺寸；`allowOutside` 为 false 时用于夹取。 */
  document?: { width: number; height: number };
  /** 宽高比（宽 / 高）；给出时缩放保持比例。 */
  ratio?: number | null;
  minSize?: number;
};

/**
 * 拖动裁剪框：`move` 平移，其余方向手柄改对应边。
 *
 * 比例约束围绕**对角**（角手柄）或对边中点（边手柄）进行，行为与 Photoshop 的裁剪工具一致：
 * 拖右边只改宽度，高度按比例围绕垂直中心伸缩。
 */
export function dragCropFrame(
  frame: CropFrameRect,
  handle: CropHandle,
  delta: { x: number; y: number },
  options: DragCropOptions = {}
): CropFrameRect {
  if (handle === "rotate") return { ...frame };
  if (![delta.x, delta.y].every(Number.isFinite)) return { ...frame };
  const minSize = Math.max(MIN_CROP_SIZE, options.minSize ?? MIN_CROP_SIZE);
  if (handle === "move") {
    let next = { ...frame, x: frame.x + delta.x, y: frame.y + delta.y };
    if (options.allowOutside === false && options.document) {
      next = {
        ...next,
        x: clamp(next.x, 0, Math.max(0, options.document.width - next.width)),
        y: clamp(next.y, 0, Math.max(0, options.document.height - next.height))
      };
    }
    return roundFrame(next);
  }

  const left = frame.x;
  const top = frame.y;
  const right = frame.x + frame.width;
  const bottom = frame.y + frame.height;
  let nextLeft = left;
  let nextTop = top;
  let nextRight = right;
  let nextBottom = bottom;
  if (handle.includes("w")) nextLeft = Math.min(left + delta.x, right - minSize);
  if (handle.includes("e")) nextRight = Math.max(right + delta.x, left + minSize);
  if (handle.includes("n")) nextTop = Math.min(top + delta.y, bottom - minSize);
  if (handle.includes("s")) nextBottom = Math.max(bottom + delta.y, top + minSize);

  let next: CropFrameRect = {
    x: nextLeft,
    y: nextTop,
    width: nextRight - nextLeft,
    height: nextBottom - nextTop
  };
  const ratio = options.ratio;
  if (ratio && Number.isFinite(ratio) && ratio > 0) next = applyRatio(frame, next, handle, ratio, minSize);
  if (options.allowOutside === false && options.document) {
    next = {
      x: clamp(next.x, 0, Math.max(0, options.document.width - next.width)),
      y: clamp(next.y, 0, Math.max(0, options.document.height - next.height)),
      width: Math.min(next.width, options.document.width),
      height: Math.min(next.height, options.document.height)
    };
  }
  // 比例夹取后仍要保证最小尺寸，否则会返回 0 宽高的框。
  if (next.width < minSize || next.height < minSize) return { ...frame };
  return roundFrame(next);
}

/** 保持某一边不变，按比例换算另一边；角手柄同时锚定对角。 */
function applyRatio(frame: CropFrameRect, next: CropFrameRect, handle: CropHandle, ratio: number, minSize: number): CropFrameRect {
  const horizontal = handle.includes("e") || handle.includes("w");
  const vertical = handle.includes("n") || handle.includes("s");
  const anchorRight = handle.includes("w");
  const anchorBottom = handle.includes("n");
  let width = next.width;
  let height = next.height;
  if (horizontal && vertical) {
    // 角手柄：用较大的驱动量，保证至少一个方向跟随指针。
    if (Math.abs(width - frame.width) >= Math.abs(height - frame.height)) height = width / ratio;
    else width = height * ratio;
  } else if (horizontal) {
    height = width / ratio;
  } else {
    width = height * ratio;
  }
  width = Math.max(minSize, width);
  height = Math.max(minSize, width / ratio);
  width = Math.max(minSize, height * ratio);
  const centerX = frame.x + frame.width / 2;
  const centerY = frame.y + frame.height / 2;
  const x = handle.includes("e") ? next.x : anchorRight ? next.x + next.width - width : centerX - width / 2;
  const y = handle.includes("s") ? next.y : anchorBottom ? next.y + next.height - height : centerY - height / 2;
  return { x, y, width, height };
}

function roundFrame(frame: CropFrameRect): CropFrameRect {
  return {
    x: Math.round(frame.x),
    y: Math.round(frame.y),
    width: Math.max(MIN_CROP_SIZE, Math.round(frame.width)),
    height: Math.max(MIN_CROP_SIZE, Math.round(frame.height))
  };
}

/** 拉直角度（度）：从框中心指向指针，取相对「正上方」的偏角并夹到 ±45°。 */
export function straightenAngle(center: { x: number; y: number }, point: { x: number; y: number }): number {
  if (![center.x, center.y, point.x, point.y].every(Number.isFinite)) return 0;
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  if (dx === 0 && dy === 0) return 0;
  // 正上方为 0；顺时针为正，与 `cropParams` 的角度方向一致。
  const degrees = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return clamp(Math.round(degrees * 10) / 10, -45, 45);
}

/** 裁剪框中心。 */
export function cropFrameCenter(frame: CropFrameRect): { x: number; y: number } {
  return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

/** 网格线（文档坐标）：三分线或等距网格。叠加层与「网格」选项共用。 */
export function cropGridLines(frame: CropFrameRect, grid: "none" | "thirds" | "grid", step = 16): { x: number[]; y: number[] } {
  if (grid === "none") return { x: [], y: [] };
  if (grid === "thirds") {
    return {
      x: [frame.x + frame.width / 3, frame.x + (frame.width * 2) / 3],
      y: [frame.y + frame.height / 3, frame.y + (frame.height * 2) / 3]
    };
  }
  const size = Math.max(1, Math.round(step));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let x = frame.x + size; x < frame.x + frame.width; x += size) xs.push(x);
  for (let y = frame.y + size; y < frame.y + frame.height; y += size) ys.push(y);
  // 网格线数量受框大小约束，避免超大框生成几十万条 DOM 线。
  return { x: xs.slice(0, 400), y: ys.slice(0, 400) };
}
