/**
 * 视图导航、参考线与分析辅助的**有界解码**（U70–U73）。
 *
 * 内核把视图状态、参考线、取样点、测量与注释都作为 JSON 交给前端；这里逐字段校验成稳定类型，
 * 任何一项不合法都返回 `null`，界面据此显示「内核返回的视图状态无效」而不是猜一个形状。
 * 与 `editor-view-model.ts` 的 `decodeEditorState` 同一策略：JSON 边界只在一处放宽。
 */

export type Point = [number, number];
export type Rgb = [number, number, number];
export type Rgba = [number, number, number, number];

/** 一个独立取景的视图（会话状态，不进文档）。 */
export type ViewFrame = {
  id: string;
  label: string;
  zoom: number;
  offset: Point;
  rotation: number;
  active: boolean;
};

/** 视图辅助状态（工作区偏好；不进内容 hash、不进历史）。 */
export type ViewAids = {
  rulers: boolean;
  grid: boolean;
  gridStep: Point;
  gridSubdivisions: number;
  guides: boolean;
  lockGuides: boolean;
  smartGuides: boolean;
  snap: { document: boolean; guides: boolean; grid: boolean; layers: boolean; selection: boolean };
  suspend: boolean;
  units: string;
  rotation: number;
  navigator: boolean;
  /** 并排显示多个视图（需要至少两个视图）。 */
  sideBySide: boolean;
  activeView: string;
  views: ViewFrame[];
  maxViews: number;
};

export type GuideColor = { vertical: boolean; position: number; rgb: Rgb };

export type GuideState = {
  horizontal: number[];
  vertical: number[];
  colors: GuideColor[];
  visible: boolean;
  locked: boolean;
};

export type ViewTransformState = {
  zoom: number;
  offset: Point;
  rotation: number;
  valid: boolean;
};

export type RulerInfo = {
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
  l1: number;
  l2: number | null;
  length: number;
  units: string;
  protractor: boolean;
};

export type RulerState = {
  start: Point;
  end: Point;
  protractor: Point | null;
  info: RulerInfo;
};

export type CountGroupView = {
  name: string;
  color: Rgb;
  markerSize: number;
  labelSize: number;
  visible: boolean;
  count: number;
  points: Point[];
};

export type MeasurementScaleView = {
  pixelLength: number;
  logicalLength: number;
  units: string;
  describe: string;
};

export type NoteView = {
  index: number;
  author: string;
  text: string;
  color: Rgb;
  position: Point;
  open: boolean;
};

/** 取样点：真实源像素读数（会话状态）。 */
export type SamplerReadout = {
  index: number;
  number: number;
  position: Point;
  rgb: Rgb;
  cmyk: Rgba;
};

export type ViewSnapshot = {
  scope: Record<string, string>;
  /** 快照所属文档身份：写入时回传成 `targetDocument`，切标签后旧面板不会写到新文档。 */
  document?: { id: number };
  guides: GuideState;
  rulerOrigin: Point;
  units: string;
  unitOptions: string[];
  snapTargets: string[];
  maxViews: number;
  sideBySide: boolean;
  documentSize: Point;
  rotation: number;
  transform: ViewTransformState;
  projected: { origin: Point; center: Point };
  samplers: { index: number; position: Point }[];
  measurement: {
    scale: MeasurementScaleView;
    ruler: RulerState | null;
    count: { total: number; activeGroup: number; groups: CountGroupView[] };
    logRows: number;
  };
  notes: NoteView[];
};

/** 测量日志的一行（`measurementLog.list` 的原样行，只校验可显示字段）。 */
export type MeasurementRow = { id: number; values: Record<string, string | number> };

export type MeasurementLog = { rows: MeasurementRow[]; columns: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const bool = (value: unknown): value is boolean => typeof value === "boolean";

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;

function point(value: unknown): Point | null {
  return Array.isArray(value) && value.length === 2 && value.every(finite)
    ? [value[0], value[1]]
    : null;
}

function rgb(value: unknown): Rgb | null {
  return Array.isArray(value) && value.length === 3 && value.every(finite)
    ? [value[0], value[1], value[2]]
    : null;
}

function rgba(value: unknown): Rgba | null {
  return Array.isArray(value) && value.length === 4 && value.every(finite)
    ? [value[0], value[1], value[2], value[3]]
    : null;
}

function numbers(value: unknown, max: number): number[] | null {
  return Array.isArray(value) && value.length <= max && value.every(finite)
    ? (value as number[])
    : null;
}

function int(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

/** 取布尔值（`null` 表示类型不对；用返回值而不是类型谓词，才能让局部变量被收窄）。 */
function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** 取有限数值。 */
function num(value: unknown): number | null {
  return finite(value) ? value : null;
}

function strings(value: unknown, max: number): string[] | null {
  return Array.isArray(value) && value.length <= max && value.every((entry) => text(entry, 64))
    ? (value as string[])
    : null;
}

function decodeFrame(value: unknown): ViewFrame | null {
  if (!isRecord(value)) return null;
  const { id, label, zoom, rotation } = value;
  const offset = point(value.offset);
  if (!text(id, 64) || !text(label, 128) || !finite(zoom) || zoom <= 0 || !finite(rotation) || !offset) {
    return null;
  }
  if (!bool(value.active)) return null;
  return { id, label, zoom, offset, rotation, active: value.active };
}

/** 视图辅助状态（`viewAidsJson`/`setViewAids` 的返回值）。 */
export function decodeViewAids(value: unknown): ViewAids | null {
  if (!isRecord(value) || !isRecord(value.snap)) return null;
  const gridStep = point(value.gridStep);
  const gridSubdivisions = int(value.gridSubdivisions, 1, 32);
  const maxViews = int(value.maxViews, 1, 64);
  const { snap } = value;
  const snapDocument = flag(snap.document);
  const snapGuides = flag(snap.guides);
  const snapGrid = flag(snap.grid);
  const snapLayers = flag(snap.layers);
  const snapSelection = flag(snap.selection);
  if (!gridStep || gridSubdivisions === null || maxViews === null) return null;
  if (snapDocument === null || snapGuides === null || snapGrid === null) return null;
  if (snapLayers === null || snapSelection === null) return null;
  if (!Array.isArray(value.views) || value.views.length < 1 || value.views.length > maxViews) return null;
  const views: ViewFrame[] = [];
  for (const entry of value.views) {
    const frame = decodeFrame(entry);
    if (!frame) return null;
    views.push(frame);
  }
  const rulers = flag(value.rulers);
  const grid = flag(value.grid);
  const guides = flag(value.guides);
  const lockGuides = flag(value.lockGuides);
  const smartGuides = flag(value.smartGuides);
  const suspend = flag(value.suspend);
  const navigator = flag(value.navigator);
  // 并排开关是新增字段：旧运行时没有它，缺失按 `false`（单视图）处理，不算坏数据。
  const sideBySide = value.sideBySide === undefined ? false : flag(value.sideBySide);
  if (rulers === null || grid === null || guides === null || lockGuides === null) return null;
  if (smartGuides === null || suspend === null || navigator === null) return null;
  if (sideBySide === null) return null;
  const { units, activeView, rotation } = value;
  if (!text(units, 8) || !text(activeView, 64)) return null;
  if (!views.some((frame) => frame.id === activeView)) return null;
  if (views.filter((frame) => frame.active).length !== 1) return null;
  if (!finite(rotation) || Math.abs(rotation) > 360) return null;
  return {
    rulers,
    grid,
    gridStep,
    gridSubdivisions,
    guides,
    lockGuides,
    smartGuides,
    snap: {
      document: snapDocument,
      guides: snapGuides,
      grid: snapGrid,
      layers: snapLayers,
      selection: snapSelection,
    },
    suspend,
    units,
    rotation,
    navigator,
    sideBySide,
    activeView,
    views,
    maxViews,
  };
}

function decodeGuides(value: unknown): GuideState | null {
  if (!isRecord(value)) return null;
  const horizontal = numbers(value.horizontal, 4096);
  const vertical = numbers(value.vertical, 4096);
  const visible = flag(value.visible);
  const locked = flag(value.locked);
  if (!horizontal || !vertical || visible === null || locked === null) return null;
  if (!Array.isArray(value.colors) || value.colors.length > horizontal.length + vertical.length) return null;
  const colors: GuideColor[] = [];
  for (const entry of value.colors) {
    if (!isRecord(entry) || !bool(entry.vertical) || !finite(entry.position)) return null;
    const entryRgb = rgb(entry.rgb);
    if (!entryRgb) return null;
    colors.push({ vertical: entry.vertical, position: entry.position, rgb: entryRgb });
  }
  return { horizontal, vertical, colors, visible, locked };
}

function decodeRulerInfo(value: unknown): RulerInfo | null {
  if (!isRecord(value)) return null;
  const x = num(value.x);
  const y = num(value.y);
  const w = num(value.w);
  const h = num(value.h);
  const angle = num(value.angle);
  const l1 = num(value.l1);
  const length = num(value.length);
  if (x === null || y === null || w === null || h === null) return null;
  if (angle === null || l1 === null || length === null) return null;
  const l2 = value.l2 === null ? null : num(value.l2);
  if (value.l2 !== null && l2 === null) return null;
  const units = value.units;
  const protractor = flag(value.protractor);
  if (!text(units, 8) || protractor === null) return null;
  return { x, y, w, h, angle, l1, l2, length, units, protractor };
}

function decodeRuler(value: unknown): RulerState | null {
  if (value === null) return null;
  if (!isRecord(value)) return null;
  const start = point(value.start);
  const end = point(value.end);
  const protractor = value.protractor === null ? null : point(value.protractor);
  const info = decodeRulerInfo(value.info);
  if (!start || !end || !info || (value.protractor !== null && !protractor)) return null;
  return { start, end, protractor, info };
}

/**
 * 一个计数分组。
 *
 * `remaining` 是**解码前**已算好的剩余标记预算：先按剩余额度判长度，再逐点校验，因此一份声称
 * 有几十万标记的工程不会先被完整遍历一遍再拒绝（与协议 `validCountGroups`、Rust
 * `features/views/mod.rs` 的累计预算同一顺序）。
 */
function decodeCountGroup(value: unknown, remaining: number): CountGroupView | null {
  if (!isRecord(value)) return null;
  const color = rgb(value.color);
  const markerSize = int(value.markerSize, 1, 10);
  const labelSize = int(value.labelSize, 8, 72);
  const count = int(value.count, 0, 100_000);
  if (!text(value.name, 256) || !color || markerSize === null || labelSize === null || count === null) return null;
  if (!bool(value.visible) || !Array.isArray(value.points)) return null;
  if (count > remaining) return null;
  if (value.points.length > remaining || value.points.length > count) return null;
  const points: Point[] = [];
  for (const entry of value.points) {
    const parsed = point(entry);
    if (!parsed) return null;
    points.push(parsed);
  }
  if (points.length !== count) return null;
  return {
    name: value.name,
    color,
    markerSize,
    labelSize,
    visible: value.visible,
    count,
    points,
  };
}

function decodeNote(value: unknown): NoteView | null {
  if (!isRecord(value)) return null;
  const index = int(value.index, 0, 1024);
  const color = rgb(value.color);
  const position = point(value.position);
  if (index === null || !color || !position) return null;
  if (!text(value.author, 256) || !text(value.text, 64 * 1024) || !bool(value.open)) return null;
  return { index, author: value.author, text: value.text, color, position, open: value.open };
}

/** 视图与分析快照（`viewSnapshotJson`）。 */
export function decodeViewSnapshot(value: unknown): ViewSnapshot | null {
  if (!isRecord(value) || !isRecord(value.scope)) return null;
  // 文档身份是可选的：尚未重建的旧运行时没有该字段，界面退回「不参与守卫」而不是整块不显示。
  // 有该字段就必须是合法 id，绝不编造一个（非对象、非整数、负数都算坏数据）。
  if (value.document !== undefined && value.document !== null && !isRecord(value.document)) return null;
  const documentId = isRecord(value.document) ? int(value.document.id, 0, Number.MAX_SAFE_INTEGER) : undefined;
  if (documentId === null) return null;
  const scope: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value.scope)) {
    if (!text(entry, 32)) return null;
    scope[key] = entry;
  }
  const guides = decodeGuides(value.guides);
  const rulerOrigin = point(value.rulerOrigin);
  const documentSize = point(value.documentSize);
  const unitOptions = strings(value.unitOptions, 16);
  const snapTargets = strings(value.snapTargets, 16);
  const maxViews = int(value.maxViews, 1, 64);
  const sideBySide = value.sideBySide === undefined ? false : flag(value.sideBySide);
  if (!guides || !rulerOrigin || !documentSize || !unitOptions || !snapTargets || maxViews === null) return null;
  if (sideBySide === null) return null;
  if (!text(value.units, 8) || !finite(value.rotation) || Math.abs(value.rotation) > 360) return null;
  if (!isRecord(value.transform) || !isRecord(value.projected)) return null;
  const transformOffset = point(value.transform.offset);
  const projectedOrigin = point(value.projected.origin);
  const projectedCenter = point(value.projected.center);
  if (!transformOffset || !projectedOrigin || !projectedCenter) return null;
  if (!finite(value.transform.zoom) || value.transform.zoom <= 0) return null;
  if (!finite(value.transform.rotation) || !bool(value.transform.valid)) return null;
  if (!Array.isArray(value.samplers) || value.samplers.length > 10) return null;
  const samplers: { index: number; position: Point }[] = [];
  for (const entry of value.samplers) {
    if (!isRecord(entry)) return null;
    const index = int(entry.index, 0, 9);
    const position = point(entry.position);
    if (index === null || !position) return null;
    samplers.push({ index, position });
  }
  if (!isRecord(value.measurement) || !isRecord(value.measurement.scale) || !isRecord(value.measurement.count)) {
    return null;
  }
  const { scale, count } = value.measurement;
  if (!finite(scale.pixelLength) || !finite(scale.logicalLength) || !text(scale.units, 32) || !text(scale.describe, 200)) {
    return null;
  }
  const total = int(count.total, 0, 100_000);
  const activeGroup = int(count.activeGroup, 0, 255);
  const logRows = int(value.measurement.logRows, 0, 1_000_000);
  if (total === null || activeGroup === null || logRows === null) return null;
  if (!Array.isArray(count.groups) || count.groups.length > 256) return null;
  const groups: CountGroupView[] = [];
  let markerBudget = 100_000;
  for (const entry of count.groups) {
    const group = decodeCountGroup(entry, markerBudget);
    if (!group) return null;
    markerBudget -= group.count;
    groups.push(group);
  }
  if (groups.reduce((sum, group) => sum + group.count, 0) !== total) return null;
  if (groups.length > 0 && activeGroup >= groups.length) return null;
  const ruler = value.measurement.ruler === null ? null : decodeRuler(value.measurement.ruler);
  if (value.measurement.ruler !== null && ruler === null) return null;
  if (!Array.isArray(value.notes) || value.notes.length > 1024) return null;
  const notes: NoteView[] = [];
  for (const entry of value.notes) {
    const note = decodeNote(entry);
    if (!note) return null;
    notes.push(note);
  }
  return {
    scope,
    ...(documentId === undefined ? {} : { document: { id: documentId } }),
    guides,
    rulerOrigin,
    units: value.units,
    unitOptions,
    snapTargets,
    maxViews,
    sideBySide,
    documentSize,
    rotation: value.rotation,
    transform: {
      zoom: value.transform.zoom,
      offset: transformOffset,
      rotation: value.transform.rotation,
      valid: value.transform.valid,
    },
    projected: { origin: projectedOrigin, center: projectedCenter },
    samplers,
    measurement: {
      scale: {
        pixelLength: scale.pixelLength,
        logicalLength: scale.logicalLength,
        units: scale.units,
        describe: scale.describe,
      },
      ruler,
      count: { total, activeGroup, groups },
      logRows,
    },
    notes,
  };
}

/** 单个取样点读数（`samplerReadoutJson`）。 */
export function decodeSamplerReadout(value: unknown): SamplerReadout | null {
  if (!isRecord(value)) return null;
  const index = int(value.index, 0, 9);
  const number = int(value.number, 1, 10);
  const position = point(value.position);
  const rgbValue = rgb(value.rgb);
  const cmyk = rgba(value.cmyk);
  if (index === null || number === null || !position || !rgbValue || !cmyk) return null;
  if (!rgbValue.every((channel) => channel >= 0 && channel <= 255)) return null;
  if (!cmyk.every((channel) => channel >= 0 && channel <= 100)) return null;
  return { index, number, position, rgb: rgbValue, cmyk };
}

/** 长度格式化（`formatLengthJson`）：只回文本，不改文档。 */
export function decodeLengthFormat(value: unknown): { text: string; unit: string } | null {
  if (!isRecord(value) || !text(value.text, 64) || !value.text.trim()) return null;
  if (!text(value.unit, 8) || !value.unit.trim()) return null;
  return { text: value.text, unit: value.unit };
}

/** 参考线命中结果（`viewPointerJson("hit-guide")` 的 `hit`）。 */
export type GuideHitView = {
  vertical: boolean;
  index: number;
  position: number;
  distance: number;
};

/**
 * 参考线命中（U70）：`{ locked, hit }`。
 *
 * `hit` 允许为 `null`（空画布或没命中），但出现时必须字段完整——界面不猜一个「大概命中了」的
 * 状态去拖动。`locked` 缺失时视为锁定，避免误把只读视图当成可拖动。
 */
export function decodeGuideHit(value: unknown): { locked: boolean; hit: GuideHitView | null } | null {
  if (!isRecord(value) || typeof value.locked !== "boolean") return null;
  if (value.hit === null || value.hit === undefined) return { locked: value.locked, hit: null };
  const hit = value.hit;
  if (!isRecord(hit) || typeof hit.vertical !== "boolean") return null;
  const index = int(hit.index, 0, 100_000);
  const position = num(hit.position);
  const distance = num(hit.distance);
  if (index === null || position === null || distance === null || distance < 0) return null;
  return { locked: value.locked, hit: { vertical: hit.vertical, index, position, distance } };
}

/** 拖动中的参考线位置（`viewPointerJson("drag-guide")`）。 */
export function decodeGuideDrag(value: unknown): { vertical: boolean; position: number | null; locked: boolean } | null {
  if (!isRecord(value) || typeof value.vertical !== "boolean" || typeof value.locked !== "boolean") return null;
  if (value.position === null || value.position === undefined) {
    return { vertical: value.vertical, position: null, locked: value.locked };
  }
  const position = num(value.position);
  if (position === null) return null;
  return { vertical: value.vertical, position, locked: value.locked };
}

/** 标尺原点拖动候选（`viewPointerJson("drag-origin")`）。 */
export function decodeRulerOriginDrag(value: unknown): { origin: Point | null; current: Point } | null {
  if (!isRecord(value)) return null;
  const current = point(value.current);
  if (!current) return null;
  if (value.origin === null || value.origin === undefined) return { origin: null, current };
  const origin = point(value.origin);
  if (!origin) return null;
  return { origin, current };
}

/**
 * Info 跟随光标的源像素读数（`viewPointerJson("probe")`，U73）。
 *
 * `reading` 为 `null` 表示光标在画布外：界面必须显示「—」，不能拿上一次读数冒充当前位置，
 * 也不能估一个像素。`pixel` 是落到的整数源像素，`source` 是连续源坐标（用于显示位置）。
 */
export type ProbeReading = {
  unit: string;
  reading: {
    source: Point;
    pixel: Point;
    rgb: Rgb;
    cmyk: Rgba;
  } | null;
};

const channel = (value: unknown, max: number): number | null =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max ? (value as number) : null;

/** `viewPointerJson("probe")` 的有界解码。 */
export function decodeProbe(value: unknown): ProbeReading | null {
  if (!isRecord(value) || !text(value.unit, 8) || !value.unit.trim()) return null;
  if (value.reading === null || value.reading === undefined) return { unit: value.unit, reading: null };
  const { reading } = value;
  if (!isRecord(reading)) return null;
  const source = point(reading.source);
  const pixel = point(reading.pixel);
  if (!source || !pixel) return null;
  if (!Array.isArray(reading.rgb) || reading.rgb.length !== 3) return null;
  if (!Array.isArray(reading.cmyk) || reading.cmyk.length !== 4) return null;
  const rgb = reading.rgb.map((entry) => channel(entry, 255));
  const cmyk = reading.cmyk.map((entry) => channel(entry, 100));
  if (rgb.some((entry) => entry === null) || cmyk.some((entry) => entry === null)) return null;
  return {
    unit: value.unit,
    reading: { source, pixel, rgb: rgb as Rgb, cmyk: cmyk as Rgba },
  };
}

/** 测量日志（`measurementLog.list`）。 */
export function decodeMeasurementLog(value: unknown): MeasurementLog | null {
  if (!isRecord(value) || !Array.isArray(value.rows) || !Array.isArray(value.columns)) return null;
  if (value.rows.length > 100_000) return null;
  const columns = strings(value.columns, 64);
  if (!columns) return null;
  const rows: MeasurementRow[] = [];
  for (const entry of value.rows) {
    if (!isRecord(entry) || !isRecord(entry.values)) return null;
    const id = int(entry.id, 0, 1e12);
    if (id === null) return null;
    const values: Record<string, string | number> = {};
    for (const [key, cell] of Object.entries(entry.values)) {
      if (typeof cell === "number" && Number.isFinite(cell)) values[key] = cell;
      else if (typeof cell === "string" && cell.length <= 512) values[key] = cell;
      else return null;
    }
    rows.push({ id, values });
  }
  return { rows, columns };
}
