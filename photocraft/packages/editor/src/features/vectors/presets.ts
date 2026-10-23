/**
 * 自定形状与形状预设（U16，change: 2026-10-22-add-photocraft-vector-canvas-tools，design D3/D4）。
 *
 * 三条边界（与 Rust `features/vectors/presets.rs` 同文）：
 *
 * 1. **库是工具状态，不是文档内容**：选择、保存、重命名、分组、删除预设都不进文档修订或
 *    撤销栈；已应用的形状是独立几何快照，删除库项不影响画面。
 * 2. **原子发布**：恢复快照先在候选列表上完成全部校验，成功后整批替换；失败保留原库。
 * 3. **有界**：预设数、名称长度、节点数与快照字节都按本域常量裁定。
 *
 * 本模块只做纯数据解码与参数编译；库的真实读写归内核（`shape.presets.*`、
 * `edit.defineCustomShape`），前端不保存第二份库。
 */

import { decodeVectorShapePresetLibrary, vectorPathWithinBudget, vectorPresetSnapshotWithinBudget, VECTOR_LIMITS } from "@woohaa3/photocraft-protocol";
import type { PenPath } from "./pen-tools.js";

/** 自定形状上限（与内核 `MAX_CUSTOM_SHAPES` 和协议 `VECTOR_LIMITS` 同值）。 */
export const MAX_CUSTOM_SHAPES = VECTOR_LIMITS.maxCustomShapes;
/** 名称最大字符数。 */
export const MAX_PRESET_NAME = VECTOR_LIMITS.maxPresetName;
/** 一个预设的节点总数上限。 */
export const MAX_PRESET_KNOTS = 4096;
/** 一个预设的子路径数上限（与内核 `MAX_PRESET_SUBPATHS` 一致）。 */
export const MAX_PRESET_SUBPATHS = 256;
/** 快照 JSON 字节上限。 */
export const MAX_SNAPSHOT_BYTES = VECTOR_LIMITS.maxSnapshotBytes;

/** 一条预设/自定形状（快照里的有界形态）。 */
export type ShapePresetEntry = {
  name: string;
  /** 几何身份摘要（16 进制），用于核对已应用形状仍是同一份快照。 */
  digest?: string;
  subpaths?: number;
};

export type ShapePresetGroup = { name: string; shapes: readonly ShapePresetEntry[] };

/** 内核 `vectorPresetsJson()` 的形状。 */
export type ShapePresetLibrary = {
  groups: readonly ShapePresetGroup[];
  custom: readonly ShapePresetEntry[];
  revision?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 与内核同口径的可保存坐标范围（画布单边 × 8）。 */
const COORD_LIMIT = VECTOR_LIMITS.coordLimit;

function finitePoint(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= COORD_LIMIT;
}

/**
 * 解码库快照。结构不符或超限返回 `null`，调用方保留上一份有效库，不把半个库贴到界面上。
 *
 * wire 结构由协议包的唯一解码器（`decodeVectorShapePresetLibrary`）裁定；这里只把
 * `revision` 这个**工具状态计数**（不进文档内容身份）补回本地投影，不另写第二套结构校验。
 */
export function decodeLibrary(value: unknown): ShapePresetLibrary | null {
  const decoded = decodeVectorShapePresetLibrary(value);
  if (!decoded) return null;
  let revision: number | undefined;
  if (isRecord(value) && value.revision !== undefined) {
    if (typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 0) return null;
    revision = value.revision;
  }
  const project = (entry: { name: string; digest?: string; subpaths?: number }): ShapePresetEntry => ({
    name: entry.name,
    ...(entry.digest === undefined ? {} : { digest: entry.digest }),
    ...(entry.subpaths === undefined ? {} : { subpaths: entry.subpaths }),
  });
  return {
    groups: decoded.groups.map(group => ({ name: group.name, shapes: group.shapes.map(project) })),
    custom: decoded.custom.map(project),
    ...(revision === undefined ? {} : { revision }),
  };
}

/** 库里的全部项（内置组 + 自定形状），用于选择器。 */
export function libraryEntries(library: ShapePresetLibrary): { group: string; entry: ShapePresetEntry; custom: boolean }[] {
  const entries: { group: string; entry: ShapePresetEntry; custom: boolean }[] = [];
  for (const group of library.groups) {
    for (const entry of group.shapes) entries.push({ group: group.name, entry, custom: false });
  }
  for (const entry of library.custom) entries.push({ group: "自定形状", entry, custom: true });
  return entries;
}

/** 应用预设（Custom Shape 工具拖绘落点）。 */
export function placePresetParams(
  name: string,
  rect: readonly [number, number, number, number],
  options: { group?: string; keepAspect?: boolean; fill?: string; op?: "combine" | "subtract" | "intersect" | "exclude"; name?: string } = {},
): Record<string, unknown> {
  if (!name.trim()) throw new Error("请选择一个形状预设");
  const [x, y, width, height] = rect;
  if (![x, y, width, height].every(value => Number.isFinite(value))) throw new Error("预设矩形必须是四个有限数值");
  if (width <= 0 || height <= 0) throw new Error("预设矩形的宽高必须大于 0");
  return {
    preset: name,
    rect: [x, y, width, height],
    ...(options.group ? { group: options.group } : {}),
    ...(options.keepAspect === undefined ? {} : { keepAspect: options.keepAspect }),
    ...(options.fill ? { fill: options.fill } : {}),
    ...(options.op ? { op: options.op } : {}),
    ...(options.name ? { name: options.name } : {}),
  };
}

/** 库编辑动作（重命名 / 删除 / 移动 / 分组）。 */
export type PresetAction =
  | { action: "rename"; preset: string; name: string; group?: string }
  | { action: "delete"; preset: string; group?: string }
  | { action: "move"; preset: string; to: string; group?: string }
  | { action: "newGroup"; name: string }
  | { action: "renameGroup"; group: string; name: string }
  | { action: "deleteGroup"; group: string };

/**
 * 库编辑参数。
 *
 * `group` 是上游查找的收窄条件：内置组里的预设必须带组名，否则内核在全库找重名会失配；
 * 「自定形状」是合成组、不在 `presets.shapes` 里，因此重命名/删除自定形状时**不能**带组名。
 * 调用方（面板）据 `libraryEntries().custom` 决定是否传。
 */
export function presetEditParams(action: PresetAction): Record<string, unknown> {
  const validName = (value: string) => value.trim().length > 0 && value.length <= MAX_PRESET_NAME;
  if (action.action === "rename" && !validName(action.name)) throw new Error("预设名称不能为空且不超过 200 字符");
  if (action.action === "move" && !action.to.trim()) throw new Error("请选择目标分组");
  if (action.action === "move" && action.group !== undefined && action.group === action.to) throw new Error("目标分组与当前分组相同");
  if ((action.action === "newGroup" || action.action === "renameGroup") && !validName(action.name)) {
    throw new Error("分组名称不能为空且不超过 200 字符");
  }
  if (action.action === "deleteGroup" && !action.group.trim()) throw new Error("请选择要删除的分组");
  return { ...action };
}

/** 从路径定义自定形状（工作路径 / 已存路径 / 当前形状 / 矢量蒙版）。 */
export function defineCustomShapeParams(name: string, path?: "work" | string): Record<string, unknown> {
  if (!name.trim()) throw new Error("自定义形状必须有名称");
  if (name.length > MAX_PRESET_NAME) throw new Error("自定义形状名称不能超过 200 字符");
  return { name: name.trim(), ...(path ? { path } : {}) };
}

/** 新建预设（把当前路径/形状/蒙版存进库）。 */
export function newPresetParams(name: string, options: { group?: string; path?: PenPath | "work" | string } = {}): Record<string, unknown> {
  if (!name.trim() || name.length > MAX_PRESET_NAME) throw new Error("预设名称不能为空且不超过 200 字符");
  const params: Record<string, unknown> = { name: name.trim() };
  if (options.group) params.group = options.group;
  if (options.path !== undefined) params.path = options.path;
  return params;
}

/** 快照是否在字节预算内（恢复前先拒绝超大输入，不进解析）。 */
export function snapshotWithinBudget(serialized: string): boolean {
  // 预算口径只有协议包一处；这里不再各留一份数字。
  return vectorPresetSnapshotWithinBudget(serialized);
}

/**
 * 恢复整个自定形状库：先在候选数组上完成名称与节点预算校验，成功后整批替换。
 *
 * 几何是否可保存**只由协议包裁定**（`vectorPathWithinBudget`），这里不维护第二套坐标/结构规则；
 * 本地只补充库级预算（名称、重复、单条与整库节点总数），并据此给出比布尔值更具体的失败原因。
 * 返回可直接交给恢复入口的数组；任一非法项抛错并保留原库。
 */
export function restoreSnapshotParams(entries: unknown): { name: string; path: PenPath }[] {
  if (!Array.isArray(entries)) throw new Error("自定形状快照必须是数组");
  if (entries.length > MAX_CUSTOM_SHAPES) throw new Error(`自定形状超过上限 ${MAX_CUSTOM_SHAPES}`);
  const seen = new Set<string>();
  let knots = 0;
  const out: { name: string; path: PenPath }[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) throw new Error("自定形状条目结构无效");
    const name = entry.name;
    if (typeof name !== "string" || !name.trim() || name.length > MAX_PRESET_NAME) throw new Error("自定形状名称非法");
    if (seen.has(name.trim())) throw new Error(`自定形状名称重复：${name}`);
    seen.add(name.trim());
    const path = entry.path;
    // 预设比通用路径更严格：内核 `path_within_budget` 对预设限制 256 个子路径，
    // 而通用路径预算允许 4096。这条**预设专属**上限必须在这里裁定，协议层不重复。
    if (isRecord(path) && Array.isArray(path.subpaths) && path.subpaths.length > MAX_PRESET_SUBPATHS) {
      throw new Error(`自定形状「${name}」的路径无效`);
    }
    // 结构/坐标一律交给协议解码器；只有它判通过才继续做库级预算。
    if (!vectorPathWithinBudget(path)) throw new Error(`自定形状「${name}」${pathProblem(path)}`);
    const subpaths = (path as { subpaths: { knots: unknown[] }[] }).subpaths;
    const own = subpaths.reduce((total, subpath) => total + subpath.knots.length, 0);
    if (own > MAX_PRESET_KNOTS) throw new Error(`自定形状「${name}」的节点数超出上限`);
    knots += own;
    if (knots > MAX_PRESET_KNOTS * 4) throw new Error("自定形状库节点总数超出上限");
    out.push({ name: name.trim(), path: path as PenPath });
  }
  return out;
}

/**
 * 为被协议拒绝的路径给出具体原因（只用于报错文案，不参与裁定）。
 *
 * 与 `vectorPathWithinBudget` 的判据一一对应：结构缺失 → 路径无效；子路径无锚点 → 缺少锚点；
 * 坐标越界 → 坐标非法。
 */
function pathProblem(path: unknown): string {
  if (!isRecord(path) || !Array.isArray(path.subpaths) || path.subpaths.length === 0 || path.subpaths.length > MAX_PRESET_SUBPATHS) {
    return "的路径无效";
  }
  for (const subpath of path.subpaths) {
    if (!isRecord(subpath) || !Array.isArray(subpath.knots) || subpath.knots.length === 0) return "缺少锚点";
    for (const knot of subpath.knots) {
      if (Array.isArray(knot)) {
        if (knot.length !== 2 || !knot.every(finitePoint)) return "的锚点坐标非法";
        continue;
      }
      if (!isRecord(knot) || knot.anchor === undefined) return "缺少锚点坐标";
      for (const key of ["anchor", "in", "out"] as const) {
        const value = knot[key];
        if (value === undefined) continue;
        if (!Array.isArray(value) || value.length !== 2 || !value.every(finitePoint)) return "的锚点坐标非法";
      }
    }
  }
  return "的路径无效";
}

/** 已应用形状是否仍对应某个库项摘要（删除库项后用于确认画面未变）。 */
export function matchesDigest(entry: ShapePresetEntry | undefined, digest: string): boolean {
  return !!entry?.digest && entry.digest === digest;
}
