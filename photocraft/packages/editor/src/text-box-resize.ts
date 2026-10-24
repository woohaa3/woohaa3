/**
 * 段落文字框缩放手柄（I231）。
 *
 * 只把指针命中与几何换算成候选框，不自己排版、不改正式文档：命中与缩放都落在原生文字草稿
 * （`type.edit` 的 `box` 参数）上，由内核重新布局。手柄顺序与上游
 * `type_tool.rs::box_handle_at` 一致：四角、上中、右中、下中、左中。
 *
 * 原生 `TextShape::Box` 的 `x/y/width/height` 是**文字空间**坐标，图层变换再把它投影到文档。
 * 所以指针先经变换逆矩阵回到文字空间，缩放也发生在文字空间，最后把新左上角映射回文档坐标
 * 交给 `type.edit`（上游 `resize_box` 用同样的 `to_text`/`aff.apply` 路线）。
 */

export type Affine = readonly [number, number, number, number, number, number];
export type TextRect = { x: number; y: number; width: number; height: number };
export type Point = readonly [number, number];

/** 手柄顺序：0 左上、1 右上、2 右下、3 左下、4 上中、5 右中、6 下中、7 左中。 */
export type BoxHandle = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** 每个手柄拖动的边：(left, right, top, bottom)。与上游 `handle_sides` 同序。 */
const SIDES: readonly (readonly [boolean, boolean, boolean, boolean])[] = [
  [true, false, true, false],
  [false, true, true, false],
  [false, true, false, true],
  [true, false, false, true],
  [false, false, true, false],
  [false, true, false, false],
  [false, false, false, true],
  [true, false, false, false]
];

/** 上游同值：手柄命中半径按屏幕像素计，最小框按文字空间像素计。 */
const HANDLE_RADIUS = 6;
const MIN_BOX = 4;

export function idAffine(value: unknown): Affine | null {
  if (!Array.isArray(value) || value.length !== 6) return null;
  if (!value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) return null;
  return value as unknown as Affine;
}

export function applyAffine(matrix: Affine, point: Point): Point {
  return [matrix[0] * point[0] + matrix[2] * point[1] + matrix[4], matrix[1] * point[0] + matrix[3] * point[1] + matrix[5]];
}

export function invertAffine(matrix: Affine): Affine | null {
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
  return [matrix[3] / determinant, -matrix[1] / determinant, -matrix[2] / determinant, matrix[0] / determinant,
    (matrix[2] * matrix[5] - matrix[3] * matrix[4]) / determinant, (matrix[1] * matrix[4] - matrix[0] * matrix[5]) / determinant];
}

/** 文字空间里的八个手柄位置。 */
export function textBoxHandles(rect: TextRect): Point[] {
  const { x, y, width, height } = rect;
  const right = x + width, bottom = y + height, midX = x + width / 2, midY = y + height / 2;
  return [[x, y], [right, y], [right, bottom], [x, bottom], [midX, y], [right, midY], [midX, bottom], [x, midY]];
}

/** 文档坐标里的八个手柄位置（供覆盖层绘制与测试）。 */
export function boxHandlePoints(rect: TextRect, transform: Affine): Point[] {
  return textBoxHandles(rect).map((point) => applyAffine(transform, point));
}

/** 指针命中的手柄；容差按当前缩放换算成文档像素。 */
export function boxHandleAt(rect: TextRect | null, transform: Affine | null, point: Point, zoom: number): BoxHandle | null {
  if (!rect || !transform) return null;
  const tolerance = HANDLE_RADIUS / Math.max(zoom, 0.01);
  let found: BoxHandle | null = null, best = Infinity;
  boxHandlePoints(rect, transform).forEach((handle, index) => {
    const distance = Math.max(Math.abs(handle[0] - point[0]), Math.abs(handle[1] - point[1]));
    // 角点排在边中点之前，因此同一距离时角点优先。
    if (distance <= tolerance && distance < best) { best = distance; found = index as BoxHandle; }
  });
  return found;
}

export type BoxResizeInput = {
  handle: BoxHandle;
  /** 按下时的文字空间框与图层变换（整个拖动都用这份快照，Alt 中心因此固定）。 */
  rect: TextRect;
  transform: Affine;
  /** 当前指针（文档坐标）。 */
  point: Point;
  /** Alt/Option：以按下时的框中心对称缩放。 */
  alt: boolean;
};

/**
 * 计算 `type.edit` 需要的候选框 `[x, y, width, height]`（文档坐标）。
 *
 * 被拖的边跟随指针，其余边不动；Alt 时对边以按下时的中心镜像，被拖边在离中心
 * `MIN_BOX/2` 处夹紧，框不会反转或缩到不可见。与上游 `resize_box` 语义一致。
 */
export function resizeTextBox(input: BoxResizeInput): [number, number, number, number] {
  const inverse = invertAffine(input.transform);
  const point = inverse ? applyAffine(inverse, input.point) : input.point;
  const { x, y, width, height } = input.rect;
  const [left, right, top, bottom] = SIDES[input.handle]!;
  let x0 = x, x1 = x + width, y0 = y, y1 = y + height;
  if (left) x0 = Math.min(point[0], x1 - MIN_BOX);
  if (right) x1 = Math.max(point[0], x0 + MIN_BOX);
  if (top) y0 = Math.min(point[1], y1 - MIN_BOX);
  if (bottom) y1 = Math.max(point[1], y0 + MIN_BOX);
  if (input.alt) {
    const cx = x + width / 2, cy = y + height / 2;
    if (left) { x0 = Math.min(point[0], cx - MIN_BOX / 2); x1 = 2 * cx - x0; }
    if (right) { x1 = Math.max(point[0], cx + MIN_BOX / 2); x0 = 2 * cx - x1; }
    if (top) { y0 = Math.min(point[1], cy - MIN_BOX / 2); y1 = 2 * cy - y0; }
    if (bottom) { y1 = Math.max(point[1], cy + MIN_BOX / 2); y0 = 2 * cy - y1; }
  }
  const origin = applyAffine(input.transform, [Math.min(x0, x1), Math.min(y0, y1)] as const);
  return [origin[0], origin[1], Math.abs(x1 - x0), Math.abs(y1 - y0)];
}

/** 覆盖层绘制用：文字空间框投影后的四个角（仅用于屏幕手柄定位）。 */
export function boxOutline(rect: TextRect, transform: Affine): Point[] {
  const corners: Point[] = [[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x + rect.width, rect.y + rect.height], [rect.x, rect.y + rect.height]];
  return corners.map((point) => applyAffine(transform, point));
}

/** 从原生 `type.info` 读出段落框与变换；点文字返回 null。 */
export function paragraphBoxOf(info: Record<string, unknown> | null | undefined): { rect: TextRect; transform: Affine } | null {
  if (!info || info.new === true) return null;
  const shape = info.shape;
  if (!shape || typeof shape !== "object") return null;
  // 原生 serde 外部标签：`{"Box":{x,y,width,height}}`；扁平写法一并接受，便于旧数据兼容。
  const outer = shape as Record<string, unknown>;
  const box = (outer.Box && typeof outer.Box === "object" ? outer.Box : outer) as Record<string, unknown>;
  const values = [box.x, box.y, box.width, box.height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  if ((box.width as number) <= 0 || (box.height as number) <= 0) return null;
  const transform = idAffine(info.transform) ?? [1, 0, 0, 1, 0, 0];
  return { rect: { x: box.x as number, y: box.y as number, width: box.width as number, height: box.height as number }, transform };
}
