import type { EditorFailure } from "../../editor-wasm.js";
import { buildStroke, type BrushSettings } from "../painting/tool-parameters.js";
import { clamp, type DocumentPoint } from "../shared/tool-parameters.js";

/**
 * 修饰域的参数契约（change: 2026-10-22-add-photocraft-retouch-workflows，U37/U38/U39）。
 *
 * 这里只有**纯数据**：命令目录、逐工具选项、区域参数与仿制源解码。所有命令字符串与取值范围
 * 与内核（`rust/crates/editor-core/src/features/retouch/retouch.rs`）逐项对齐；界面拿到的
 * 拒绝原因也由本模块给出，避免同一约束在面板里再写一份不同的数字。
 */

/** 修饰类画布工具（同一套笔迹接口，不同内核命令）。 */
export const RETOUCH_TOOL_IDS = ["clone", "heal", "retouch"] as const;

export function isRetouchTool(tool: string): tool is (typeof RETOUCH_TOOL_IDS)[number] {
  return (RETOUCH_TOOL_IDS as readonly string[]).includes(tool);
}

/** 笔迹（逐帧预览）命令。 */
export type RetouchStrokeCommand =
  | "paint.cloneStamp"
  | "paint.healingBrush"
  | "paint.spotHealing"
  | "paint.patternStamp"
  | "paint.historyBrush"
  | "paint.remove"
  | "paint.blur"
  | "paint.sharpen"
  | "paint.smudge"
  | "paint.dodge"
  | "paint.burn"
  | "paint.sponge";

/** 先选区域/点、再一次计算的命令（U37）。 */
export type RetouchRegionCommand = "paint.patch" | "paint.contentAwareMove" | "paint.redEye";

export type RetouchCommand = RetouchStrokeCommand | RetouchRegionCommand;

export const REGION_RETOUCH_COMMANDS = ["paint.patch", "paint.contentAwareMove", "paint.redEye"] as const;

export function isRegionRetouchCommand(id: string): id is RetouchRegionCommand {
  return (REGION_RETOUCH_COMMANDS as readonly string[]).includes(id);
}

export type RetouchCommandMeta = {
  id: RetouchCommand;
  label: string;
  /** `stroke` 走笔迹草稿；`region` 先算候选再确认。 */
  gesture: "stroke" | "region";
  /** 是否必须有采样点（仿制图章、修复画笔）。 */
  needsSource?: boolean;
  /** 参数面板分组，决定面板显示哪一组选项。 */
  options:
    | "source"
    | "healing"
    | "pattern"
    | "history"
    | "remove"
    | "tone"
    | "sponge"
    | "sharpen"
    | "smudge"
    | "blur"
    | "patch"
    | "move"
    | "redEye";
};

/** 全部已开放命令的界面元数据（顺序即面板顺序）。 */
export const RETOUCH_COMMANDS: readonly RetouchCommandMeta[] = [
  { id: "paint.cloneStamp", label: "仿制图章", gesture: "stroke", needsSource: true, options: "source" },
  { id: "paint.spotHealing", label: "污点修复", gesture: "stroke", options: "healing" },
  { id: "paint.healingBrush", label: "修复画笔", gesture: "stroke", needsSource: true, options: "healing" },
  { id: "paint.patternStamp", label: "图案图章", gesture: "stroke", options: "pattern" },
  { id: "paint.historyBrush", label: "历史记录画笔", gesture: "stroke", options: "history" },
  { id: "paint.blur", label: "模糊", gesture: "stroke", options: "blur" },
  { id: "paint.sharpen", label: "锐化", gesture: "stroke", options: "sharpen" },
  { id: "paint.smudge", label: "涂抹", gesture: "stroke", options: "smudge" },
  { id: "paint.dodge", label: "减淡", gesture: "stroke", options: "tone" },
  { id: "paint.burn", label: "加深", gesture: "stroke", options: "tone" },
  { id: "paint.sponge", label: "海绵", gesture: "stroke", options: "sponge" },
  { id: "paint.remove", label: "移除", gesture: "stroke", options: "remove" },
  { id: "paint.patch", label: "修补", gesture: "region", options: "patch" },
  { id: "paint.contentAwareMove", label: "内容识别移动", gesture: "region", options: "move" },
  { id: "paint.redEye", label: "红眼", gesture: "region", options: "redEye" }
];

/**
 * 共享上下文栏的「修饰工具」下拉（原 9 项，顺序与改动前一致）。
 *
 * 这一份是**唯一**清单：面板与 `editor-tool-panels` facade 都从这里取。新增笔迹工具见
 * [`RETOUCH_ADDED_TOOLS`]，完整下拉见 [`RETOUCH_ALL_TOOLS`]。
 */
export const RETOUCH_BASE_TOOLS = [
  { id: "paint.cloneStamp", label: "仿制图章" },
  { id: "paint.healingBrush", label: "修复画笔" },
  { id: "paint.spotHealing", label: "污点修复" },
  { id: "paint.blur", label: "模糊" },
  { id: "paint.sharpen", label: "锐化" },
  { id: "paint.smudge", label: "涂抹" },
  { id: "paint.dodge", label: "减淡" },
  { id: "paint.burn", label: "加深" },
  { id: "paint.sponge", label: "海绵" }
] as const;

/** 本域新增的笔迹工具（U38）：图案图章、历史记录画笔、移除。 */
export const RETOUCH_ADDED_TOOLS = [
  { id: "paint.patternStamp", label: "图案图章" },
  { id: "paint.historyBrush", label: "历史记录画笔" },
  { id: "paint.remove", label: "移除" }
] as const;

/**
 * 笔迹命令清单（原 9 项 + 本域新增 3 项）。
 *
 * 前两项（仿制图章、修复画笔）是独立的画布工具（`clone` / `heal`），所以上下文栏用
 * [`RETOUCH_MENU_TOOLS`] 把它们排掉；顺序仍是「原 9 项在前」，共享测试对 `RETOUCH_TOOLS`
 * 的长度断言不受影响。
 */
export const RETOUCH_ALL_TOOLS = [...RETOUCH_BASE_TOOLS, ...RETOUCH_ADDED_TOOLS] as const;

/**
 * 共享上下文栏「修饰工具」下拉的唯一清单：10 项笔迹命令 + 3 项区域命令。
 *
 * 区域命令**必须**进这个下拉：画布手势按当前命令分派（笔迹 → 逐帧预览，区域 → 拖动/单击生成
 * 候选），如果区域命令只在面板里有一个独立选择器，画布就永远不知道该走哪条路径，拖动分支成为
 * 死代码。这里收敛成一份之后，app 的 `retouchTool` 是唯一真值，面板只反映它、不再另存一份。
 */
export const RETOUCH_MENU_TOOLS = [
  ...RETOUCH_ALL_TOOLS.slice(2),
  { id: "paint.patch", label: "修补" },
  { id: "paint.contentAwareMove", label: "内容识别移动" },
  { id: "paint.redEye", label: "红眼" }
] as const;

/** 「修饰工具」下拉的既有清单（原 9 项，顺序与语义都不变）。 */
export const RETOUCH_TOOLS = RETOUCH_BASE_TOOLS;

/**
 * 「滤镜 → 修饰工具…」面板自己的工具选择器清单：13 项下拉 + 仿制图章/修复画笔。
 *
 * 上下文栏那条入口用 [`RETOUCH_MENU_TOOLS`]，因为仿制图章与修复画笔在工具栏里是独立按钮，
 * 再进下拉就重复了。高级面板没有工具栏上下文，用户只从这里进门，所以必须能选到它们；
 * 选定后由 `activateRetouchTool` 把画布工具一并切到 `clone`/`heal`，手势才不会错。
 */
export const RETOUCH_PANEL_TOOLS = [
  { id: "paint.cloneStamp", label: "仿制图章" },
  { id: "paint.healingBrush", label: "修复画笔" },
  ...RETOUCH_MENU_TOOLS
] as const;

export function retouchCommand(id: string): RetouchCommandMeta | undefined {
  return RETOUCH_COMMANDS.find((entry) => entry.id === id);
}

// ---------------------------------------------------------------- 逐工具选项（U39）

export type SpongeMode = "desaturate" | "saturate";
export type ToneRange = "shadows" | "midtones" | "highlights";
export type SampleLayer = "current" | "currentAndBelow" | "all";

export const SPONGE_MODES: readonly { id: SpongeMode; label: string }[] = [
  { id: "desaturate", label: "去色" },
  { id: "saturate", label: "加色" }
];

export const TONE_RANGES: readonly { id: ToneRange; label: string }[] = [
  { id: "shadows", label: "阴影" },
  { id: "midtones", label: "中间调" },
  { id: "highlights", label: "高光" }
];

export const SAMPLE_LAYERS: readonly { id: SampleLayer; label: string }[] = [
  { id: "current", label: "当前图层" },
  { id: "currentAndBelow", label: "当前及下方" },
  { id: "all", label: "所有图层" }
];

/** 面板持有的工具选项；不属于文档内容，也不进入内容指纹。 */
export type RetouchOptions = {
  spongeMode: SpongeMode;
  toneRange: ToneRange;
  /** 减淡/加深曝光，1–100。 */
  exposure: number;
  /** 模糊/锐化/涂抹强度，1–100。 */
  strength: number;
  fingerPainting: boolean;
  protectDetail: boolean;
  protectTones: boolean;
  vibrance: boolean;
  /** 图案图章的图案 key；空串表示使用图案面板当前图案。 */
  patternId: string;
  /** 图案缩放百分比，1–1000。 */
  patternScale: number;
  /** 图案旋转角度，-180–180。 */
  patternAngle: number;
  patternAligned: boolean;
  patternImpressionist: boolean;
  /** 历史画笔的历史源索引。 */
  historyState: number;
  sampleLayer: SampleLayer;
  removeCloseLoops: boolean;
  /** 移除结果放进新图层（原图层保留）。 */
  removeNewLayer: boolean;
};

export const DEFAULT_RETOUCH_OPTIONS: RetouchOptions = {
  spongeMode: "desaturate",
  toneRange: "midtones",
  exposure: 50,
  strength: 50,
  fingerPainting: false,
  protectDetail: true,
  protectTones: true,
  vibrance: true,
  patternId: "",
  patternScale: 100,
  patternAngle: 0,
  patternAligned: true,
  patternImpressionist: false,
  historyState: 0,
  sampleLayer: "current",
  removeCloseLoops: true,
  removeNewLayer: false
};

function integer(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

/** 归一化并钳制面板输入；界面不会把越界值送进内核。 */
export function clampRetouchOptions(patch: Partial<RetouchOptions>): RetouchOptions {
  const next: RetouchOptions = { ...DEFAULT_RETOUCH_OPTIONS, ...patch };
  return {
    ...next,
    spongeMode: next.spongeMode === "saturate" ? "saturate" : "desaturate",
    toneRange: (TONE_RANGES.some((entry) => entry.id === next.toneRange) ? next.toneRange : "midtones"),
    exposure: clamp(integer(next.exposure, 50), 1, 100),
    strength: clamp(integer(next.strength, 50), 1, 100),
    patternScale: clamp(Number.isFinite(next.patternScale) ? next.patternScale : 100, 1, 1000),
    patternAngle: clamp(Number.isFinite(next.patternAngle) ? next.patternAngle : 0, -180, 180),
    historyState: Math.max(0, integer(next.historyState, 0)),
    sampleLayer: (SAMPLE_LAYERS.some((entry) => entry.id === next.sampleLayer) ? next.sampleLayer : "current")
  };
}

/**
 * 逐命令校验工具选项，返回中文拒绝原因（`null` 表示可提交）。
 *
 * 与内核 `validate_tool_params` 同一组上限；这里是**提前**反馈，内核仍然复核。
 */
export function validateRetouchOptions(id: string, options: RetouchOptions): string | null {
  if (!id.startsWith("paint.")) return `${id} 不是修饰命令`;
  switch (id) {
    case "paint.dodge":
    case "paint.burn":
      if (!TONE_RANGES.some((entry) => entry.id === options.toneRange)) return "范围必须是阴影、中间调或高光";
      if (!(options.exposure >= 1 && options.exposure <= 100)) return "曝光必须在 1–100 之间";
      return null;
    case "paint.sponge":
      return options.spongeMode === "saturate" || options.spongeMode === "desaturate"
        ? null
        : "海绵只能加色或去色";
    case "paint.blur":
    case "paint.sharpen":
    case "paint.smudge":
      return options.strength >= 1 && options.strength <= 100 ? null : "强度必须在 1–100 之间";
    case "paint.patternStamp":
      if (!(options.patternScale >= 1 && options.patternScale <= 1000)) return "图案缩放必须在 1–1000 % 之间";
      if (!Number.isFinite(options.patternAngle)) return "图案角度必须是有限数值";
      return null;
    case "paint.historyBrush":
      return Number.isInteger(options.historyState) && options.historyState >= 0 ? null : "历史源索引必须是非负整数";
    default:
      return null;
  }
}

/** 一笔修饰的附加参数（画布手势与面板共同提供，开始一笔时冻结）。 */
export type RetouchStrokeExtras = {
  /** 目标像素层；缺省用活动层。 */
  layer?: number | null;
  zoom?: number;
  /** 采样点（Alt+单击）；仿制图章与修复画笔必需其一。 */
  source?: readonly [number, number] | null;
  /** 对齐的首笔锚点。 */
  anchor?: readonly [number, number] | null;
  aligned?: boolean;
  /** 仿制源槽位的变换（U39：多仿制源缩放/旋转/翻转冻结于一笔）。 */
  transform?: { scale?: readonly [number, number]; rotation?: number; flipH?: boolean; flipV?: boolean } | null;
};

/**
 * 逐命令的工具选项 → 内核参数名（**唯一**一张表）。
 *
 * 面板的输入、会话的落笔补丁与测试都从这里取值，避免同一组上限/键名写两遍而漂移。
 */
export function retouchOptionParams(id: string, options: RetouchOptions): Record<string, unknown> {
  switch (id) {
    case "paint.cloneStamp":
    case "paint.healingBrush":
      return { sampleLayer: options.sampleLayer };
    case "paint.spotHealing":
      return { sampleAllLayers: options.sampleLayer === "all" };
    case "paint.patternStamp":
      return {
        ...(options.patternId ? { pattern: options.patternId } : {}),
        scale: options.patternScale,
        angle: options.patternAngle,
        aligned: options.patternAligned,
        impressionist: options.patternImpressionist
      };
    case "paint.historyBrush":
      return { state: options.historyState };
    case "paint.remove":
      return {
        closeLoops: options.removeCloseLoops,
        newLayer: options.removeNewLayer,
        sampleAllLayers: options.sampleLayer === "all"
      };
    case "paint.dodge":
    case "paint.burn":
      return { range: options.toneRange, exposure: options.exposure, protectTones: options.protectTones };
    case "paint.sponge":
      // 海绵的 `mode` 是工具语义（增/减饱和），不是混合模式。
      return { mode: options.spongeMode, vibrance: options.vibrance };
    case "paint.sharpen":
      return { strength: options.strength, protectDetail: options.protectDetail, sampleAllLayers: options.sampleLayer === "all" };
    case "paint.smudge":
      return { strength: options.strength, fingerPainting: options.fingerPainting, sampleAllLayers: options.sampleLayer === "all" };
    case "paint.blur":
      return { strength: options.strength, sampleAllLayers: options.sampleLayer === "all" };
    default:
      return {};
  }
}

/**
 * 逐命令的笔迹参数。
 *
 * 共用 `buildStroke` 的画笔形状（尺寸/硬度/不透明度/流量/间距），再按工具语义追加专用键：
 * 海绵写 `mode: saturate|desaturate`（不再让通用模板的 `mode:"normal"` 漏进内核），减淡/加深写
 * `range`/`exposure`，图案图章写 `pattern`/`scale`/`angle`，历史画笔写 `state`。
 */
export function retouchStrokeParams(
  id: RetouchStrokeCommand,
  points: readonly DocumentPoint[],
  brush: BrushSettings,
  options: RetouchOptions,
  extras: RetouchStrokeExtras = {}
): Record<string, unknown> | null {
  if (validateRetouchOptions(id, options)) return null;
  const base = buildStroke(points, brush, { zoom: extras.zoom });
  if (!base) return null;
  const params: Record<string, unknown> = { ...base };
  if (typeof extras.layer === "number") params.layer = extras.layer;
  if (id === "paint.cloneStamp" || id === "paint.healingBrush") {
    params.aligned = extras.aligned ?? true;
    if (extras.source) params.source = [extras.source[0], extras.source[1]];
    if (extras.anchor) params.anchor = [extras.anchor[0], extras.anchor[1]];
    const transform = extras.transform;
    if (transform?.scale) params.scale = [transform.scale[0], transform.scale[1]];
    if (typeof transform?.rotation === "number") params.rotation = transform.rotation;
    if (typeof transform?.flipH === "boolean") params.flipH = transform.flipH;
    if (typeof transform?.flipV === "boolean") params.flipV = transform.flipV;
    return { ...params, ...retouchOptionParams(id, options) };
  }
  // 采样/局部修饰命令的 `mode` 不是混合模式（海绵除外，它由选项表写入增/减饱和）。
  delete params.mode;
  return { ...params, ...retouchOptionParams(id, options) };
}

// ---------------------------------------------------------------- 区域命令（U37）

export type PatchMode = "source" | "destination";
export type ContentAwareMoveMode = "move" | "extend";

export const PATCH_MODES: readonly { id: PatchMode; label: string }[] = [
  { id: "source", label: "源" },
  { id: "destination", label: "目标" }
];

export const MOVE_MODES: readonly { id: ContentAwareMoveMode; label: string }[] = [
  { id: "move", label: "移动" },
  { id: "extend", label: "扩展" }
];

/** 区域命令的面板选项。 */
export type RegionOptions = {
  patchMode: PatchMode;
  moveMode: ContentAwareMoveMode;
  /** 结构 1–7（内容识别）。 */
  structure: number;
  /** 颜色适应 0–10。 */
  color: number;
  sampleAllLayers: boolean;
  /** 移动时的变换（松手前预览）。 */
  scaleX: number;
  scaleY: number;
  rotate: number;
  redEyePupilSize: number;
  redEyeDarken: number;
};

export const DEFAULT_REGION_OPTIONS: RegionOptions = {
  patchMode: "source",
  moveMode: "move",
  structure: 4,
  color: 0,
  sampleAllLayers: false,
  scaleX: 100,
  scaleY: 100,
  rotate: 0,
  redEyePupilSize: 50,
  redEyeDarken: 50
};

export function clampRegionOptions(patch: Partial<RegionOptions>): RegionOptions {
  const next: RegionOptions = { ...DEFAULT_REGION_OPTIONS, ...patch };
  return {
    ...next,
    patchMode: next.patchMode === "destination" ? "destination" : "source",
    moveMode: next.moveMode === "extend" ? "extend" : "move",
    structure: clamp(integer(next.structure, 4), 1, 7),
    color: clamp(Number.isFinite(next.color) ? next.color : 0, 0, 10),
    scaleX: clamp(Number.isFinite(next.scaleX) ? next.scaleX : 100, 1, 10000),
    scaleY: clamp(Number.isFinite(next.scaleY) ? next.scaleY : 100, 1, 10000),
    rotate: clamp(Number.isFinite(next.rotate) ? next.rotate : 0, -180, 180),
    redEyePupilSize: clamp(integer(next.redEyePupilSize, 50), 1, 100),
    redEyeDarken: clamp(integer(next.redEyeDarken, 50), 0, 100)
  };
}

/** 一次区域操作的位置输入：修补/移动是拖动偏移，红眼是单击点。 */
export type RegionGesture = {
  offset?: readonly [number, number] | null;
  points?: readonly (readonly [number, number])[] | null;
  layer?: number | null;
};

export function validateRegionGesture(id: RetouchRegionCommand, options: RegionOptions, gesture: RegionGesture): string | null {
  if (id === "paint.patch" || id === "paint.contentAwareMove") {
    const offset = gesture.offset;
    if (!offset || offset.length !== 2 || !offset.every((value) => Number.isFinite(value))) {
      return "需要拖动偏移 [dx, dy]";
    }
    // 零偏移是没有拖动：确认它只会造一条无变化的历史，不如先拒绝并说明。
    if (offset[0] === 0 && offset[1] === 0) return "拖动偏移不能为 0（请给出实际拖动距离）";
    if (id === "paint.patch" && !PATCH_MODES.some((entry) => entry.id === options.patchMode)) return "修补模式必须是源或目标";
    if (id === "paint.contentAwareMove" && !MOVE_MODES.some((entry) => entry.id === options.moveMode)) return "移动模式必须是移动或扩展";
    if (!(options.structure >= 1 && options.structure <= 7)) return "结构必须在 1–7 之间";
    if (!(options.color >= 0 && options.color <= 10)) return "颜色适应必须在 0–10 之间";
    return null;
  }
  const count = gesture.points?.length ?? 0;
  if (count === 0) return "请先点选红眼位置";
  if (count > 64) return "一次最多修正 64 处红眼";
  if (!(options.redEyePupilSize >= 1 && options.redEyePupilSize <= 100)) return "瞳孔大小必须在 1–100 之间";
  if (!(options.redEyeDarken >= 0 && options.redEyeDarken <= 100)) return "变暗量必须在 0–100 之间";
  return null;
}

/** 区域命令参数（不含拖动结果时返回 `null`，由调用方给出提示）。 */
export function regionParams(
  id: RetouchRegionCommand,
  options: RegionOptions,
  gesture: RegionGesture
): Record<string, unknown> | null {
  if (validateRegionGesture(id, options, gesture)) return null;
  const params: Record<string, unknown> = {};
  if (typeof gesture.layer === "number") params.layer = gesture.layer;
  if (id === "paint.redEye") {
    const points = gesture.points ?? [];
    params.points = points.map(([x, y]) => [x, y]);
    params.pupilSize = options.redEyePupilSize;
    params.darken = options.redEyeDarken;
    return params;
  }
  const [dx, dy] = gesture.offset!;
  params.offset = [dx, dy];
  if (id === "paint.patch") {
    params.mode = options.patchMode;
    params.structure = options.structure;
    params.color = options.color;
    params.sampleAllLayers = options.sampleAllLayers;
    return params;
  }
  params.mode = options.moveMode;
  params.structure = options.structure;
  params.color = options.color;
  params.sampleAllLayers = options.sampleAllLayers;
  params.scaleX = options.scaleX;
  params.scaleY = options.scaleY;
  params.rotate = options.rotate;
  return params;
}

// ---------------------------------------------------------------- 历史画笔源（U38）

/** 历史画笔可选的历史源（索引即 `state` 参数）。 */
export type RetouchHistorySource = {
  index: number;
  label: string;
  current: boolean;
  /** 该状态里含有当前图层；`false` 时不能取样（上游会拒绝）。 */
  available: boolean;
};

export function decodeHistorySources(value: unknown): RetouchHistorySource[] {
  const states = isRecord(value) && Array.isArray(value.states) ? value.states : [];
  return states.flatMap((entry): RetouchHistorySource[] => {
    if (!isRecord(entry)) return [];
    if (typeof entry.index !== "number" || typeof entry.label !== "string") return [];
    return [{
      index: entry.index,
      label: entry.label,
      current: entry.current === true,
      available: entry.available === true
    }];
  });
}

// ---------------------------------------------------------------- 仿制源槽位（U39）

export const CLONE_SOURCE_SLOTS = 5;

export type CloneSourceSlot = {
  index: number;
  source: readonly [number, number] | null;
  anchor: readonly [number, number] | null;
  offset: readonly [number, number] | null;
  layer: number | null;
  /** 宽/高百分比，1–1000。 */
  width: number;
  height: number;
  linked: boolean;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
};

export type CloneOverlay = {
  show: boolean;
  /** 0–100。 */
  opacity: number;
  clipped: boolean;
  autoHide: boolean;
  invert: boolean;
  blend: "normal" | "darken" | "lighten" | "difference";
};

export type CloneSourceState = { active: number; slots: CloneSourceSlot[]; overlay: CloneOverlay };

export const CLONE_OVERLAY_BLENDS: readonly CloneOverlay["blend"][] = ["normal", "darken", "lighten", "difference"];

function pair(value: unknown): readonly [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const [x, y] = value;
  return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 解码 `cloneSource.list` 的结果；结构非法时返回 `null`（不伪造空槽位）。 */
export function decodeCloneSources(value: unknown): CloneSourceState | null {
  if (!isRecord(value) || !Array.isArray(value.sources)) return null;
  const slots = value.sources.flatMap((entry): CloneSourceSlot[] => {
    if (!isRecord(entry) || typeof entry.index !== "number") return [];
    return [{
      index: entry.index,
      source: pair(entry.source),
      anchor: pair(entry.anchor),
      offset: pair(entry.offset),
      layer: typeof entry.layer === "number" ? entry.layer : null,
      width: finite(entry.width, 100),
      height: finite(entry.height, 100),
      linked: entry.linked === true,
      rotation: finite(entry.rotation, 0),
      flipH: entry.flipH === true,
      flipV: entry.flipV === true
    }];
  });
  const overlay = isRecord(value.overlay) ? value.overlay : {};
  return {
    active: typeof value.active === "number" ? value.active : 0,
    slots,
    overlay: {
      show: overlay.show !== false,
      opacity: finite(overlay.opacity, 100),
      clipped: overlay.clipped !== false,
      autoHide: overlay.auto_hide !== false,
      invert: overlay.invert === true,
      blend: CLONE_OVERLAY_BLENDS.includes(overlay.blend as CloneOverlay["blend"])
        ? (overlay.blend as CloneOverlay["blend"])
        : "normal"
    }
  };
}

/** 选中槽位。 */
export function cloneSourceSelectParams(index: number): { index: number } {
  return { index: clamp(integer(index, 0), 0, CLONE_SOURCE_SLOTS - 1) };
}

/** 修改槽位的采样点/偏移/变换。 */
export function cloneSourceSetParams(
  index: number,
  patch: Partial<Omit<CloneSourceSlot, "index">> & { clear?: boolean }
): Record<string, unknown> {
  const params: Record<string, unknown> = cloneSourceSelectParams(index);
  delete params.select;
  if (patch.source) params.source = [patch.source[0], patch.source[1]];
  if (patch.offset) params.offset = [patch.offset[0], patch.offset[1]];
  if (typeof patch.layer === "number") params.layer = patch.layer;
  if (typeof patch.width === "number") params.width = clamp(patch.width, 1, 1000);
  if (typeof patch.height === "number") params.height = clamp(patch.height, 1, 1000);
  if (typeof patch.linked === "boolean") params.linked = patch.linked;
  if (typeof patch.rotation === "number") params.rotation = clamp(patch.rotation, -180, 180);
  if (typeof patch.flipH === "boolean") params.flipH = patch.flipH;
  if (typeof patch.flipV === "boolean") params.flipV = patch.flipV;
  if (patch.clear === true) params.clear = true;
  return params;
}

export function cloneSourceResetParams(index: number): { index: number } {
  return cloneSourceSelectParams(index);
}

/** 叠加预览选项（U39：叠加层与取景一致）。 */
export function cloneOverlayParams(patch: Partial<CloneOverlay>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (typeof patch.show === "boolean") params.show = patch.show;
  if (typeof patch.opacity === "number") params.opacity = clamp(patch.opacity, 0, 100);
  if (typeof patch.clipped === "boolean") params.clipped = patch.clipped;
  if (typeof patch.autoHide === "boolean") params.autoHide = patch.autoHide;
  if (typeof patch.invert === "boolean") params.invert = patch.invert;
  if (patch.blend && CLONE_OVERLAY_BLENDS.includes(patch.blend)) params.blend = patch.blend;
  return params;
}

// ---------------------------------------------------------------- 失败文案

/** 内核失败 → 界面文案；已带中文原因的失败原样显示，不吞掉具体条件。 */
export function describeRetouchFailure(failure: EditorFailure): string {
  if (failure.message) return failure.message;
  switch (failure.code) {
    case "no-document":
      return "编辑器尚未打开文档";
    case "gesture-active":
    case "stroke-active":
      return "请先结束当前笔迹";
    case "retouch-active":
      return "请先确认或取消当前修饰操作";
    case "unsupported-command":
      return "当前工具不支持这条修饰命令";
    case "invalid-message":
      return "修饰结果结构非法";
    default:
      return "修饰操作失败，请重试";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
