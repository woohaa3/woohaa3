/**
 * 旋转 × 缩放 × 平移的**唯一**可逆视图变换（U72，design D1）。
 *
 * 与 Rust `features/views/view_geometry.rs` 的 `ViewTransform` 逐公式一致：源坐标 → 画布客户坐标，
 * 以及精确逆映射与屏幕阈值换算。共享的 `features/coordinates.ts` 只覆盖无旋转的缩放/平移且是
 * 冻结文件，因此旋转视图的命中、参考线投影、阈值与 Navigator 都从这里取同一份数学。
 *
 * 约定：`offset` 是文档左上角在画布容器内的客户坐标；旋转围绕文档中心，屏幕 +y 向下，
 * 角度顺时针为正。
 */

export type ViewTransformState = {
  zoom: number;
  offset: readonly [number, number];
  rotation: number;
};

export const MAX_ROTATION_DEGREES = 360;
export const MIN_ZOOM = 0;
export const MAX_ZOOM = 32;

/** 变换是否可用（缩放 (0, 32]、偏移有限、角度 ±360）。 */
export function validTransform(transform: ViewTransformState): boolean {
  const { zoom, offset, rotation } = transform;
  return Number.isFinite(zoom) && zoom > MIN_ZOOM && zoom <= MAX_ZOOM
    && Number.isFinite(offset[0]) && Number.isFinite(offset[1])
    && Number.isFinite(rotation) && Math.abs(rotation) <= MAX_ROTATION_DEGREES;
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** 源坐标 → 客户坐标。`document` 是文档像素尺寸（旋转中心）。 */
export function documentToView(
  point: readonly [number, number],
  transform: ViewTransformState,
  document: readonly [number, number],
): [number, number] {
  const [centerX, centerY] = [document[0] / 2, document[1] / 2];
  const angle = radians(transform.rotation);
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  const dx = (point[0] - centerX) * transform.zoom;
  const dy = (point[1] - centerY) * transform.zoom;
  return [
    transform.offset[0] + centerX * transform.zoom + dx * cos - dy * sin,
    transform.offset[1] + centerY * transform.zoom + dx * sin + dy * cos,
  ];
}

/** 客户坐标 → 源坐标（`documentToView` 的精确逆）。 */
export function viewToDocument(
  client: readonly [number, number],
  transform: ViewTransformState,
  document: readonly [number, number],
): [number, number] {
  const [centerX, centerY] = [document[0] / 2, document[1] / 2];
  const angle = radians(transform.rotation);
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  const vx = client[0] - transform.offset[0] - centerX * transform.zoom;
  const vy = client[1] - transform.offset[1] - centerY * transform.zoom;
  return [
    centerX + (vx * cos + vy * sin) / transform.zoom,
    centerY + (-vx * sin + vy * cos) / transform.zoom,
  ];
}

/**
 * 屏幕像素阈值 → 源像素阈值。
 *
 * 旋转不改变比例，只有缩放在缩放；因此吸附手感在任何角度下都与 `tolerance / zoom` 一致。
 * 非法输入返回 0（不吸附），而不是 `NaN` 让调用方算出错误坐标。
 */
export function screenThreshold(screenPx: number, zoom: number): number {
  if (!Number.isFinite(screenPx) || screenPx < 0 || !Number.isFinite(zoom) || zoom <= 0) return 0;
  return screenPx / zoom;
}

/** 文档四角在客户坐标下的位置（Navigator 外框与旋转命中框使用）。 */
export function documentCorners(
  transform: ViewTransformState,
  document: readonly [number, number],
): [[number, number], [number, number], [number, number], [number, number]] {
  return [
    documentToView([0, 0], transform, document),
    documentToView([document[0], 0], transform, document),
    documentToView([document[0], document[1]], transform, document),
    documentToView([0, document[1]], transform, document),
  ];
}

/**
 * 参考线在画布上的可见段（客户坐标）。
 *
 * 旋转后一条源坐标竖线不再垂直；返回两端点由调用方画 `<line>`，因此叠加层不需要 CSS 旋转图片。
 */
export function guideSegment(
  vertical: boolean,
  position: number,
  transform: ViewTransformState,
  document: readonly [number, number],
): [[number, number], [number, number]] {
  const start: [number, number] = vertical ? [position, 0] : [0, position];
  const end: [number, number] = vertical ? [position, document[1]] : [document[0], position];
  return [documentToView(start, transform, document), documentToView(end, transform, document)];
}

/** 一条参考线的命中结果（源坐标 + 索引，供拖动与单条删除使用）。 */
export type GuideHit = {
  vertical: boolean;
  index: number;
  /** 参考线在源坐标里的位置。 */
  position: number;
  /** 命中点到参考线的屏幕距离（像素），用于多线重叠时取最近者。 */
  distance: number;
};

/** 画布区域（源坐标下的矩形；拖动越界时按它夹取）。 */
export type GuideRect = { width: number; height: number };

/**
 * 客户坐标下命中哪条参考线（U70 已有线命中/拖动）。
 *
 * 判定在**源坐标**里做，因此旋转任意角度都成立：先逆变换到源坐标，再和线位置比距离；容差换成源
 * 像素（`screenPx / zoom`）后再比较，保证缩放后手感一致。同一容差内返回最近的一条，重叠时不
 * 随机取第一根。
 */
export function hitGuide(
  client: readonly [number, number],
  transform: ViewTransformState,
  document: readonly [number, number],
  guides: { horizontal?: readonly number[]; vertical?: readonly number[] },
  tolerancePx = 6,
): GuideHit | null {
  const tolerance = screenThreshold(tolerancePx, transform.zoom);
  if (!(tolerance > 0)) return null;
  const source = viewToDocument(client, transform, document);
  if (!source.every(Number.isFinite)) return null;
  let best: GuideHit | null = null;
  const consider = (vertical: boolean, positions: readonly number[]) => {
    positions.forEach((position, index) => {
      const distance = Math.abs((vertical ? source[0] : source[1]) - position);
      if (distance > tolerance) return;
      if (best && best.distance <= distance) return;
      best = { vertical, index, position, distance };
    });
  };
  consider(true, guides.vertical ?? []);
  consider(false, guides.horizontal ?? []);
  return best;
}

/**
 * 拖动中的参考线在源坐标里的新位置（U70 拖动）。
 *
 * 夹取到画布边界内并保留两位小数：参考线是文档数据，写入整数级以下的噪声只会让历史难以辨认。
 * 越界拖动仍留下一条可继续拖的线，而不是返回 `null` 让界面卡在上一帧。
 */
export function guideDragPosition(
  vertical: boolean,
  client: readonly [number, number],
  transform: ViewTransformState,
  document: readonly [number, number],
  bounds: GuideRect = { width: document[0], height: document[1] },
): number | null {
  const source = viewToDocument(client, transform, document);
  if (!source.every(Number.isFinite)) return null;
  const limit = Math.max(0, vertical ? bounds.width : bounds.height);
  const value = Math.min(limit, Math.max(0, vertical ? source[0] : source[1]));
  return Math.round(value * 100) / 100;
}

/**
 * 标尺原点拖动（U70）：把原点放在客户坐标对应的源位置上。
 *
 * 原点保存的是文档坐标，因此这里只做逆变换与夹取，不叠加旧原点——拖动时指针落在哪，零就以那里
 * 为起点。返回 `null` 表示指针无法映射（未布局的画布）。
 */
export function rulerOriginAt(
  client: readonly [number, number],
  transform: ViewTransformState,
  document: readonly [number, number],
): [number, number] | null {
  const source = viewToDocument(client, transform, document);
  if (!source.every(Number.isFinite)) return null;
  return [Math.round(source[0] * 100) / 100, Math.round(source[1] * 100) / 100];
}

/**
 * 标尺读数：源坐标相对标尺原点、再按单位换算（U70/U73 的 Info 与标尺共用）。
 *
 * 只做「原点偏移 + 单位」，不重新定义格式化；`format` 由内核 `formatLengthJson` 提供，缺省时
 * 返回源像素读数，避免界面自己发明单位换算规则。
 */
export function rulerReading(
  source: readonly [number, number],
  origin: readonly [number, number],
  describe: (px: number) => string,
): { x: number; y: number; xText: string; yText: string } {
  const x = source[0] - origin[0];
  const y = source[1] - origin[1];
  return { x, y, xText: describe(x), yText: describe(y) };
}
