/**
 * 视图与分析数据的有界契约（U70–U73）。
 *
 * ## 归属
 *
 * 这些字段**不属于内容身份**：参考线、标尺原点、测量比例/标尺、计数和注释是上游文档的
 * 视图/注释字段，`contentHash` 只由画布与图层决定（见 `shared/content.ts`）。因此本文件不参与
 * `canonicalizeImageProjectContent`，而是给两侧核验（TS 预览 + Rust `project-verify`）提供同一组
 * 上限与判定，避免前端先放行、原生核验后才拒绝。
 *
 * ## 不复制上游语义
 *
 * 判定只回答「结构是否有界、可安全解码」，不重算参考线布局、测量比例或注释排序；那些由内核
 * 命令与 `viewSnapshot` 给出。键名与 Rust 侧 `features/views/mod.rs` 的常量一一对应。
 */

/** 与 `photocraft-project-verify` 的视图核验上限一致。 */
export const VIEW_DATA_LIMITS = {
  /** 单轴参考线上限。 */
  maxGuidesPerAxis: 4096,
  /** 参考线/原点/计数/注释坐标的绝对值上限（源像素）。 */
  maxCoordinate: 1.0e7,
  /** 计数分组上限。 */
  maxCountGroups: 256,
  /** 全部分组的标记总数上限。 */
  maxCountMarkers: 100_000,
  /** 注释上限。 */
  maxNotes: 1024,
  maxNoteAuthorChars: 256,
  maxNoteTextChars: 64 * 1024,
  /** 测量比例单位名长度上限。 */
  maxUnitChars: 32,
  /** 计数分组名长度上限（上游 `count.setGroup` 的显示约束）。 */
  maxCountGroupNameChars: 256,
  /** 计数标记尺寸与标签字号（上游 Photoshop 取值域）。 */
  minMarkerSize: 1,
  maxMarkerSize: 10,
  minLabelSize: 8,
  maxLabelSize: 72,
} as const;

export type ViewGuideSet = { horizontal?: number[]; vertical?: number[] };
export type ViewGuideColor = { vertical: boolean; position: number; rgb: [number, number, number] };
export type ViewMeasurementScale = { pixelLength: number; logicalLength: number; units: string };
export type ViewCountGroup = {
  name: string;
  color: [number, number, number];
  markerSize: number;
  labelSize: number;
  visible: boolean;
  points: [number, number][];
};
export type ViewNote = {
  author: string;
  color: [number, number, number];
  text: string;
  position: [number, number];
  popup: [number, number, number, number];
  open: boolean;
  modified: string;
};

/** 文档级视图/分析数据的形状（与 `.pcraft` 的 `guids`/`measurement`/`notes` 字段同名）。 */
export type ViewDocumentData = {
  guides?: ViewGuideSet & { colors?: ViewGuideColor[] };
  rulerOrigin?: [number, number];
  measurement?: {
    scale?: ViewMeasurementScale;
    countGroups?: ViewCountGroup[];
    activeCountGroup?: number;
    ruler?: { start: [number, number]; end: [number, number]; protractor?: [number, number] | null } | null;
  };
  notes?: ViewNote[];
};

const bounded = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= VIEW_DATA_LIMITS.maxCoordinate;

const point = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every(bounded);

const rgb = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) && value.length === 3 && value.every((channel) => typeof channel === "number" && Number.isFinite(channel) && channel >= 0 && channel <= 255);

const int = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

const shortText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;

/**
 * 参考线是否可安全解码。
 *
 * 颜色用「方向 + 位置」索引参考线，因此指向不存在参考线的颜色条目视为数据自相矛盾（与内核
 * `Guides::prune_colors` 的语义一致），而不是静默丢弃。
 */
export function validGuideSet(guides: (ViewGuideSet & { colors?: ViewGuideColor[] }) | null | undefined): boolean {
  if (guides === null || guides === undefined) return true;
  const horizontal = guides.horizontal ?? [];
  const vertical = guides.vertical ?? [];
  if (!Array.isArray(horizontal) || !Array.isArray(vertical)) return false;
  if (horizontal.length > VIEW_DATA_LIMITS.maxGuidesPerAxis || vertical.length > VIEW_DATA_LIMITS.maxGuidesPerAxis) return false;
  if (!horizontal.every(bounded) || !vertical.every(bounded)) return false;
  const colors = guides.colors ?? [];
  if (!Array.isArray(colors)) return false;
  if (colors.length > horizontal.length + vertical.length) return false;
  return colors.every((color) => {
    if (!color || typeof color.vertical !== "boolean" || !bounded(color.position) || !rgb(color.rgb)) return false;
    const axis = color.vertical ? vertical : horizontal;
    return axis.includes(color.position);
  });
}

/** 测量比例：两段长度为正、有限，单位非空且有界。 */
export function validMeasurementScale(scale: ViewMeasurementScale | null | undefined): boolean {
  if (scale === null || scale === undefined) return true;
  if (!scale || typeof scale !== "object") return false;
  const { pixelLength, logicalLength, units } = scale;
  if (typeof pixelLength !== "number" || !Number.isFinite(pixelLength) || pixelLength <= 0) return false;
  if (typeof logicalLength !== "number" || !Number.isFinite(logicalLength) || logicalLength <= 0) return false;
  return typeof units === "string" && units.trim().length > 0 && units.length <= VIEW_DATA_LIMITS.maxUnitChars;
}

/** 计数分组与标记：逐组尺寸有界、合计标记不超预算、活动索引指向真实分组。 */
export function validCountGroups(groups: ViewCountGroup[] | null | undefined, active = 0): boolean {
  if (groups === null || groups === undefined) return true;
  if (!Array.isArray(groups) || groups.length > VIEW_DATA_LIMITS.maxCountGroups) return false;
  let markers = 0;
  for (const group of groups) {
    if (!group || typeof group !== "object") return false;
    if (!shortText(group.name, VIEW_DATA_LIMITS.maxCountGroupNameChars)) return false;
    if (!rgb(group.color)) return false;
    if (!int(group.markerSize, VIEW_DATA_LIMITS.minMarkerSize, VIEW_DATA_LIMITS.maxMarkerSize)) return false;
    if (!int(group.labelSize, VIEW_DATA_LIMITS.minLabelSize, VIEW_DATA_LIMITS.maxLabelSize)) return false;
    if (typeof group.visible !== "boolean") return false;
    if (!Array.isArray(group.points)) return false;
    // 先按剩余预算判长度，再逐点校验：超预算的数组不该被完整遍历一遍（解码前的累计预算）。
    markers += group.points.length;
    if (markers > VIEW_DATA_LIMITS.maxCountMarkers) return false;
    if (!group.points.every(point)) return false;
  }
  if (groups.length > 0 && !int(active, 0, groups.length - 1)) return false;
  return true;
}

/** 标尺线：两端与量角器点都在画布坐标域内。 */
export function validRuler(ruler: { start: [number, number]; end: [number, number]; protractor?: [number, number] | null } | null | undefined): boolean {
  if (ruler === null || ruler === undefined) return true;
  if (!ruler || typeof ruler !== "object") return false;
  if (!point(ruler.start) || !point(ruler.end)) return false;
  return ruler.protractor === undefined || ruler.protractor === null || point(ruler.protractor);
}

/** 注释：数量、文本/作者长度与位置有界。 */
export function validNotes(notes: ViewNote[] | null | undefined): boolean {
  if (notes === null || notes === undefined) return true;
  if (!Array.isArray(notes) || notes.length > VIEW_DATA_LIMITS.maxNotes) return false;
  return notes.every((note) => {
    if (!note || typeof note !== "object") return false;
    if (!shortText(note.author, VIEW_DATA_LIMITS.maxNoteAuthorChars)) return false;
    if (!shortText(note.text, VIEW_DATA_LIMITS.maxNoteTextChars)) return false;
    if (!rgb(note.color)) return false;
    if (!point(note.position)) return false;
    if (!Array.isArray(note.popup) || note.popup.length !== 4 || !note.popup.every(bounded)) return false;
    return typeof note.open === "boolean";
  });
}

/**
 * 整份文档级视图数据是否可安全解码。
 *
 * 返回第一个不通过的字段名，供调用方给出具体原因（而不是笼统的「工程无效」）。
 */
export function viewDocumentDataProblem(data: ViewDocumentData | null | undefined): keyof ViewDocumentData | null {
  if (!data || typeof data !== "object") return null;
  if (!validGuideSet(data.guides)) return "guides";
  if (data.rulerOrigin !== undefined && !point(data.rulerOrigin)) return "rulerOrigin";
  const measurement = data.measurement;
  if (measurement !== undefined) {
    if (!measurement || typeof measurement !== "object") return "measurement";
    if (!validMeasurementScale(measurement.scale)) return "measurement";
    if (!validRuler(measurement.ruler)) return "measurement";
    if (!validCountGroups(measurement.countGroups, measurement.activeCountGroup ?? 0)) return "measurement";
  }
  if (!validNotes(data.notes)) return "notes";
  return null;
}

/**
 * 旧工程兼容：缺省/空值一律视为合法。
 *
 * 参考线、计数、注释都是可选扩展字段；旧工程没有它们是正常状态，不改变内容身份。
 */
export function isEmptyViewDocumentData(data: ViewDocumentData | null | undefined): boolean {
  if (!data || typeof data !== "object") return true;
  const guides = data.guides;
  const measurement = data.measurement;
  const origin = data.rulerOrigin;
  const noGuides = !guides
    || ((guides.horizontal?.length ?? 0) === 0 && (guides.vertical?.length ?? 0) === 0 && (guides.colors?.length ?? 0) === 0);
  const noCounts = !measurement || (measurement.countGroups?.length ?? 0) === 0;
  const noNotes = (data.notes?.length ?? 0) === 0;
  // 标尺原点 (0,0)、像素单位和空标尺线是默认状态，不构成可保存的视图数据。
  return noGuides && noCounts && noNotes
    && (!origin || (origin[0] === 0 && origin[1] === 0))
    && !measurement?.ruler
    && (!measurement?.scale || measurement.scale.units === "pixels");
}
