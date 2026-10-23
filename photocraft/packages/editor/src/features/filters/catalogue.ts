/**
 * 滤镜清单的界面侧契约：解码内核目录、生成默认参数、编辑画廊组合与图内几何。
 *
 * 目录与参数范围**不在这里手写**：面板只解码 `WasmEditor.filterCatalogueJson()` 的响应，
 * 范围/默认值/选项全部来自内核命令注册表（Rust `features/filters/catalog.rs`）。这里只做
 * 三件事：
 *
 * 1. 把不可信的 JSON 收成有界类型（形状、数值有限性、上限），解码失败就不渲染面板；
 * 2. 纯函数式的组合/控制点/平面编辑，供面板复用并可在无 DOM 下回归；
 * 3. 参数输入的本地规范化（夹范围、整数化、选项校验），保证提交给内核的始终是有效值。
 *
 * 本模块不持有文档、历史或内核状态：草稿仍由 `EditorWorkspaceController` 统一门禁。
 */

/** 滤镜交互形态（与 Rust `catalog::Kind` 一一对应）。 */
export const FILTER_KINDS = [
  "simple",
  "random",
  "gallery",
  "galleryStack",
  "blurGallery",
  "lens",
  "cameraRaw",
  "vanishingPoint"
] as const;
export type FilterKind = (typeof FILTER_KINDS)[number];

/** 参数控件形态（与 Rust `catalog::ParamKind` 一一对应）。 */
export const FILTER_PARAM_KINDS = ["number", "integer", "choice", "bool", "color", "resource"] as const;
export type FilterParamKind = (typeof FILTER_PARAM_KINDS)[number];

/**
 * 本域上限的**协议下限**：内核可以更严，但不能比这里宽。
 *
 * 数值与 `rust/crates/editor-core/src/features/filters/catalog.rs` 的 `MAX_*` 常量、
 * `catalog::catalogue()["limits"]` 输出逐项相同；两侧各有一条测试钉住这些字面量。
 */
export const FILTER_LIMITS = {
  maxEffects: 32,
  maxPins: 16,
  maxPlanes: 8,
  maxParams: 96,
  maxResourcePoints: 64,
  /** u32::MAX：随机滤镜冻结 seed 的合法范围。 */
  seedMax: 4_294_967_295
} as const;

export type FilterLimits = {
  maxEffects: number;
  maxPins: number;
  maxPlanes: number;
  maxParams: number;
  maxResourcePoints: number;
  seedMax: number;
};

export type FilterParamSpec = {
  key: string;
  kind: FilterParamKind;
  min: number | null;
  max: number | null;
  default: unknown;
  choices: string[];
};

export type FilterEntry = {
  id: string;
  label: string;
  category: string;
  kind: FilterKind;
  usesColours: boolean;
  needsMap: boolean;
  params: FilterParamSpec[];
};

export type GalleryFilterEntry = {
  key: string;
  name: string;
  category: string;
  command: string;
  params: FilterParamSpec[];
};

export type FilterGallery = { categories: string[]; filters: GalleryFilterEntry[] };

export type FilterCatalogue = { filters: FilterEntry[]; gallery: FilterGallery; limits: FilterLimits };

/** 草稿状态（`filterDraftStateJson` / 开始与更新后的回执）。 */
export type FilterDraftInfo = {
  filter: string;
  label: string;
  category: string;
  kind: string;
  layer: number;
  params: Record<string, unknown>;
};

/** 「重复上次」的可用性与规范参数。 */
export type FilterLast =
  | { available: true; filter: string; label: string; params: Record<string, unknown> }
  | { available: false; reason: string };

export type FilterStackEffect = { filter: string; params: Record<string, unknown>; visible: boolean };

export type FilterPin = { x: number; y: number; blur: number };

/**
 * 透视平面的四个角点，**文档像素坐标**（与内核 `filter.vanishingPoint` 的 `corners` 同单位）。
 *
 * 内核把角点当画布像素去算凸性与单应矩阵：写成 0–1 相对值会让整个平面退化成亚像素，
 * 内核按「不是凸四边形」拒绝，因此面板必须用文档尺寸来换算与夹取。
 */
export type FilterPlane = { corners: [[number, number], [number, number], [number, number], [number, number]] };

/** 画布尺寸：图内几何（透视平面、广角约束线）的坐标单位。 */
export type FilterDocumentSize = { width: number; height: number };

/** 置换滤镜可选的位移图来源：会话里已打开的文档（本域不读本机路径）。 */
export type FilterMapSource = {
  index: number;
  name: string;
  width: number;
  height: number;
  active: boolean;
  /** 该文档里可当作位移图的像素图层（内核 `mapLayer` 收这份文档内的图层 id）。 */
  layers: FilterMapLayer[];
};

/** 位移图文档里的一层：`id` 是内核 `LayerId`，与 `mapLayer` 同单位。 */
export type FilterMapLayer = { id: number; name: string };

export type FilterConstraint = { a: [number, number]; b: [number, number]; orientation: "free" | "horizontal" | "vertical" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isNonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

const isFilterKind = (value: unknown): value is FilterKind =>
  typeof value === "string" && (FILTER_KINDS as readonly string[]).includes(value);
const isParamKind = (value: unknown): value is FilterParamKind =>
  typeof value === "string" && (FILTER_PARAM_KINDS as readonly string[]).includes(value);

/** 参数 schema：单个字段不合法就丢弃整条命令，避免面板画出半套滑杆。 */
function decodeParam(value: unknown): FilterParamSpec | null {
  if (!isRecord(value)) return null;
  const key = value.key;
  if (typeof key !== "string" || !key || key.length > 64) return null;
  if (!isParamKind(value.kind)) return null;
  const min = value.min === null || value.min === undefined ? null : value.min;
  const max = value.max === null || value.max === undefined ? null : value.max;
  if (min !== null && !isFiniteNumber(min)) return null;
  if (max !== null && !isFiniteNumber(max)) return null;
  if (min !== null && max !== null && min > max) return null;
  const choices = Array.isArray(value.choices)
    ? value.choices.filter((choice): choice is string => typeof choice === "string" && choice.length <= 64)
    : [];
  if (choices.length !== (Array.isArray(value.choices) ? value.choices.length : 0)) return null;
  if (value.kind === "choice" && choices.length === 0) return null;
  if (value.kind === "choice" && value.default !== undefined && value.default !== null
    && (typeof value.default !== "string" || !choices.includes(value.default))) return null;
  return { key, kind: value.kind, min, max, default: value.default ?? null, choices };
}

function decodeParams(value: unknown, limits: FilterLimits): FilterParamSpec[] | null {
  const items = Array.isArray(value) ? value : [];
  if (items.length > limits.maxParams) return null;
  const params: FilterParamSpec[] = [];
  for (const item of items) {
    const spec = decodeParam(item);
    if (!spec) return null;
    if (params.some((existing) => existing.key === spec.key)) return null;
    params.push(spec);
  }
  return params;
}

function decodeLimits(value: unknown): FilterLimits | null {
  if (!isRecord(value)) return null;
  const limits: FilterLimits = {
    maxEffects: FILTER_LIMITS.maxEffects,
    maxPins: FILTER_LIMITS.maxPins,
    maxPlanes: FILTER_LIMITS.maxPlanes,
    maxParams: FILTER_LIMITS.maxParams,
    maxResourcePoints: FILTER_LIMITS.maxResourcePoints,
    seedMax: FILTER_LIMITS.seedMax
  };
  for (const key of Object.keys(limits) as (keyof FilterLimits)[]) {
    const reported = value[key];
    if (reported === undefined) continue;
    // 内核可以更严（更小的上限），但不能比协议声明更宽。
    if (!isNonNegativeInteger(reported) || reported < 1 || reported > FILTER_LIMITS[key]) return null;
    limits[key] = reported;
  }
  if (limits.maxEffects < 1 || limits.maxPins < 1 || limits.maxPlanes < 1 || limits.maxParams < 1) return null;
  return limits;
}

/** 解码内核滤镜清单；任何结构问题都返回 null（面板不渲染半套清单）。 */
export function decodeFilterCatalogue(value: unknown): FilterCatalogue | null {
  if (!isRecord(value) || !Array.isArray(value.filters)) return null;
  const limits = decodeLimits(value.limits);
  if (!limits) return null;
  const filters: FilterEntry[] = [];
  for (const item of value.filters) {
    if (!isRecord(item)) return null;
    const { id, label, category, kind } = item;
    if (typeof id !== "string" || !id.startsWith("filter.") || id.length > 120) return null;
    if (typeof label !== "string" || !label || label.length > 120) return null;
    if (typeof category !== "string" || category.length > 40) return null;
    if (!isFilterKind(kind)) return null;
    const params = decodeParams(item.params, limits);
    if (!params) return null;
    if (filters.some((entry) => entry.id === id)) return null;
    filters.push({
      id,
      label,
      category,
      kind,
      usesColours: item.usesColours === true,
      needsMap: item.needsMap === true,
      params
    });
  }
  if (filters.length === 0) return null;
  const gallery = decodeGallery(value.gallery, limits);
  if (!gallery) return null;
  return { filters, gallery, limits };
}

/** 解码画廊目录（Filter Gallery 的分类与单个滤镜参数）。 */
export function decodeGallery(value: unknown, limits: FilterLimits = FILTER_LIMITS): FilterGallery | null {
  if (!isRecord(value) || !Array.isArray(value.filters)) return null;
  const categories = Array.isArray(value.categories)
    ? value.categories.filter((entry): entry is string => typeof entry === "string" && entry.length <= 64)
    : [];
  if (Array.isArray(value.categories) && categories.length !== value.categories.length) return null;
  const filters: GalleryFilterEntry[] = [];
  for (const item of value.filters) {
    if (!isRecord(item)) return null;
    const { key, name, category, command } = item;
    if (typeof key !== "string" || !key || key.length > 64) return null;
    if (typeof name !== "string" || !name || name.length > 120) return null;
    if (typeof category !== "string" || category.length > 64) return null;
    if (typeof command !== "string" || !command.startsWith("filter.")) return null;
    const params = decodeParams(item.params, limits);
    if (!params) return null;
    if (filters.some((entry) => entry.key === key)) return null;
    filters.push({ key, name, category, command, params });
  }
  return { categories, filters };
}

/**
 * 解码草稿状态；`null` 表示当前没有草稿。
 *
 * 只有命令与规范参数是硬要求：它们是面板与提交唯一依赖的字段。展示用元数据（名称、归类、
 * 形态）与目标图层允许缺席，缺了就按命令自身补一个可读占位，避免宿主只回核心字段时整个
 * 面板不可用；但这些字段若出现且类型不对，仍然判为无效回执。
 */
export function decodeFilterDraft(value: unknown): FilterDraftInfo | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return null;
  const { filter } = value;
  if (typeof filter !== "string" || !filter.startsWith("filter.") || filter.length > 120) return null;
  const params = value.params === undefined || value.params === null ? {} : value.params;
  if (!isRecord(params)) return null;
  const label = value.label === undefined ? filter : value.label;
  const category = value.category === undefined ? "" : value.category;
  const kind = value.kind === undefined ? "" : value.kind;
  const layer = value.layer === undefined ? 0 : value.layer;
  if (typeof label !== "string" || typeof category !== "string" || typeof kind !== "string") return null;
  if (!isNonNegativeInteger(layer)) return null;
  return { filter, label, category, kind, layer, params };
}

/** 解码「上次滤镜」：不可用要带原因，可用要带规范参数。 */
export function decodeFilterLast(value: unknown): FilterLast | null {
  if (!isRecord(value)) return null;
  if (value.available === false) {
    return { available: false, reason: typeof value.reason === "string" && value.reason ? value.reason : "还没有可重复的滤镜" };
  }
  if (value.available !== true) return null;
  if (typeof value.filter !== "string" || !value.filter.startsWith("filter.")) return null;
  if (typeof value.label !== "string" || !value.label) return null;
  if (!isRecord(value.params)) return null;
  return { available: true, filter: value.filter, label: value.label, params: value.params };
}

/** 解码默认画廊组合（内核给出，面板不自己编一套）。 */
export function decodeFilterStack(value: unknown): FilterStackEffect[] | null {
  if (!isRecord(value) || !Array.isArray(value.effects)) return null;
  const effects: FilterStackEffect[] = [];
  for (const item of value.effects) {
    const effect = decodeStackEffect(item);
    if (!effect) return null;
    effects.push(effect);
  }
  return effects.length > 0 ? effects : null;
}

function decodeStackEffect(value: unknown): FilterStackEffect | null {
  if (!isRecord(value)) return null;
  if (typeof value.filter !== "string" || !value.filter) return null;
  if (!isRecord(value.params)) return null;
  return { filter: value.filter, params: { ...value.params }, visible: value.visible !== false };
}

/**
 * 解码位移图来源列表。
 *
 * 一项不合法就丢掉那一项，而不是整份失败：来源列表只是选择器的候选，少一行比整块不可用
 * 更符合用户预期；但仍要求是数组，避免把「端口返回了别的东西」当成空列表。
 */
export function decodeFilterMapSources(value: unknown): FilterMapSource[] | null {
  if (!isRecord(value) || !Array.isArray(value.documents)) return null;
  const sources: FilterMapSource[] = [];
  for (const item of value.documents) {
    if (!isRecord(item)) continue;
    if (!isNonNegativeInteger(item.index)) continue;
    if (typeof item.name !== "string" || item.name.length > 256) continue;
    const width = item.width;
    const height = item.height;
    if (!isNonNegativeInteger(width) || !isNonNegativeInteger(height)) continue;
    // 图层列表缺失按「没有可用图层」处理：老端口不带这个字段时面板退化成只能压平整份文档，
    // 而不是整条来源不可用。
    const layers: FilterMapLayer[] = [];
    if (Array.isArray(item.layers)) {
      for (const layer of item.layers) {
        if (!isRecord(layer)) continue;
        if (!isNonNegativeInteger(layer.id)) continue;
        if (typeof layer.name !== "string" || layer.name.length > 256) continue;
        layers.push({ id: layer.id, name: layer.name });
      }
    }
    sources.push({ index: item.index, name: item.name, width, height, active: item.active === true, layers });
  }
  return sources;
}

/**
 * 写回位移图来源：`mapDocument` 是唯一入口，空值表示清除来源。
 *
 * 内核只认 `mapPath`（本应用一律拒绝）或 `mapDocument`；换文档时同时删掉 `mapLayer`，
 * 否则会拿着上一份文档的图层号去取图。纯函数、不改入参，便于面板与测试共用。
 */
export function withMapDocument(params: Record<string, unknown>, source: unknown): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  delete next.mapPath;
  if (typeof source === "string" && source !== "") {
    next.mapDocument = source;
    delete next.mapLayer;
    return next;
  }
  delete next.mapDocument;
  delete next.mapLayer;
  return next;
}

/**
 * 写回位移图的图层（`mapLayer`）。
 *
 * 内核 `map_from_document` 收**位移图文档内**的图层 id：不给就压平整份文档。这里只接受非负
 * 整数 id，`null` 表示「整份文档」并删掉字段（不是写 0——0 会被当成一个不存在的图层）。没有
 * 选定位移图文档时也删掉，否则会拿着别的文档的图层号去取图。
 */
export function withMapLayer(params: Record<string, unknown>, layer: number | null): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  const doc = next.mapDocument;
  if (typeof doc !== "string" || doc === "" || layer === null || !isNonNegativeInteger(layer)) {
    delete next.mapLayer;
    return next;
  }
  next.mapLayer = layer;
  return next;
}

/** 当前选中的位移图图层 id；未选或非法时返回 `null`（表示压平整份文档）。 */
export function mapLayerOf(params: Record<string, unknown>): number | null {
  const value = params.mapLayer;
  return isNonNegativeInteger(value) ? value : null;
}

/** 按归类分组，保持内核清单里的出现顺序（面板不做二次排序）。 */
export function catalogueCategories(catalogue: FilterCatalogue): { category: string; filters: FilterEntry[] }[] {
  const groups: { category: string; filters: FilterEntry[] }[] = [];
  for (const entry of catalogue.filters) {
    const group = groups.find((candidate) => candidate.category === entry.category);
    if (group) group.filters.push(entry);
    else groups.push({ category: entry.category, filters: [entry] });
  }
  return groups;
}

/** 面板初值：取内核默认值；随机 seed 与结构型字段留给内核冻结/几何编辑。 */
export function defaultParams(entry: FilterEntry): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const spec of entry.params) {
    if (spec.key === "seed" || spec.kind === "resource" || spec.default === null) continue;
    params[spec.key] = spec.default;
  }
  return params;
}

/** 把本地输入规范化成内核接受的标量；非法输入返回 null（面板不提交）。 */
export function coerceParam(spec: FilterParamSpec, raw: unknown): number | string | boolean | null {
  switch (spec.kind) {
    case "number": {
      const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
      if (!Number.isFinite(value)) return null;
      const min = spec.min ?? Number.NEGATIVE_INFINITY;
      const max = spec.max ?? Number.POSITIVE_INFINITY;
      if (value < min || value > max) return null;
      return value;
    }
    case "integer": {
      const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
      if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
      const min = spec.min ?? 0;
      const max = spec.max ?? Number.MAX_SAFE_INTEGER;
      if (value < min || value > max) return null;
      return value;
    }
    case "choice":
      return typeof raw === "string" && spec.choices.includes(raw) ? raw : null;
    case "bool":
      return typeof raw === "boolean" ? raw : null;
    case "color": {
      const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      if (!/^#[0-9a-f]{6}$/.test(text)) return null;
      if (spec.default !== null && typeof spec.default === "string" && spec.default.startsWith("#") && spec.default.length === 7) return text;
      return text;
    }
    case "resource":
      return null;
  }
}

/** 数字输入的步进：整数固定 1，小数按范围给一个可用的精度。 */
export function paramStep(spec: FilterParamSpec): number {
  if (spec.kind === "integer") return 1;
  if (spec.min === null || spec.max === null) return 1;
  const span = spec.max - spec.min;
  if (span <= 2) return 0.01;
  if (span <= 20) return 0.1;
  return 1;
}

/** 面板显示的当前值：草稿规范参数优先，其次内核默认值。 */
export function currentValue(spec: FilterParamSpec, params: Record<string, unknown>): number | string | boolean | null {
  const value = params[spec.key] ?? spec.default;
  if (spec.kind === "bool") return typeof value === "boolean" ? value : false;
  if (spec.kind === "choice") return typeof value === "string" && spec.choices.includes(value) ? value : spec.choices[0] ?? null;
  if (spec.kind === "color") return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
  if (spec.kind === "number" || spec.kind === "integer") return isFiniteNumber(value) ? value : spec.min ?? 0;
  return null;
}

// ---------------------------------------------------------------- 滤镜库组合

/** 从规范参数读出效果栈（`filter.filterGallery`）。 */
export function stackEffects(params: Record<string, unknown>): FilterStackEffect[] {
  const items = Array.isArray(params.effects) ? params.effects : [];
  const effects: FilterStackEffect[] = [];
  for (const item of items) {
    const effect = decodeStackEffect(item);
    if (effect) effects.push(effect);
  }
  return effects;
}

/** 新效果用该滤镜自身的内核默认参数，避免叠加出「全 0」的无效层。 */
export function newEffect(entry: GalleryFilterEntry): FilterStackEffect {
  const params: Record<string, unknown> = {};
  for (const spec of entry.params) {
    if (spec.key === "seed" || spec.kind === "resource" || spec.default === null) continue;
    params[spec.key] = spec.default;
  }
  return { filter: entry.key, params, visible: true };
}

export function addEffect(effects: readonly FilterStackEffect[], effect: FilterStackEffect, max: number = FILTER_LIMITS.maxEffects): FilterStackEffect[] {
  if (effects.length >= max) return [...effects];
  return [...effects, effect];
}

export function removeEffect(effects: readonly FilterStackEffect[], index: number): FilterStackEffect[] {
  if (index < 0 || index >= effects.length) return [...effects];
  return effects.filter((_, at) => at !== index);
}

export function moveEffect(effects: readonly FilterStackEffect[], index: number, delta: number): FilterStackEffect[] {
  const target = index + delta;
  if (index < 0 || index >= effects.length || target < 0 || target >= effects.length) return [...effects];
  const next = [...effects];
  const [effect] = next.splice(index, 1);
  next.splice(target, 0, effect!);
  return next;
}

/** 换效果滤镜时整份参数换成新滤镜的默认值（旧字段对新滤镜没有意义）。 */
export function replaceEffect(effects: readonly FilterStackEffect[], index: number, entry: GalleryFilterEntry): FilterStackEffect[] {
  if (index < 0 || index >= effects.length) return [...effects];
  const next = [...effects];
  next[index] = { ...newEffect(entry), visible: next[index]!.visible };
  return next;
}

export function toggleEffect(effects: readonly FilterStackEffect[], index: number): FilterStackEffect[] {
  if (index < 0 || index >= effects.length) return [...effects];
  return effects.map((effect, at) => (at === index ? { ...effect, visible: !effect.visible } : effect));
}

/** 组合参数：可见效果至少留一层，否则内核会拒绝；这里提前给出可读原因。 */
export function stackParams(effects: readonly FilterStackEffect[], base: Record<string, unknown> = {}): Record<string, unknown> | null {
  if (effects.length === 0) return null;
  if (!effects.some((effect) => effect.visible)) return null;
  const params: Record<string, unknown> = { ...base, effects: effects.map((effect) => ({ ...effect, params: { ...effect.params } })) };
  delete params.seed;
  return params;
}

export function setEffectParam(effects: readonly FilterStackEffect[], index: number, key: string, value: unknown): FilterStackEffect[] {
  if (index < 0 || index >= effects.length) return [...effects];
  return effects.map((effect, at) => (at === index ? { ...effect, params: { ...effect.params, [key]: value } } : effect));
}

// ---------------------------------------------------------------- 模糊画廊控制点

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** 某条命令是否真的声明了某个参数（面板据此决定要不要写回它）。 */
export function declaresParam(entry: FilterEntry | undefined, key: string): boolean {
  return entry !== undefined && entry.params.some((spec) => spec.key === key);
}

/**
 * 控制点里「模糊量」的字段名。
 *
 * 场景/光圈模糊的控制点叫 `blur`，旋转模糊的控制点叫 `blurAngle`（单位是度数）。
 * 一律写 `blur` 会让旋转模糊的模糊滑块静默失效：值被内核忽略，画面只跟着别处变。
 */
export function blurPinKey(entry: FilterEntry | undefined): string {
  return declaresParam(entry, "blurAngle") ? "blurAngle" : "blur";
}

/** 控制点模糊量的取值范围：用命令声明的同名参数，缺省时退到通用的 0–500。 */
function pinAmountRange(entry: FilterEntry | undefined, key: string): { min: number; max: number } {
  const spec = entry?.params.find((candidate) => candidate.key === key);
  const min = spec && isFiniteNumber(spec.min) ? Math.max(0, spec.min) : 0;
  const max = spec && isFiniteNumber(spec.max) ? spec.max : 500;
  return { min, max };
}

/** 从规范参数读出控制点：显式 `pins` 优先，否则用中心/半径换算成一个点。 */
export function blurPins(
  params: Record<string, unknown>,
  max: number = FILTER_LIMITS.maxPins,
  entry?: FilterEntry
): FilterPin[] {
  const key = blurPinKey(entry);
  const range = pinAmountRange(entry, key);
  const items = Array.isArray(params.pins) ? params.pins : [];
  const pins: FilterPin[] = [];
  for (const item of items.slice(0, max)) {
    if (!isRecord(item)) continue;
    const x = isFiniteNumber(item.x) ? item.x : null;
    const y = isFiniteNumber(item.y) ? item.y : null;
    if (x === null || y === null) continue;
    // 旧面板写下的 `blur` 也认：旋转模糊的历史草稿仍然能读回来。
    const blur = isFiniteNumber(item[key])
      ? item[key]
      : isFiniteNumber(item.blur)
        ? item.blur
        : isFiniteNumber(params[key])
          ? (params[key] as number)
          : isFiniteNumber(params.blur)
            ? (params.blur as number)
            : 15;
    pins.push({ x: clamp01(x), y: clamp01(y), blur: clamp(blur, range.min, range.max) });
  }
  if (pins.length > 0) return pins;
  const fallback = isFiniteNumber(params[key])
    ? (params[key] as number)
    : isFiniteNumber(params.blur)
      ? (params.blur as number)
      : 15;
  return [
    {
      x: clamp01(isFiniteNumber(params.centerX) ? params.centerX : 0.5),
      y: clamp01(isFiniteNumber(params.centerY) ? params.centerY : 0.5),
      blur: clamp(fallback, range.min, range.max)
    }
  ];
}

/**
 * 控制点写回参数。
 *
 * `pins` 只在命令真的声明了它时才写：移轴模糊没有 `pins` 字段（它的几何是中心/角度/焦点带），
 * 路径模糊的几何是 `paths`。无条件写入会让内核以「没有参数 pins」拒绝整次草稿，用户看到的
 * 是滤镜完全不可用。中心同步同样只改已声明的键。
 */
export function withBlurPins(
  params: Record<string, unknown>,
  pins: readonly FilterPin[],
  entry?: FilterEntry
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  const carriesPins = declaresParam(entry, "pins");
  if (!carriesPins) {
    delete next.pins;
  } else if (pins.length === 0) {
    delete next.pins;
  } else {
    const key = blurPinKey(entry);
    const range = pinAmountRange(entry, key);
    next.pins = pins.map((pin) => ({
      x: clamp01(pin.x),
      y: clamp01(pin.y),
      [key]: clamp(pin.blur, range.min, range.max)
    }));
  }
  // 单点命令用中心表达几何：只有声明过的键才同步，避免给别的命令塞未知字段。
  const first = pins[0];
  if (first && "centerX" in next) next.centerX = clamp01(first.x);
  if (first && "centerY" in next) next.centerY = clamp01(first.y);
  return next;
}

// ---------------------------------------------------------------- 路径模糊路径

/** 路径模糊的一条路径：折线（0–1 相对坐标）+ 速度 + 锥度。 */
export type FilterBlurPath = { points: [number, number][]; speed: number; taper: number };

const blurPathOf = (value: unknown, fallbackSpeed: number, fallbackTaper: number): FilterBlurPath | null => {
  if (!isRecord(value)) return null;
  const raw = Array.isArray(value.points) ? value.points : [];
  const points: [number, number][] = [];
  for (const point of raw.slice(0, FILTER_LIMITS.maxResourcePoints)) {
    if (!Array.isArray(point) || point.length < 2 || !isFiniteNumber(point[0]) || !isFiniteNumber(point[1])) continue;
    points.push([clamp01(point[0]), clamp01(point[1])]);
  }
  if (points.length < 2) return null;
  return {
    points,
    speed: Math.max(0, Math.min(500, isFiniteNumber(value.speed) ? value.speed : fallbackSpeed)),
    taper: Math.max(0, Math.min(100, isFiniteNumber(value.taper) ? value.taper : fallbackTaper))
  };
};

/** 从规范参数读出路径列表；没有就用起止点造一条，与内核的兜底一致。 */
export function blurPaths(params: Record<string, unknown>, max: number = FILTER_LIMITS.maxPins): FilterBlurPath[] {
  const speed = isFiniteNumber(params.speed) ? params.speed : 50;
  const taper = isFiniteNumber(params.taper) ? params.taper : 0;
  const items = Array.isArray(params.paths) ? params.paths : [];
  const paths: FilterBlurPath[] = [];
  for (const item of items.slice(0, max)) {
    const path = blurPathOf(item, speed, taper);
    if (path) paths.push(path);
  }
  if (paths.length > 0) return paths;
  const at = (key: string, fallback: number) => clamp01(isFiniteNumber(params[key]) ? (params[key] as number) : fallback);
  return [{
    points: [[at("startX", 0.2), at("startY", 0.5)], [at("endX", 0.8), at("endY", 0.5)]],
    speed: Math.max(0, Math.min(500, speed)),
    taper: Math.max(0, Math.min(100, taper))
  }];
}

/** 路径写回参数：`paths` 是唯一几何来源，首条的起止点同步到标量字段便于单路径命令复用。 */
export function withBlurPaths(
  params: Record<string, unknown>,
  paths: readonly FilterBlurPath[],
  entry?: FilterEntry
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  if (!declaresParam(entry, "paths") || paths.length === 0) {
    delete next.paths;
    return next;
  }
  next.paths = paths.map((path) => ({
    points: path.points.map(([x, y]) => [clamp01(x), clamp01(y)]),
    speed: Math.max(0, Math.min(500, path.speed)),
    taper: Math.max(0, Math.min(100, path.taper))
  }));
  // 标量起止点走的是命令记法里的 0–1 范围校验，同步时用夹取后的值，否则整次草稿会被拒。
  const points = (next.paths as { points: [number, number][] }[])[0]!.points;
  const head = points[0]!;
  const tail = points[points.length - 1]!;
  if ("startX" in next) next.startX = head[0];
  if ("startY" in next) next.startY = head[1];
  if ("endX" in next) next.endX = tail[0];
  if ("endY" in next) next.endY = tail[1];
  return next;
}

// ---------------------------------------------------------------- 自定卷积核

/** 自定卷积的核尺寸：5×5，行主序，中心是第 12 项（与内核一致）。 */
export const FILTER_KERNEL_SIZE = 25;

/** 卷积核系数的取值范围（内核按 -999–999 夹取，域校验同界）。 */
const KERNEL_LIMIT = 999;

/** 恒等核：中心为 1，其余为 0。没有它「自定」滤镜就是一个空操作。 */
export function identityKernel(): number[] {
  return Array.from({ length: FILTER_KERNEL_SIZE }, (_, index) => (index === 12 ? 1 : 0));
}

/** 从规范参数读出卷积核；缺失或形态不对时退回恒等核。 */
export function filterKernel(params: Record<string, unknown>): number[] {
  const items = Array.isArray(params.kernel) ? params.kernel : [];
  if (items.length !== FILTER_KERNEL_SIZE) return identityKernel();
  return items.map((item) => (isFiniteNumber(item) ? clamp(item, -KERNEL_LIMIT, KERNEL_LIMIT) : 0));
}

/**
 * 卷积核写回参数。
 *
 * `自定卷积` 的有效结果完全由 `kernel` 决定：面板不带它时内核用恒等核，滤镜选中后什么都不变。
 * 所有系数都夹到内核实际接受的范围内，NaN/无穷按 0 处理，避免整次草稿被校验拒绝。
 */
export function withKernel(
  params: Record<string, unknown>,
  kernel: readonly number[],
  entry?: FilterEntry
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  if (!declaresParam(entry, "kernel")) {
    delete next.kernel;
    return next;
  }
  const fixed = Array.from({ length: FILTER_KERNEL_SIZE }, (_, index) => {
    const value = kernel[index];
    return isFiniteNumber(value) ? clamp(value, -KERNEL_LIMIT, KERNEL_LIMIT) : 0;
  });
  next.kernel = fixed;
  return next;
}

export function addPin(pins: readonly FilterPin[], pin: FilterPin, max: number = FILTER_LIMITS.maxPins): FilterPin[] {
  if (pins.length >= max) return [...pins];
  return [...pins, { ...pin }];
}

export function removePin(pins: readonly FilterPin[], index: number): FilterPin[] {
  if (index < 0 || index >= pins.length || pins.length <= 1) return [...pins];
  return pins.filter((_, at) => at !== index);
}

export function movePin(pins: readonly FilterPin[], index: number, patch: Partial<FilterPin>): FilterPin[] {
  if (index < 0 || index >= pins.length) return [...pins];
  return pins.map((pin, at) =>
    at === index
      ? {
          x: patch.x === undefined ? pin.x : clamp01(patch.x),
          y: patch.y === undefined ? pin.y : clamp01(patch.y),
          blur: patch.blur === undefined ? pin.blur : Math.max(0, Math.min(500, patch.blur))
        }
      : pin
  );
}

// ---------------------------------------------------------------- 消失点平面

const corners = (value: unknown): FilterPlane["corners"] | null => {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const result: [number, number][] = [];
  for (const corner of value) {
    if (!Array.isArray(corner) || corner.length < 2 || !isFiniteNumber(corner[0]) || !isFiniteNumber(corner[1])) return null;
    result.push([corner[0], corner[1]]);
  }
  return result as FilterPlane["corners"];
};

/** 从参数读出已绘制平面（只取带四个角点的平面，撕出面由内核推导）。 */
export function vanishingPlanes(params: Record<string, unknown>, max: number = FILTER_LIMITS.maxPlanes): FilterPlane[] {
  const items = Array.isArray(params.planes) ? params.planes : [];
  const planes: FilterPlane[] = [];
  for (const item of items.slice(0, max)) {
    if (!isRecord(item)) continue;
    const parsed = corners(item.corners);
    if (!parsed) continue;
    planes.push({ corners: parsed });
  }
  return planes;
}

/** 新平面：居中且占画布 60%（文档像素），用户再拖角点。 */
export function newPlane(size: FilterDocumentSize): FilterPlane {
  const x0 = clamp(size.width * 0.2, 0, Math.max(0, size.width));
  const x1 = clamp(size.width * 0.8, 0, Math.max(0, size.width));
  const y0 = clamp(size.height * 0.2, 0, Math.max(0, size.height));
  const y1 = clamp(size.height * 0.8, 0, Math.max(0, size.height));
  return { corners: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
}

export function addPlane(
  planes: readonly FilterPlane[],
  size: FilterDocumentSize,
  plane: FilterPlane = newPlane(size),
  max: number = FILTER_LIMITS.maxPlanes
): FilterPlane[] {
  if (planes.length >= max) return [...planes.map(copyPlane)];
  return [...planes.map(copyPlane), copyPlane(plane)];
}

function copyPlane(plane: FilterPlane): FilterPlane {
  return { corners: plane.corners.map(([x, y]) => [x, y]) as FilterPlane["corners"] };
}

export function removePlane(planes: readonly FilterPlane[], index: number): FilterPlane[] {
  if (index < 0 || index >= planes.length) return planes.map(copyPlane);
  return planes.filter((_, at) => at !== index).map(copyPlane);
}

export function setPlaneCorner(
  planes: readonly FilterPlane[],
  index: number,
  corner: number,
  point: [number, number],
  size: FilterDocumentSize
): FilterPlane[] {
  if (index < 0 || index >= planes.length || corner < 0 || corner > 3) return planes.map(copyPlane);
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return planes.map(copyPlane);
  const next: [number, number] = [
    clamp(point[0], 0, Math.max(0, size.width)),
    clamp(point[1], 0, Math.max(0, size.height))
  ];
  return planes.map((plane, at) => {
    const copy = copyPlane(plane);
    if (at === index) copy.corners[corner] = next;
    return copy;
  });
}

export function withPlanes(params: Record<string, unknown>, planes: readonly FilterPlane[]): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params, planes: planes.map(copyPlane) };
  return next;
}

// ---------------------------------------------------------------- 自适应广角约束

export function wideAngleConstraints(params: Record<string, unknown>, max: number = FILTER_LIMITS.maxResourcePoints): FilterConstraint[] {
  const items = Array.isArray(params.constraints) ? params.constraints : [];
  const constraints: FilterConstraint[] = [];
  for (const item of items.slice(0, max)) {
    if (!isRecord(item)) continue;
    const a = Array.isArray(item.a) && item.a.length >= 2 && isFiniteNumber(item.a[0]) && isFiniteNumber(item.a[1]) ? [item.a[0], item.a[1]] as [number, number] : null;
    const b = Array.isArray(item.b) && item.b.length >= 2 && isFiniteNumber(item.b[0]) && isFiniteNumber(item.b[1]) ? [item.b[0], item.b[1]] as [number, number] : null;
    if (!a || !b) continue;
    const orientation = item.orientation === "horizontal" || item.orientation === "vertical" ? item.orientation : "free";
    constraints.push({ a, b, orientation });
  }
  return constraints;
}

/** 新约束：贯穿画面中部的一条水平参考线（文档像素，与内核 `constraints` 同单位）。 */
export function newConstraint(size: FilterDocumentSize): FilterConstraint {
  const y = size.height / 2;
  return { a: [size.width * 0.1, y], b: [size.width * 0.9, y], orientation: "horizontal" };
}

export function addConstraint(
  constraints: readonly FilterConstraint[],
  size: FilterDocumentSize,
  constraint: FilterConstraint = newConstraint(size),
  max: number = FILTER_LIMITS.maxResourcePoints
): FilterConstraint[] {
  if (constraints.length >= max) return [...constraints];
  return [...constraints, { ...constraint, a: [...constraint.a], b: [...constraint.b] }];
}

export function removeConstraint(constraints: readonly FilterConstraint[], index: number): FilterConstraint[] {
  if (index < 0 || index >= constraints.length) return [...constraints];
  return constraints.filter((_, at) => at !== index);
}

export function withConstraints(params: Record<string, unknown>, constraints: readonly FilterConstraint[]): Record<string, unknown> {
  return { ...params, constraints: constraints.map((constraint) => ({ ...constraint, a: [...constraint.a], b: [...constraint.b] })) };
}

// ---------------------------------------------------------------- 镜头校正的拉直线

/**
 * 镜头校正的 `straighten`：两点校正线，**文档像素坐标**（与内核
 * `lens::straighten_angle` 同单位，它拿这两点算偏离最近的 90° 倍数）。
 */
export type FilterStraighten = { a: [number, number]; b: [number, number] };

/** 从规范参数读校正线；形态不对就当没设（内核此时不旋转）。 */
export function lensStraighten(params: Record<string, unknown>): FilterStraighten | null {
  const line = Array.isArray(params.straighten) ? params.straighten : [];
  const end = (value: unknown): [number, number] | null =>
    Array.isArray(value) && value.length >= 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1])
      ? [value[0], value[1]]
      : null;
  const a = end(line[0]);
  const b = end(line[1]);
  return a && b ? { a, b } : null;
}

/** 新校正线：贯穿画面中部的一条水平线（也正是「不旋转」的参考）。 */
export function newStraighten(size: FilterDocumentSize): FilterStraighten {
  const y = size.height / 2;
  return { a: [size.width * 0.25, y], b: [size.width * 0.75, y] };
}

/**
 * 校正线写回参数。
 *
 * `straighten` 只在命令声明了它时才写；端点夹在画布内并按整数像素取整——内核按
 * `[[x0,y0],[x1,y1]]` 解析，越界或非数值会让整次草稿被拒。传 `null` 表示清除校正线。
 */
export function withStraighten(
  params: Record<string, unknown>,
  line: FilterStraighten | null,
  size: FilterDocumentSize,
  entry?: FilterEntry
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  if (!declaresParam(entry, "straighten") || line === null) {
    delete next.straighten;
    return next;
  }
  const clampX = (value: number) => Math.min(size.width, Math.max(0, Math.round(value)));
  const clampY = (value: number) => Math.min(size.height, Math.max(0, Math.round(value)));
  next.straighten = [
    [clampX(line.a[0]), clampY(line.a[1])],
    [clampX(line.b[0]), clampY(line.b[1])]
  ];
  return next;
}

/** 归一化点（面板把画布坐标换算成 0–1）。与内核 `filterNormalizePoint` 同一算式。 */
export function normalizePoint(x: number, y: number, width: number, height: number): [number, number] | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(width > 0) || !(height > 0)) return null;
  return [clamp01(x / width), clamp01(y / height)];
}

// ---------------------------------------------------------------- Camera Raw：点曲线 / HSL / 色彩分级

/** 点曲线的上限点数（与内核 `camera_raw::MAX_CURVE_POINTS` 一致）。 */
export const FILTER_CURVE_MAX_POINTS = 16;
/** 曲线坐标是 8 位色阶：输入与输出都落在 0–255。 */
const CURVE_MAX = 255;
/** HSL 恰好 8 个色相区间（红/橙/黄/绿/青/蓝/紫/洋红）。 */
export const FILTER_HSL_BANDS = 8;

/** Camera Raw 的四条点曲线通道：复合 + 三原色。 */
export const FILTER_CURVE_CHANNELS = ["pointCurve", "pointCurveRed", "pointCurveGreen", "pointCurveBlue"] as const;
export type FilterCurveChannel = (typeof FILTER_CURVE_CHANNELS)[number];

/** 色彩分级转盘的四个区间。 */
export const FILTER_GRADE_WHEELS = ["gradeShadows", "gradeMidtones", "gradeHighlights", "gradeGlobal"] as const;
export type FilterGradeWheel = (typeof FILTER_GRADE_WHEELS)[number];

export type FilterCurvePoint = [number, number];
/** 分级转盘：色相 0–360、饱和 0–100、明度 −100–100（与内核 `Wheel` 同界）。 */
export type FilterWheel = { hue: number; sat: number; lum: number };
/** 8 段 HSL 偏移：色相 −100–100（±30°）、饱和/明度按百分比。 */
export type FilterHslBands = { hue: number[]; sat: number[]; lum: number[] };

// 读的时候**不夹取**：越界坐标意味着这条曲线内核会拒绝，夹成边界反而会把它伪装成合法曲线。
const curvePoint = (value: unknown): FilterCurvePoint | null =>
  Array.isArray(value) && value.length >= 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1])
    && value[0] >= 0 && value[0] <= CURVE_MAX && value[1] >= 0 && value[1] <= CURVE_MAX
    ? [value[0], value[1]]
    : null;

/**
 * 从参数读出一条点曲线。
 *
 * 非法输入（单点、输入不递增、超长）在这里统一收敛成 `[]`：内核把非空且不合规的曲线当错误拒绝，
 * 而 `[]` 是内核接受的「不调整」。面板据此画一条恒等直线，不会把坏数据当成用户的编辑。
 */
export function filterCurve(params: Record<string, unknown>, channel: FilterCurveChannel): FilterCurvePoint[] {
  const items = Array.isArray(params[channel]) ? params[channel] : [];
  const points: FilterCurvePoint[] = [];
  for (const item of items.slice(0, FILTER_CURVE_MAX_POINTS)) {
    const point = curvePoint(item);
    if (!point) return [];
    points.push(point);
  }
  if (!curveUsable(points)) return [];
  return points.map(([x, y]) => [x, y]);
}

/**
 * 曲线是否能被内核接受：空曲线合法（表示不调整），非空时至少两点、最多 16 点、
 * 输入严格递增且每段至少差 1 级。
 */
export function curveUsable(points: readonly FilterCurvePoint[]): boolean {
  if (points.length === 0) return true;
  if (points.length === 1 || points.length > FILTER_CURVE_MAX_POINTS) return false;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!point || !isFiniteNumber(point[0]) || !isFiniteNumber(point[1])) return false;
    if (point[0] < 0 || point[0] > CURVE_MAX || point[1] < 0 || point[1] > CURVE_MAX) return false;
    if (index > 0 && (point[0] as number) - (points[index - 1]![0] as number) < 1) return false;
  }
  return true;
}

/**
 * 在曲线上插入一个点并保持输入递增。
 *
 * 插点顺序或重复输入会让整条曲线被内核拒绝（预览与确认都失败），所以这里把坐标夹到 0–255、
 * 取整，并去掉与既有输入冲突的点；点数达到上限时原样返回。
 */
export function addCurvePoint(
  points: readonly FilterCurvePoint[],
  point: FilterCurvePoint = [128, 128]
): FilterCurvePoint[] {
  const base = points.length > 0 ? points.map(([x, y]) => [x, y] as FilterCurvePoint) : [[0, 0] as FilterCurvePoint, [255, 255] as FilterCurvePoint];
  if (base.length >= FILTER_CURVE_MAX_POINTS) return base;
  const next: FilterCurvePoint = [
    Math.round(clamp(point[0], 0, CURVE_MAX)),
    Math.round(clamp(point[1], 0, CURVE_MAX))
  ];
  if (base.some(([x]) => x === next[0])) return base;
  const merged = [...base, next].sort((a, b) => a[0] - b[0]);
  // 排序后相邻输入必须至少差 1 级，否则内核按「输入不递增」拒绝。
  for (let index = 1; index < merged.length; index += 1) {
    if (merged[index]![0] - merged[index - 1]![0] < 1) return base;
  }
  return merged;
}

/** 移除曲线上的一个点；只剩两点时保留（更少的非空曲线会被内核拒绝）。 */
export function removeCurvePoint(points: readonly FilterCurvePoint[], index: number): FilterCurvePoint[] {
  if (index <= 0 || index >= points.length - 1) return points.map(([x, y]) => [x, y] as FilterCurvePoint);
  return points.filter((_, at) => at !== index).map(([x, y]) => [x, y] as FilterCurvePoint);
}

/** 移动曲线上的一个点：端点只能垂直移动（保证首尾输入覆盖 0 与 255 的可用性）。 */
export function moveCurvePoint(
  points: readonly FilterCurvePoint[],
  index: number,
  next: FilterCurvePoint
): FilterCurvePoint[] {
  if (index < 0 || index >= points.length) return points.map(([x, y]) => [x, y] as FilterCurvePoint);
  const low = index === 0 ? 0 : (points[index - 1]![0] as number) + 1;
  const high = index === points.length - 1 ? CURVE_MAX : (points[index + 1]![0] as number) - 1;
  const x = Math.round(clamp(next[0], low, Math.max(low, high)));
  const y = Math.round(clamp(next[1], 0, CURVE_MAX));
  return points.map(([px, py], at) => (at === index ? [x, y] : [px, py]) as FilterCurvePoint);
}

/** 曲线写回参数：通道没有被声明时不写（避免给别的命令塞未知字段）。 */
export function withCurve(
  params: Record<string, unknown>,
  channel: FilterCurveChannel,
  points: readonly FilterCurvePoint[],
  entry?: FilterEntry
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  if (!declaresParam(entry, channel)) {
    delete next[channel];
    return next;
  }
  next[channel] = curveUsable(points)
    ? points.map(([x, y]) => [x, y])
    : [];
  return next;
}

/** 恒等曲线：没有自定义点时面板画的那条对角线。 */
export function identityCurve(): FilterCurvePoint[] {
  return [[0, 0], [255, 255]];
}

/** 读出 `curveSplits`：三档阴影/中间调/高光的分离点，内核要求恰好 3 个、夹在 5–95。 */
export function curveSplits(params: Record<string, unknown>): [number, number, number] {
  const items = Array.isArray(params.curveSplits) ? params.curveSplits : [];
  if (items.length !== 3 || items.some((item) => !isFiniteNumber(item))) return [25, 50, 75];
  return [clamp(items[0] as number, 5, 95), clamp(items[1] as number, 5, 95), clamp(items[2] as number, 5, 95)];
}

/** 写回 `curveSplits`：三个分离点各自夹取并取整，保持递增顺序由面板保证。 */
export function withCurveSplits(
  params: Record<string, unknown>,
  splits: readonly number[],
  entry?: FilterEntry
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  if (!declaresParam(entry, "curveSplits") || splits.length !== 3) {
    delete next.curveSplits;
    return next;
  }
  next.curveSplits = splits.map((value) => Math.round(clamp(value, 5, 95)));
  return next;
}

const hslBand = (value: unknown): number[] | null => {
  if (!Array.isArray(value) || value.length !== FILTER_HSL_BANDS) return null;
  if (value.some((item) => !isFiniteNumber(item))) return null;
  return value.map((item) => clamp(item as number, -100, 100));
};

/** 读出 HSL 三组 8 段偏移；形态不对时退回全 0（= 不调整）。 */
export function filterHsl(params: Record<string, unknown>): FilterHslBands {
  return {
    hue: hslBand(params.hslHue) ?? Array.from({ length: FILTER_HSL_BANDS }, () => 0),
    sat: hslBand(params.hslSat) ?? Array.from({ length: FILTER_HSL_BANDS }, () => 0),
    lum: hslBand(params.hslLum) ?? Array.from({ length: FILTER_HSL_BANDS }, () => 0)
  };
}

/**
 * 写回一条 HSL 通道的 8 段偏移。
 *
 * 内核按定长数组反序列化：少一项或多一项都会整次拒绝，所以这里始终补齐/截断到 8，
 * 并把每段夹在 −100–100。
 */
export function withHslBand(
  params: Record<string, unknown>,
  channel: "hslHue" | "hslSat" | "hslLum",
  values: readonly number[],
  entry?: FilterEntry
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  if (!declaresParam(entry, channel)) {
    delete next[channel];
    return next;
  }
  next[channel] = Array.from({ length: FILTER_HSL_BANDS }, (_, index) => {
    const value = values[index];
    return isFiniteNumber(value) ? Math.round(clamp(value, -100, 100)) : 0;
  });
  return next;
}

/** HSL 色带名称：与内核权重次序一致（红→洋红）。 */
export const FILTER_HSL_BAND_NAMES = ["红", "橙", "黄", "绿", "青", "蓝", "紫", "洋红"] as const;

const wheelOf = (value: unknown): FilterWheel => {
  if (!isRecord(value)) return { hue: 0, sat: 0, lum: 0 };
  const hue = isFiniteNumber(value.hue) ? value.hue : 0;
  const sat = isFiniteNumber(value.sat) ? value.sat : 0;
  const lum = isFiniteNumber(value.lum) ? value.lum : 0;
  // 色相按 360 取模：内核把它当度数用，越界值等于转圈，不是错误。
  const wrapped = ((hue % 360) + 360) % 360;
  return { hue: wrapped, sat: clamp(sat, 0, 100), lum: clamp(lum, -100, 100) };
};

/** 读出一个分级转盘；缺失时是全零（= 不调整）。 */
export function filterWheel(params: Record<string, unknown>, wheel: FilterGradeWheel): FilterWheel {
  return wheelOf(params[wheel]);
}

/** 写回一个分级转盘；未声明该字段的命令不写。 */
export function withWheel(
  params: Record<string, unknown>,
  wheel: FilterGradeWheel,
  value: FilterWheel,
  entry?: FilterEntry
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  if (!declaresParam(entry, wheel)) {
    delete next[wheel];
    return next;
  }
  const normalized = wheelOf(value);
  next[wheel] = { hue: Number(normalized.hue.toFixed(1)), sat: Number(normalized.sat.toFixed(1)), lum: Number(normalized.lum.toFixed(1)) };
  return next;
}

// ---------------------------------------------------------------- 光照效果：光源组

/** 光源类型与内核 `LightKind` 一致。 */
export const FILTER_LIGHT_KINDS = ["spot", "point", "infinite"] as const;

/** 一盏光源：位置/目标是相对边界的分量，`z` 为高出表面的比例，`color` 是 0–255 RGB。 */
export type FilterLight = {
  kind: (typeof FILTER_LIGHT_KINDS)[number];
  x: number;
  y: number;
  z: number;
  targetX: number;
  targetY: number;
  angle: number;
  elevation: number;
  color: [number, number, number];
  intensity: number;
  cone: number;
  hotspot: number;
  radius: number;
};

/** 默认光源：与内核 `Light::default()` 同值，用户加灯后立刻可见。 */
export function newLight(): FilterLight {
  return {
    kind: "spot",
    x: 0.25,
    y: 0.2,
    z: 0.6,
    targetX: 0.5,
    targetY: 0.55,
    angle: 135,
    elevation: 45,
    color: [255, 255, 255],
    intensity: 75,
    cone: 45,
    hotspot: 50,
    radius: 0.8
  };
}

const unit = (value: unknown, fallback: number): number => (isFiniteNumber(value) ? clamp01(value) : fallback);
const lightColour = (value: unknown): [number, number, number] => {
  if (!Array.isArray(value) || value.length < 3) return [255, 255, 255];
  const channel = (item: unknown): number => (isFiniteNumber(item) ? Math.round(clamp(item, 0, 255)) : 255);
  return [channel(value[0]), channel(value[1]), channel(value[2])];
};

/**
 * 读出光源组。
 *
 * 内核优先读 `lights`，缺省时退到顶层的单灯字段；面板只在命令真的声明了 `lights` 时使用它。
 * 每个字段都夹到内核接受的范围，避免一盏越界的灯让整次草稿被拒。
 */
export function filterLights(params: Record<string, unknown>, max: number = FILTER_LIMITS.maxPins): FilterLight[] {
  const items = Array.isArray(params.lights) ? params.lights : [];
  const lights: FilterLight[] = [];
  for (const item of items.slice(0, max)) {
    if (!isRecord(item)) continue;
    lights.push(lightOf(item));
  }
  return lights;
}

const lightOf = (item: Record<string, unknown>): FilterLight => {
  const fallback = newLight();
  const kind = typeof item.kind === "string" && (FILTER_LIGHT_KINDS as readonly string[]).includes(item.kind)
    ? (item.kind as FilterLight["kind"])
    : fallback.kind;
  const num = (key: keyof FilterLight, min: number, max: number, base: number): number =>
    isFiniteNumber(item[key]) ? clamp(item[key] as number, min, max) : base;
  return {
    kind,
    x: unit(item.x, fallback.x),
    y: unit(item.y, fallback.y),
    z: num("z", 0, 10, fallback.z),
    targetX: unit(item.targetX, fallback.targetX),
    targetY: unit(item.targetY, fallback.targetY),
    angle: num("angle", -180, 180, fallback.angle),
    elevation: num("elevation", 0, 90, fallback.elevation),
    color: lightColour(item.color),
    intensity: num("intensity", -100, 100, fallback.intensity),
    cone: num("cone", 1, 89, fallback.cone),
    hotspot: num("hotspot", 0, 100, fallback.hotspot),
    radius: num("radius", 0, 5, fallback.radius)
  };
};

export function addLight(
  lights: readonly FilterLight[],
  light: FilterLight = newLight(),
  max: number = FILTER_LIMITS.maxPins
): FilterLight[] {
  if (lights.length >= max) return [...lights];
  return [...lights, { ...light, color: [...light.color] as [number, number, number] }];
}

/** 移除一盏灯；至少留一盏，否则内核退回顶层单灯字段、画面完全变样。 */
export function removeLight(lights: readonly FilterLight[], index: number): FilterLight[] {
  if (index < 0 || index >= lights.length || lights.length <= 1) return [...lights];
  return lights.filter((_, at) => at !== index);
}

export function moveLight(
  lights: readonly FilterLight[],
  index: number,
  patch: Partial<FilterLight>
): FilterLight[] {
  if (index < 0 || index >= lights.length) return [...lights];
  return lights.map((light, at) => (at === index ? lightOf({ ...light, ...patch } as Record<string, unknown>) : light));
}

/**
 * 光源组写回参数。
 *
 * 只有声明了 `lights` 的命令才写；空数组会让内核退回顶层单灯字段，所以至少保留一盏。
 * 颜色是 0–255 的 RGB 数组（与内核 `Light::color` 的线性 RGB 分量同量纲）。
 */
export function withLights(
  params: Record<string, unknown>,
  lights: readonly FilterLight[],
  entry?: FilterEntry
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  if (!declaresParam(entry, "lights") || lights.length === 0) {
    delete next.lights;
    return next;
  }
  next.lights = lights.map((light) => {
    const normalized = lightOf(light as unknown as Record<string, unknown>);
    return {
      kind: normalized.kind,
      x: round3(normalized.x),
      y: round3(normalized.y),
      z: round3(normalized.z),
      targetX: round3(normalized.targetX),
      targetY: round3(normalized.targetY),
      angle: round3(normalized.angle),
      elevation: round3(normalized.elevation),
      color: normalized.color,
      intensity: round3(normalized.intensity),
      cone: round3(normalized.cone),
      hotspot: round3(normalized.hotspot),
      radius: round3(normalized.radius)
    };
  });
  return next;
}

const round3 = (value: number): number => Number(value.toFixed(3));

// ---------------------------------------------------------------- 消失点：透视克隆与粘贴

/** 一条透视克隆笔画：来源点 + 落笔路径（都是文档像素）+ 笔尖参数。 */
export type FilterCloneStroke = {
  source: [number, number];
  points: [number, number][];
  size: number;
  hardness: number;
  opacity: number;
};

/** 一次粘贴：把某个图层（或剪贴板）按平面透视贴到 `at`（0–1 相对坐标）。 */
export type FilterPaste = { plane: number; at: [number, number]; width: number; layer: number | null };

const clonePoint = (value: unknown): [number, number] | null =>
  Array.isArray(value) && value.length >= 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1])
    ? [value[0], value[1]]
    : null;

/**
 * 读出透视克隆笔画。
 *
 * 内核按文档像素取点，缺 `source` 的项直接跳过（否则整条命令按「clone N: `source`」拒绝，
 * 用户会看到一句与自己的操作无关的错）。
 */
export function vanishingClones(params: Record<string, unknown>, max: number = FILTER_LIMITS.maxPins): FilterCloneStroke[] {
  const items = Array.isArray(params.clone) ? params.clone : [];
  const strokes: FilterCloneStroke[] = [];
  for (const item of items.slice(0, max)) {
    if (!isRecord(item)) continue;
    const source = clonePoint(item.source);
    if (!source) continue;
    const points: [number, number][] = [];
    for (const point of Array.isArray(item.points) ? item.points : []) {
      const parsed = clonePoint(point);
      if (parsed) points.push(parsed);
    }
    if (points.length === 0) continue;
    strokes.push({
      source,
      points,
      size: isFiniteNumber(item.size) ? clamp(item.size, 1, 2000) : 40,
      hardness: isFiniteNumber(item.hardness) ? clamp(item.hardness, 0, 100) : 50,
      opacity: isFiniteNumber(item.opacity) ? clamp(item.opacity, 0, 100) : 100
    });
  }
  return strokes;
}

/** 新克隆笔画：来源在左上、落笔在右下一笔，用户再调。 */
export function newClone(size: FilterDocumentSize): FilterCloneStroke {
  const x = clamp(size.width * 0.25, 0, Math.max(0, size.width));
  const y = clamp(size.height * 0.35, 0, Math.max(0, size.height));
  return {
    source: [x / 2, y / 2],
    points: [[x, y], [clamp(x * 1.6, 0, size.width), y]],
    size: 40,
    hardness: 50,
    opacity: 100
  };
}

export function addClone(
  clones: readonly FilterCloneStroke[],
  size: FilterDocumentSize,
  clone: FilterCloneStroke = newClone(size),
  max: number = FILTER_LIMITS.maxPins
): FilterCloneStroke[] {
  if (clones.length >= max) return [...clones];
  return [...clones, copyClone(clone)];
}

export function removeClone(clones: readonly FilterCloneStroke[], index: number): FilterCloneStroke[] {
  if (index < 0 || index >= clones.length) return [...clones];
  return clones.filter((_, at) => at !== index).map(copyClone);
}

/** 移动克隆的来源点或第 `point` 个落笔点；坐标夹进画布，避免越界笔画被内核忽略。 */
export function setCloneGeometry(
  clones: readonly FilterCloneStroke[],
  index: number,
  which: "source" | number,
  value: [number, number],
  size: FilterDocumentSize
): FilterCloneStroke[] {
  if (index < 0 || index >= clones.length) return [...clones].map(copyClone);
  const next = [...clones].map(copyClone);
  const target = next[index]!;
  const point: [number, number] = [
    clamp(value[0], 0, Math.max(0, size.width)),
    clamp(value[1], 0, Math.max(0, size.height))
  ];
  if (which === "source") target.source = point;
  else if (which >= 0 && which < target.points.length) target.points[which] = point;
  return next;
}

/** 改笔尖参数（尺寸/硬度/不透明度），按内核范围夹取。 */
export function setCloneBrush(
  clones: readonly FilterCloneStroke[],
  index: number,
  patch: Partial<Pick<FilterCloneStroke, "size" | "hardness" | "opacity">>
): FilterCloneStroke[] {
  if (index < 0 || index >= clones.length) return [...clones].map(copyClone);
  return clones.map((clone, at) => {
    if (at !== index) return copyClone(clone);
    return {
      ...copyClone(clone),
      size: patch.size === undefined ? clone.size : clamp(patch.size, 1, 2000),
      hardness: patch.hardness === undefined ? clone.hardness : clamp(patch.hardness, 0, 100),
      opacity: patch.opacity === undefined ? clone.opacity : clamp(patch.opacity, 0, 100)
    };
  });
}

/**
 * 克隆笔画写回参数。
 *
 * 只有声明了 `clone` 的命令才写；空列表表示不做克隆。每个坐标取整成文档像素：内核把
 * 整数与浮点同等对待，取整只是让历史/重复上次的载荷稳定可读。
 */
export function withClones(
  params: Record<string, unknown>,
  clones: readonly FilterCloneStroke[],
  entry?: FilterEntry
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  if (!declaresParam(entry, "clone") || clones.length === 0) {
    delete next.clone;
    return next;
  }
  next.clone = clones.map((clone) => ({
    source: clone.source.map((value) => Math.round(value)),
    points: clone.points.map(([x, y]) => [Math.round(x), Math.round(y)]),
    size: Number(clone.size.toFixed(1)),
    hardness: Number(clone.hardness.toFixed(0)),
    opacity: Number(clone.opacity.toFixed(0))
  }));
  return next;
}

/** 当前文档里可作为粘贴来源的像素图层（id 是内核的 `LayerId`）。 */
export type FilterLayerSource = { id: number; name: string; active: boolean; width: number; height: number };

/**
 * 解码粘贴图层来源。
 *
 * 内核的 `paste[].layer` 只认图层 id；拿不到来源时面板只能引导用户先复制，所以解码失败
 * 时返回 `null`（面板显示「不支持」），而不是返回空数组冒充「没有可用图层」。
 */
export function decodeFilterLayerSources(value: unknown): FilterLayerSource[] | null {
  if (!isRecord(value) || !Array.isArray(value.layers)) return null;
  const sources: FilterLayerSource[] = [];
  for (const item of value.layers) {
    if (!isRecord(item)) continue;
    if (!isNonNegativeInteger(item.id)) continue;
    if (typeof item.name !== "string" || item.name.length > 256) continue;
    sources.push({
      id: item.id,
      name: item.name,
      active: item.active === true,
      width: isNonNegativeInteger(item.width) ? item.width : 0,
      height: isNonNegativeInteger(item.height) ? item.height : 0
    });
  }
  return sources;
}

/** 读出粘贴列表；平面号越界或坐标非数值的项直接丢弃（否则整条命令被拒）。 */
export function vanishingPastes(
  params: Record<string, unknown>,
  planes: number,
  max: number = FILTER_LIMITS.maxPins
): FilterPaste[] {
  const items = Array.isArray(params.paste) ? params.paste : [];
  const pastes: FilterPaste[] = [];
  for (const item of items.slice(0, max)) {
    if (!isRecord(item)) continue;
    const plane = item.plane;
    if (!isNonNegativeInteger(plane) || plane >= Math.max(0, planes)) continue;
    const at = clonePoint(item.at);
    if (!at) continue;
    pastes.push({
      plane,
      layer: isNonNegativeInteger(item.layer) ? item.layer : null,
      at: [clamp01(at[0]), clamp01(at[1])],
      // 内核把 `width` 当相对平面宽度的比例，夹在 0.01–10。
      width: isFiniteNumber(item.width) ? clamp(item.width, 0.01, 10) : 0.5
    });
  }
  return pastes;
}

/** 新粘贴：贴在第一个平面中央、宽度半个平面、来源用已选图层。 */
export function newPaste(plane: number = 0, layer: number | null = null): FilterPaste {
  return { plane: Math.max(0, plane), layer, at: [0.5, 0.5], width: 0.5 };
}

export function addPaste(
  pastes: readonly FilterPaste[],
  paste: FilterPaste = newPaste(),
  max: number = FILTER_LIMITS.maxPins
): FilterPaste[] {
  if (pastes.length >= max) return pastes.map(copyPaste);
  return [...pastes.map(copyPaste), copyPaste(paste)];
}

export function removePaste(pastes: readonly FilterPaste[], index: number): FilterPaste[] {
  if (index < 0 || index >= pastes.length) return pastes.map(copyPaste);
  return pastes.filter((_, at) => at !== index).map(copyPaste);
}

/** 改一次粘贴的平面号/来源图层/位置/宽度；平面号与 `at` 都夹在合法范围。 */
export function setPaste(
  pastes: readonly FilterPaste[],
  index: number,
  patch: Partial<FilterPaste>,
  planes: number
): FilterPaste[] {
  if (index < 0 || index >= pastes.length) return pastes.map(copyPaste);
  return pastes.map((paste, at) => {
    if (at !== index) return copyPaste(paste);
    const next = copyPaste(paste);
    if (patch.plane !== undefined) next.plane = Math.min(Math.max(0, Math.round(patch.plane)), Math.max(0, planes - 1));
    if (patch.layer !== undefined) next.layer = patch.layer === null ? null : Math.max(0, Math.round(patch.layer));
    if (patch.at !== undefined) next.at = [clamp01(patch.at[0]), clamp01(patch.at[1])];
    if (patch.width !== undefined) next.width = clamp(patch.width, 0.01, 10);
    return next;
  });
}

/**
 * 粘贴写回参数。
 *
 * 只有声明了 `paste` 的命令才写；`layer: null` 序列化成「不含 layer 字段」，因为内核把
 * 缺失当成剪贴板来源，把 `null` 当成非法类型。
 */
export function withPastes(
  params: Record<string, unknown>,
  pastes: readonly FilterPaste[],
  entry?: FilterEntry
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  if (!declaresParam(entry, "paste") || pastes.length === 0) {
    delete next.paste;
    return next;
  }
  next.paste = pastes.map((paste) => {
    const item: Record<string, unknown> = {
      plane: Math.max(0, Math.round(paste.plane)),
      at: [Number(paste.at[0].toFixed(4)), Number(paste.at[1].toFixed(4))],
      width: Number(paste.width.toFixed(4))
    };
    if (paste.layer !== null) item.layer = Math.max(0, Math.round(paste.layer));
    return item;
  });
  return next;
}

/** 火焰可跟随的路径来源：已保存路径名 + 是否存在工作路径。 */
export type FilterPathSources = { paths: string[]; hasWorkPath: boolean };

/**
 * 解码路径来源。
 *
 * 内核 `path` 是**已保存路径的名字**（`"work"` 或空表示工作路径），不是坐标数组；形状不对
 * 时返回 `null`（面板说明「当前运行时不提供路径来源」），而不是空列表冒充「文档没有路径」。
 */
export function decodeFilterPathSources(value: unknown): FilterPathSources | null {
  if (!isRecord(value) || !Array.isArray(value.paths)) return null;
  const paths: string[] = [];
  for (const item of value.paths) {
    if (!isRecord(item)) continue;
    if (typeof item.name !== "string" || item.name === "" || item.name.length > 256) continue;
    paths.push(item.name);
  }
  return { paths, hasWorkPath: value.hasWorkPath === true };
}

/**
 * 写回火焰路径。
 *
 * `null` 表示「跟随工作路径或第一条保存路径」（内核缺省行为），此时删掉字段而不是写空串；
 * 名字必须是本条命令声明过 `path` 才写。
 */
export function withFlamePath(
  params: Record<string, unknown>,
  name: string | null,
  entry?: FilterEntry
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  if (!declaresParam(entry, "path") || name === null || name === "") {
    delete next.path;
    return next;
  }
  next.path = name;
  return next;
}

/** 当前参数跟随的路径名；缺省（空/`work`）返回 `null`，表示按内核缺省取路径。 */
export function flamePath(params: Record<string, unknown>): string | null {
  const value = params.path;
  if (typeof value !== "string" || value === "" || value.toLowerCase() === "work") return null;
  return value;
}

const copyPaste = (paste: FilterPaste): FilterPaste => ({
  plane: paste.plane,
  layer: paste.layer,
  at: [paste.at[0], paste.at[1]],
  width: paste.width
});

const copyClone = (clone: FilterCloneStroke): FilterCloneStroke => ({
  source: [...clone.source] as [number, number],
  points: clone.points.map(([x, y]) => [x, y] as [number, number]),
  size: clone.size,
  hardness: clone.hardness,
  opacity: clone.opacity
});

// ---------------------------------------------------------------- 切变曲线（`filter.distort.shear` 的 `points`）

/** 切变曲线点数上限：与内核 `validate` 的 1–64 一致。 */
export const FILTER_SHEAR_MAX_POINTS = 64;

/**
 * 切变曲线的一点：`[t, offset]`。
 *
 * `t` 是**从上到下**的归一化行位置（0–1），`offset` 是该行的水平位移，单位是**半个画布宽度**
 * （内核 `shear` 里 `offset * bw / 2.0`）。这与 `amount` 不是同一单位：`amount` 是百分数，
 * 内核在两者都没给自定义曲线时按 `amount/100` 生成一条三点曲线。面板把当前曲线画出来，用户
 * 调点即视为接管形状，`amount` 随之不再生效。
 */
export type FilterShearPoint = [number, number];

/** 内核 `amount` 与曲线 `offset` 的换算：`amount` 百分比 → 半宽倍率。 */
const shearOffsetOfAmount = (amount: number): number => clamp(amount, -100, 100) / 100;

export function shearPoints(params: Record<string, unknown>, max: number = FILTER_SHEAR_MAX_POINTS): FilterShearPoint[] {
  const items = Array.isArray(params.points) ? params.points : [];
  const points: FilterShearPoint[] = [];
  for (const item of items.slice(0, max)) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    const [t, offset] = item;
    if (!isFiniteNumber(t) || !isFiniteNumber(offset)) continue;
    points.push([t, offset]);
  }
  // 内核要求 x 单调不减且至少一点；不满足时按「没有自定义曲线」处理，回退到 amount。
  if (!shearUsable(points)) return [];
  return points;
}

/**
 * 曲线是否会被内核接受：1–64 点、`t` 单调不减、`offset` 有限。
 *
 * 内核在渲染时把 `t` 夹到 0–1、`offset` 夹到 ±1，但**先**校验单调性；乱序会被直接拒绝，
 * 所以写回前必须排好序而不是交给内核夹取。
 */
export function shearUsable(points: readonly FilterShearPoint[]): boolean {
  if (points.length === 0) return true;
  if (points.length > FILTER_SHEAR_MAX_POINTS) return false;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!point || !isFiniteNumber(point[0]) || !isFiniteNumber(point[1])) return false;
    if (index > 0 && point[0] < points[index - 1]![0]) return false;
  }
  return true;
}

/** 按 `amount` 生成内核缺省的三点曲线，供面板在未自定义时显示真实形状。 */
export function defaultShearPoints(amount: number): FilterShearPoint[] {
  return [[0, 0], [0.5, shearOffsetOfAmount(amount)], [1, 0]];
}

/**
 * 加入一点并保持 `t` 单调不减。
 *
 * 点已满或新点与既有 `t` 重合时原样返回（重复 `t` 由内核 `dedup_by` 丢掉，但留在面板里会让
 * 用户以为自己加了点却没效果）。
 */
export function addShearPoint(
  points: readonly FilterShearPoint[],
  point: FilterShearPoint = [0.5, 0],
  max: number = FILTER_SHEAR_MAX_POINTS
): FilterShearPoint[] {
  const base = points.length > 0 ? points.map(([t, o]) => [clamp(t, 0, 1), o] as FilterShearPoint) : [[0, 0] as FilterShearPoint, [1, 0] as FilterShearPoint];
  if (base.length >= max) return base;
  const next: FilterShearPoint = [
    Number(clamp(point[0], 0, 1).toFixed(3)),
    Number(clamp(point[1], -1, 1).toFixed(3))
  ];
  if (base.some(([t]) => Math.abs(t - next[0]) < 1e-6)) return base;
  return [...base, next].sort((a, b) => a[0] - b[0]);
}

/** 移除一点；只剩一点时保留（内核要求至少一点）。 */
export function removeShearPoint(points: readonly FilterShearPoint[], index: number): FilterShearPoint[] {
  if (points.length <= 1 || index < 0 || index >= points.length) return points.map(([t, o]) => [t, o] as FilterShearPoint);
  return points.filter((_, at) => at !== index).map(([t, o]) => [t, o] as FilterShearPoint);
}

/** 移动一点：`t` 夹在相邻两点之间，`offset` 夹在 ±1（与内核渲染时的夹取一致）。 */
export function moveShearPoint(
  points: readonly FilterShearPoint[],
  index: number,
  next: FilterShearPoint
): FilterShearPoint[] {
  if (index < 0 || index >= points.length) return points.map(([t, o]) => [t, o] as FilterShearPoint);
  const low = index === 0 ? 0 : points[index - 1]![0];
  const high = index === points.length - 1 ? 1 : points[index + 1]![0];
  const t = Number(clamp(next[0], low, Math.max(low, high)).toFixed(3));
  const offset = Number(clamp(next[1], -1, 1).toFixed(3));
  return points.map(([pt, po], at) => (at === index ? [t, offset] : [pt, po]) as FilterShearPoint);
}

/**
 * 写回切变曲线。
 *
 * 自定义曲线只在命令确实声明了 `points` 时写；清空（`[]`）表示交还给 `amount`，此时删掉字段。
 * 顺带把 `amount` 归零并不必要——内核优先用 `points`——但保留用户设过的 `amount` 会让「清空
 * 曲线」后突然跳回一个旧形状，所以清空时一并把它归零更符合直觉。
 */
export function withShearPoints(
  params: Record<string, unknown>,
  points: readonly FilterShearPoint[],
  entry?: FilterEntry
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  if (!declaresParam(entry, "points")) {
    delete next.points;
    return next;
  }
  if (points.length === 0 || !shearUsable(points)) {
    // 不可用的曲线也不能写成 `[]`：内核会按「需要 1–64 个点」整条拒绝，用户拿到的只是报错。
    delete next.points;
    if (declaresParam(entry, "amount")) next.amount = 0;
    return next;
  }
  next.points = points.map(([t, o]) => [t, o]);
  return next;
}
