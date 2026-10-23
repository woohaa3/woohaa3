/**
 * 笔刷工作流：预设库、笔尖设置与压感/平滑控制
 * （change: 2026-10-22-complete-photocraft-webui-editing，任务 2.1–2.5 / design D4）。
 *
 * 三层分工，任何一层都不复制另一层的模型：
 *
 * - **内核**（`brushPresetsJson` / `brushPreview` / `saveBrushPreset`…）持有库、位图与真实笔迹渲染；
 * - **本模块**只做界面状态：选择、草稿参数（未保存的笔刷设置）、忙碌与错误文本；
 * - **PhotoEditorApp** 把本模块的状态编译成 `paint.stroke` 的 `brush` 补丁（参数形状见
 *   `photo-editor-tools.ts` 的 `brushSettingsPatch`）。
 *
 * 关键约束：
 * - 改笔刷偏好不制造工程 dirty（库是工具状态，不进入文档内容 hash）；
 * - 库持久化失败保留内存库并提示，不覆盖有效旧数据；
 * - 预览走真实内核，和正式笔迹同一份 `render_stroke` 实现。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditorHandle, EditorPreview } from "../../editor-wasm.js";
import {
  isMaskMode,
  isTextureStyle,
  type MaskMode,
  type TextureStyle
} from "./blend-modes.js";
import { decodeCurvePoints, type CurvePoint } from "./curve-points.js";

/** 一条库预设的摘要（`brushPresetsJson(false)` 的元素）。 */
export type BrushPresetSummary = {
  name: string;
  group: string;
  folder: string[];
  origin: "builtin" | "user" | "abr" | "image";
  /** 是否带采样笔尖位图（采样预设） */
  sampled: boolean;
};

export type BrushPresetList = {
  presets: BrushPresetSummary[];
  count: number;
  groups: { group: string; count: number }[];
};

/** 压力控制器（与内核 `Control` 一致的子集；`off` 不产生作用）。 */
export type BrushControl = "off" | "penPressure" | "penTilt" | "fade" | "stylusWheel" | "rotation" | "initialDirection" | "direction";

/** 角度动态可用的控制器（其余控制对角度无意义，内核也忽略）。 */
export const ANGLE_CONTROLS: readonly BrushControl[] = ["off", "penTilt", "rotation", "stylusWheel", "initialDirection", "direction"];

/**
 * 笔尖与动态的界面参数。
 *
 * 与 `BrushSettings` 的字段同名（camelCase），因此可以直接作为 `paint.stroke` 的 `brush`
 * 补丁；未列出的字段保持内核默认，不由前端补造。
 */
export type BrushDynamics = {
  /** 间距（直径的比例）；`spacingEnabled` 为 false 时由速度决定 */
  spacing: number;
  spacingEnabled: boolean;
  /** 角度（度，逆时针） */
  angle: number;
  /** 圆度 0–1 */
  roundness: number;
  flipX: boolean;
  flipY: boolean;
  /** 大小动态 */
  sizeJitter: number;
  sizeControl: BrushControl;
  sizeMinimum: number;
  /** 不透明度动态（传递） */
  opacityJitter: number;
  opacityControl: BrushControl;
  opacityMinimum: number;
  /** 流量动态（传递） */
  flowJitter: number;
  flowControl: BrushControl;
  flowMinimum: number;
  /** 散布 0–10（1 = 100%） */
  scatter: number;
  scatterCount: number;
  /** 散布的径向（双轴）模式与数量抖动（U30） */
  scatterBothAxes: boolean;
  scatterJitter: number;
  scatterMinimum: number;
  /** 角度动态与圆度动态（U30）：抖动 0–1 与控制器 */
  angleJitter: number;
  angleControl: BrushControl;
  roundnessJitter: number;
  roundnessControl: BrushControl;
  roundnessMinimum: number;
  /** 纹理（U30）：程序化图案、缩放、亮度/对比、深度与掩膜模式 */
  textureEnabled: boolean;
  /** `custom` 表示当前是库里的采样图案瓦片，界面不改写它（保持内核现有图案）。 */
  textureStyle: TextureStyle | "custom";
  textureScale: number;
  textureInvert: boolean;
  textureMode: MaskMode;
  textureDepth: number;
  /** 颜色动态（U30）：前景/背景混合、色相/饱和度/明度抖动与纯度 */
  colorDynamicsEnabled: boolean;
  colorPerTip: boolean;
  fgBgJitter: number;
  fgBgControl: BrushControl;
  hueJitter: number;
  saturationJitter: number;
  brightnessJitter: number;
  purity: number;
  /** 每项动态自己的响应曲线（`[input, output]` 点集；空 = 线性） */
  sizeCurve: CurvePoint[];
  opacityCurve: CurvePoint[];
  flowCurve: CurvePoint[];
  /** 平滑 0–1 与拉绳／追赶 */
  smoothing: number;
  pulledString: boolean;
  catchUp: boolean;
  catchUpOnEnd: boolean;
  adjustForZoom: boolean;
};

export const DEFAULT_DYNAMICS: BrushDynamics = {
  spacing: 0.25,
  spacingEnabled: true,
  angle: 0,
  roundness: 1,
  flipX: false,
  flipY: false,
  sizeJitter: 0,
  sizeControl: "penPressure",
  sizeMinimum: 0,
  opacityJitter: 0,
  opacityControl: "penPressure",
  opacityMinimum: 0,
  flowJitter: 0,
  flowControl: "off",
  flowMinimum: 0,
  scatter: 0,
  scatterCount: 1,
  scatterBothAxes: false,
  scatterJitter: 0,
  scatterMinimum: 0,
  angleJitter: 0,
  angleControl: "off",
  roundnessJitter: 0,
  roundnessControl: "off",
  roundnessMinimum: 0,
  textureEnabled: false,
  textureStyle: "paper",
  textureScale: 1,
  textureInvert: false,
  textureMode: "multiply",
  textureDepth: 1,
  colorDynamicsEnabled: false,
  colorPerTip: true,
  fgBgJitter: 0,
  fgBgControl: "off",
  hueJitter: 0,
  saturationJitter: 0,
  brightnessJitter: 0,
  purity: 0,
  sizeCurve: [],
  opacityCurve: [],
  flowCurve: [],
  smoothing: 0.2,
  pulledString: false,
  catchUp: true,
  catchUpOnEnd: true,
  adjustForZoom: true
};

const CONTROL_IDS: BrushControl[] = ["off", "penPressure", "penTilt", "fade", "stylusWheel", "rotation", "initialDirection", "direction"];

/** 读取内核 `brush.get` 返回的笔刷设置，折叠成本模块的动态参数。 */
export function dynamicsFromBrush(brush: unknown): BrushDynamics {
  if (!isRecord(brush)) return DEFAULT_DYNAMICS;
  const number = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const boolean = (value: unknown, fallback: boolean): boolean =>
    typeof value === "boolean" ? value : fallback;
  const control = (value: unknown, fallback: BrushControl): BrushControl => {
    if (!isRecord(value) || value.control === undefined) return fallback;
    return typeof value.control === "string" && CONTROL_IDS.includes(value.control as BrushControl)
      ? (value.control as BrushControl) : "off";
  };
  const dynamic = (value: unknown) => (isRecord(value) ? value : {});
  const curve = (value: unknown): CurvePoint[] => decodeCurvePoints(dynamic(value).curve) ?? [];
  const smoothing = dynamic(brush.smoothing);
  const shape = dynamic(brush.shapeDynamics);
  const transfer = dynamic(brush.transfer);
  const scattering = dynamic(brush.scattering);
  const texture = dynamic(brush.texture);
  const color = dynamic(brush.colorDynamics);
  return {
    spacing: number(brush.spacing, DEFAULT_DYNAMICS.spacing),
    spacingEnabled: boolean(brush.spacingEnabled, true),
    angle: number(brush.angle, 0),
    roundness: number(brush.roundness, 1),
    flipX: boolean(brush.flipX, false),
    flipY: boolean(brush.flipY, false),
    sizeJitter: number(dynamic(shape.size).jitter, 0),
    sizeControl: control(dynamic(shape.size), DEFAULT_DYNAMICS.sizeControl),
    sizeMinimum: number(dynamic(shape.size).minimum, 0),
    opacityJitter: number(dynamic(transfer.opacity).jitter, 0),
    opacityControl: control(dynamic(transfer.opacity), DEFAULT_DYNAMICS.opacityControl),
    opacityMinimum: number(dynamic(transfer.opacity).minimum, 0),
    flowJitter: number(dynamic(transfer.flow).jitter, 0),
    flowControl: control(dynamic(transfer.flow), DEFAULT_DYNAMICS.flowControl),
    flowMinimum: number(dynamic(transfer.flow).minimum, 0),
    scatter: number(dynamic(scattering.scatter).jitter, 0),
    scatterCount: Math.max(1, Math.min(16, Math.round(number(scattering.count, 1)))),
    scatterBothAxes: boolean(scattering.bothAxes, false),
    scatterJitter: number(dynamic(scattering.countJitter).jitter, 0),
    scatterMinimum: number(dynamic(scattering.countJitter).minimum, 0),
    angleJitter: number(dynamic(shape.angle).jitter, 0),
    angleControl: control(dynamic(shape.angle), "off"),
    roundnessJitter: number(dynamic(shape.roundness).jitter, 0),
    roundnessControl: control(dynamic(shape.roundness), "off"),
    roundnessMinimum: number(dynamic(shape.roundness).minimum, 0),
    textureEnabled: boolean(texture.enabled, false),
    textureStyle: textureStyleOf(texture),
    textureScale: number(texture.scale, 1),
    textureInvert: boolean(texture.invert, false),
    textureMode: maskModeOf(texture.mode),
    textureDepth: number(texture.depth, 1),
    colorDynamicsEnabled: boolean(color.enabled, false),
    colorPerTip: boolean(color.perTip, true),
    fgBgJitter: number(dynamic(color.fgBg).jitter, 0),
    fgBgControl: control(dynamic(color.fgBg), "off"),
    hueJitter: number(color.hueJitter, 0),
    saturationJitter: number(color.saturationJitter, 0),
    brightnessJitter: number(color.brightnessJitter, 0),
    purity: number(color.purity, 0),
    sizeCurve: curve(shape.size),
    opacityCurve: curve(transfer.opacity),
    flowCurve: curve(transfer.flow),
    smoothing: number(smoothing.amount, DEFAULT_DYNAMICS.smoothing),
    pulledString: boolean(smoothing.pulledString, false),
    catchUp: boolean(smoothing.catchUp, true),
    catchUpOnEnd: boolean(smoothing.catchUpOnEnd, true),
    adjustForZoom: boolean(smoothing.adjustForZoom, true)
  };
}

/**
 * 内核 `Pattern` → 界面选项。
 *
 * `custom` 表示笔刷带的是采样/内置**图案瓦片**（`{tile}` / `{stored}`）：这类图案由库持有，
 * 界面不复制它，也不在补丁里重发 `pattern`，否则会把用户的采样纹理覆盖成程序化图案。
 * 反过来，补丁里没有 `pattern` 字段（自己发出去的 `custom` 补丁）也读作 `custom`，这样
 * 「设置 → 预览」的往返不会把采样纹理悄悄换成纸纹。
 */
function textureStyleOf(texture: unknown): TextureStyle | "custom" {
  if (!isRecord(texture) || Object.keys(texture).length === 0) return DEFAULT_DYNAMICS.textureStyle;
  const pattern = texture.pattern;
  if (pattern === undefined) return "custom";
  if (!isRecord(pattern)) return DEFAULT_DYNAMICS.textureStyle;
  const procedural = isRecord(pattern.procedural) ? pattern.procedural : null;
  const style = procedural?.style;
  return typeof style === "string" && isTextureStyle(style) ? style : "custom";
}

function maskModeOf(value: unknown): MaskMode {
  return typeof value === "string" && isMaskMode(value) ? value : "multiply";
}

/**
 * 动态参数 → `paint.stroke` 的 `brush` 补丁。
 *
 * 只写本面板拥有的字段；开关关闭时同时把 `enabled` 置 false，参数值保留（与 Photoshop
 * 「禁用保留用户值」一致）。`texture.pattern` 只在界面明确选择了程序化图案时发送，
 * 采样纹理（`custom`）沿用内核当前图案。
 */
export function dynamicsPatch(dynamics: BrushDynamics): Record<string, unknown> {
  const dynamic = (jitter: number, control: BrushControl, minimum: number, curve?: CurvePoint[]) => ({
    jitter: clamp01(jitter),
    control,
    minimum: clamp01(minimum),
    // 显式写回曲线：`tools.setBrush` 的补丁是合并语义，省略会保留内核里上一份曲线。
    ...(curve && curve.length >= 2 ? { curve } : {})
  });
  const shapeOn = dynamics.sizeControl !== "off" || dynamics.sizeJitter > 0
    || dynamics.angleControl !== "off" || dynamics.angleJitter > 0
    || dynamics.roundnessControl !== "off" || dynamics.roundnessJitter > 0;
  const transferOn =
    dynamics.opacityControl !== "off" ||
    dynamics.opacityJitter > 0 ||
    dynamics.flowControl !== "off" ||
    dynamics.flowJitter > 0;
  const scatterOn = dynamics.scatter > 0 || dynamics.scatterCount > 1
    || dynamics.scatterJitter > 0 || dynamics.scatterBothAxes;
  const colorOn = dynamics.colorDynamicsEnabled
    || dynamics.fgBgControl !== "off" || dynamics.fgBgJitter > 0
    || dynamics.hueJitter > 0 || dynamics.saturationJitter > 0 || dynamics.brightnessJitter > 0
    || dynamics.purity !== 0;
  return {
    spacing: clamp(dynamics.spacing, 0.01, 10),
    spacingEnabled: dynamics.spacingEnabled,
    angle: clamp(dynamics.angle, -360, 360),
    roundness: clamp01(dynamics.roundness),
    flipX: dynamics.flipX,
    flipY: dynamics.flipY,
    shapeDynamics: {
      enabled: shapeOn,
      size: dynamic(dynamics.sizeJitter, dynamics.sizeControl, dynamics.sizeMinimum, dynamics.sizeCurve),
      angle: dynamic(dynamics.angleJitter, dynamics.angleControl, 0),
      roundness: dynamic(dynamics.roundnessJitter, dynamics.roundnessControl, dynamics.roundnessMinimum)
    },
    transfer: {
      enabled: transferOn,
      opacity: dynamic(dynamics.opacityJitter, dynamics.opacityControl, dynamics.opacityMinimum, dynamics.opacityCurve),
      flow: dynamic(dynamics.flowJitter, dynamics.flowControl, dynamics.flowMinimum, dynamics.flowCurve)
    },
    scattering: {
      enabled: scatterOn,
      scatter: { jitter: clamp(dynamics.scatter, 0, 10), control: "off" as const, minimum: 0 },
      bothAxes: dynamics.scatterBothAxes,
      count: Math.max(1, Math.min(16, Math.round(dynamics.scatterCount))),
      countJitter: dynamic(dynamics.scatterJitter, "off", dynamics.scatterMinimum)
    },
    texture: {
      enabled: dynamics.textureEnabled,
      ...(dynamics.textureStyle === "custom"
        ? {}
        : { pattern: { procedural: { style: dynamics.textureStyle, size: 128, seed: 1 } } }),
      invert: dynamics.textureInvert,
      scale: clamp(dynamics.textureScale, 0.01, 10),
      mode: dynamics.textureMode,
      depth: clamp01(dynamics.textureDepth)
    },
    colorDynamics: {
      enabled: colorOn,
      perTip: dynamics.colorPerTip,
      fgBg: dynamic(dynamics.fgBgJitter, dynamics.fgBgControl, 0),
      hueJitter: clamp01(dynamics.hueJitter),
      saturationJitter: clamp01(dynamics.saturationJitter),
      brightnessJitter: clamp01(dynamics.brightnessJitter),
      purity: clamp(dynamics.purity, -1, 1)
    },
    smoothing: {
      enabled: true,
      amount: clamp01(dynamics.smoothing),
      pulledString: dynamics.pulledString,
      catchUp: dynamics.catchUp,
      catchUpOnEnd: dynamics.catchUpOnEnd,
      adjustForZoom: dynamics.adjustForZoom
    }
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 解码 `brushPresetsJson` 的有界结果；非法结构返回 null。 */
export function decodeBrushPresetList(input: unknown): BrushPresetList | null {
  if (!isRecord(input) || !Array.isArray(input.presets)) return null;
  const name = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0 && value.length <= 255 && !value.includes("\0");
  const presets: BrushPresetSummary[] = [];
  const seen = new Set<string>();
  for (const raw of input.presets) {
    if (!isRecord(raw) || !name(raw.name) || seen.has(raw.name.toLowerCase())) return null;
    if (typeof raw.group !== "string" || raw.group.length > 255) return null;
    if (raw.origin !== "builtin" && raw.origin !== "user" && raw.origin !== "abr" && raw.origin !== "image") return null;
    if (typeof raw.sampled !== "boolean") return null;
    const folder = Array.isArray(raw.folder) ? raw.folder.filter((part): part is string => typeof part === "string") : [];
    seen.add(raw.name.toLowerCase());
    presets.push({ name: raw.name, group: raw.group, folder, origin: raw.origin, sampled: raw.sampled });
  }
  if (presets.length > 256) return null;
  const groups: { group: string; count: number }[] = [];
  if (Array.isArray(input.groups)) {
    for (const raw of input.groups) {
      if (isRecord(raw) && typeof raw.group === "string" && typeof raw.count === "number") {
        groups.push({ group: raw.group, count: raw.count });
      }
    }
  }
  return { presets, count: presets.length, groups };
}

/** ABR 预检报告（`inspectBrushAbr` 的结果）。 */
export type AbrReport = {
  group: string;
  supported: number;
  unsupported: string[];
  version: number;
  warnings: string[];
};

export function decodeAbrReport(input: unknown): AbrReport | null {
  if (!isRecord(input)) return null;
  if (typeof input.supported !== "number" || typeof input.version !== "number") return null;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return {
    group: typeof input.group === "string" ? input.group : "",
    supported: input.supported,
    unsupported: strings(input.unsupported),
    version: input.version,
    warnings: strings(input.warnings)
  };
}

export type BrushLibraryState = {
  list: BrushPresetList | null;
  /** 当前预设名（内核会话里的选择）；null 表示未从预设选择。 */
  current: string | null;
  busy: boolean;
  /** 库持久化状态：`unsaved` 表示本次会话成功但未落盘。 */
  persistence: "unknown" | "saved" | "unsaved" | "failed";
  message: string | null;
  report: AbrReport | null;
};

/**
 * 笔刷库控制器。
 *
 * 只调用公共内核方法与宿主存储端口；库内容与位图始终在内核里，React 只持有摘要。
 */
export class BrushLibraryController {
  private readonly handle: () => EditorHandle | null;
  private readonly storage: BrushLibraryStorage | null;
  private state: BrushLibraryState = {
    list: null,
    current: null,
    busy: false,
    persistence: "unknown",
    message: null,
    report: null
  };
  private readonly listeners = new Set<() => void>();
  private snapshotCache: BrushLibraryState | null = null;

  constructor(handle: () => EditorHandle | null, storage: BrushLibraryStorage | null = null) {
    this.handle = handle;
    this.storage = storage;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** `useSyncExternalStore` 要求未变化时返回同一引用。 */
  snapshot(): BrushLibraryState {
    this.snapshotCache ??= this.state;
    return this.snapshotCache;
  }

  private set(patch: Partial<BrushLibraryState>): void {
    this.state = { ...this.state, ...patch };
    this.snapshotCache = null;
    for (const listener of this.listeners) listener();
  }

  /** 重新读取库（打开文档、导入、删改之后）。 */
  refresh(current?: string | null): void {
    const handle = this.handle();
    if (!handle) {
      this.set({ list: null, current: null });
      return;
    }
    const result = handle.brushPresets(false);
    if (!result.ok) {
      this.set({ message: result.message });
      return;
    }
    const list = decodeBrushPresetList(result.value);
    if (!list) {
      this.set({ message: "笔刷库响应无效" });
      return;
    }
    this.set({ list, current: current === undefined ? this.state.current : current, message: null });
  }

  /** 选中预设；返回是否成功。 */
  select(name: string): boolean {
    const handle = this.handle();
    if (!handle) return false;
    const result = handle.selectBrushPreset(name);
    if (!result.ok) {
      this.set({ message: result.message });
      return false;
    }
    this.set({ current: name, message: null });
    return true;
  }

  /**
   * 读一条预设的完整笔刷设置（含动态），用于「选中后应用到工具」。
   *
   * 界面只消费公共字段；位图留在内核，不搬进 React 状态。
   */
  brushSettings(name: string): Record<string, unknown> | null {
    const handle = this.handle();
    if (!handle) return null;
    const result = handle.brushPreset(name);
    if (!result.ok) {
      this.set({ message: result.message });
      return null;
    }
    const value = result.value;
    if (!isRecord(value) || !isRecord(value.brush)) {
      this.set({ message: "预设内容无效" });
      return null;
    }
    return value.brush;
  }

  /** 保存／覆盖预设；成功后才推进「已落盘」状态，失败保留内存库。 */
  async save(input: {
    name: string;
    group?: string;
    folder?: string[];
    brush?: Record<string, unknown>;
    overwrite?: boolean;
  }): Promise<boolean> {
    const handle = this.handle();
    if (!handle) return false;
    if (this.state.busy) return false;
    const name = input.name.trim();
    if (!name) {
      this.set({ message: "预设名称不能为空" });
      return false;
    }
    if (!input.overwrite && this.state.list?.presets.some((preset) => preset.name.toLowerCase() === name.toLowerCase())) {
      this.set({ message: `已存在同名预设「${name}」` });
      return false;
    }
    this.set({ busy: true, message: null });
    try {
      const result = handle.saveBrushPreset({
        name,
        ...(input.group ? { group: input.group } : {}),
        ...(input.folder && input.folder.length ? { folder: input.folder } : {}),
        ...(input.brush ? { brush: input.brush } : {})
      });
      if (!result.ok) {
        this.set({ busy: false, message: result.message });
        return false;
      }
      this.refresh(name);
      await this.persist();
      this.set({ busy: false });
      return true;
    } finally {
      this.set({ busy: false });
    }
  }

  async rename(name: string, newName: string): Promise<boolean> {
    const handle = this.handle();
    if (!handle || this.state.busy) return false;
    const trimmed = newName.trim();
    if (!trimmed) {
      this.set({ message: "新名称不能为空" });
      return false;
    }
    this.set({ busy: true, message: null });
    try {
      const result = handle.renameBrushPreset(name, trimmed);
      if (!result.ok) {
        this.set({ busy: false, message: result.message });
        return false;
      }
      this.refresh(this.state.current === name ? trimmed : undefined);
      await this.persist();
      return true;
    } finally {
      this.set({ busy: false });
    }
  }

  async remove(name: string): Promise<boolean> {
    const handle = this.handle();
    if (!handle || this.state.busy) return false;
    this.set({ busy: true, message: null });
    try {
      const result = handle.deleteBrushPreset(name);
      if (!result.ok) {
        this.set({ busy: false, message: result.message });
        return false;
      }
      this.refresh(this.state.current === name ? null : undefined);
      await this.persist();
      return true;
    } finally {
      this.set({ busy: false });
    }
  }

  async move(name: string, group: string | undefined, folder?: string[]): Promise<boolean> {
    const handle = this.handle();
    if (!handle || this.state.busy) return false;
    this.set({ busy: true, message: null });
    try {
      const result = handle.moveBrushPreset({
        name,
        ...(group !== undefined ? { group } : {}),
        ...(folder !== undefined ? { folder } : {})
      });
      if (!result.ok) {
        this.set({ busy: false, message: result.message });
        return false;
      }
      this.refresh();
      await this.persist();
      return true;
    } finally {
      this.set({ busy: false });
    }
  }

  /** ABR 预检：只取报告，不发布。 */
  async inspectAbr(bytes: Uint8Array, group: string): Promise<AbrReport | null> {
    const handle = this.handle();
    if (!handle || this.state.busy) return null;
    this.set({ busy: true, message: null });
    try {
      const result = handle.inspectBrushAbr(bytes, group);
      if (!result.ok) {
        this.set({ busy: false, message: result.message, report: null });
        return null;
      }
      const report = decodeAbrReport(result.value);
      this.set({ busy: false, report, message: report ? null : "ABR 报告结构非法" });
      return report;
    } finally {
      this.set({ busy: false });
    }
  }

  /** 确认发布 ABR：`onlySupported` 为 false 且存在不支持项时内核整批拒绝。 */
  async commitAbr(onlySupported: boolean): Promise<boolean> {
    const handle = this.handle();
    if (!handle || this.state.busy) return false;
    this.set({ busy: true, message: null });
    try {
      const result = handle.commitBrushAbr({ onlySupported });
      if (!result.ok) {
        this.set({ busy: false, message: result.message });
        return false;
      }
      this.refresh();
      await this.persist();
      this.set({ report: null });
      return true;
    } finally {
      this.set({ busy: false });
    }
  }

  cancelAbr(): void {
    this.handle()?.cancelBrushAbr();
    this.set({ report: null });
  }

  /** 从图片字节定义采样笔尖。 */
  async importFromImage(name: string, bytes: Uint8Array, group?: string): Promise<boolean> {
    const handle = this.handle();
    if (!handle || this.state.busy) return false;
    this.set({ busy: true, message: null });
    try {
      const result = handle.importBrushFromImage(name, bytes, group ? { group } : {});
      if (!result.ok) {
        this.set({ busy: false, message: result.message });
        return false;
      }
      const selected = result.value && typeof result.value === "object" && typeof (result.value as { name?: unknown }).name === "string"
        ? String((result.value as { name: string }).name)
        : null;
      this.refresh(selected);
      await this.persist();
      return true;
    } finally {
      this.set({ busy: false });
    }
  }

  /** 笔刷设置面板的实时预览（不保存）。 */
  preview(brush: Record<string, unknown>, side = 128): EditorPreview | null {
    const handle = this.handle();
    if (!handle) return null;
    const result = handle.brushPreview({ brush: dynamicsPatch(dynamicsFromBrush(brush)), side });
    return result.ok ? result.value : null;
  }

  /** 预设缩略图与笔迹预览（按预设名，走库里保存的设置）。 */
  previewPreset(name: string, side = 64): EditorPreview | null {
    const handle = this.handle();
    if (!handle) return null;
    const result = handle.brushPreview({ name, side });
    return result.ok ? result.value : null;
  }

  /**
   * 落盘：把内核库快照交给宿主存储端口。
   *
   * 失败**不**回滚内存库（用户仍可继续使用并重试）；状态置 `failed` 并提示未持久化，
   * 绝不宣称已保存。
   */
  private async persist(): Promise<void> {
    const handle = this.handle();
    if (!this.storage || !handle) {
      this.set({ persistence: "unsaved" });
      return;
    }
    const snapshot = handle.brushLibrarySnapshot();
    if (!snapshot.ok) {
      this.set({ persistence: "failed", message: `笔刷库未保存：${snapshot.message}` });
      return;
    }
    const outcome = await this.storage.save(snapshot.value);
    if (outcome === "saved") {
      this.set({ persistence: "saved" });
    } else {
      this.set({
        persistence: "failed",
        message: "笔刷库未写入本机存储；当前会话仍可使用，重载后可能丢失"
      });
    }
  }

  /** 启动时恢复本机库；坏快照保留默认库并提示。 */
  async restore(): Promise<void> {
    const handle = this.handle();
    if (!handle || !this.storage) {
      this.refresh();
      return;
    }
    const bytes = await this.storage.load();
    let failure: string | null = null;
    if (bytes && bytes.length > 0) {
      const result = handle.restoreBrushLibrary(bytes);
      if (!result.ok) {
        failure = `本机笔刷库无法恢复，已使用默认库：${result.message}`;
      } else {
        this.set({ persistence: "saved" });
      }
    }
    this.refresh();
    // 恢复失败的提示不能被 `refresh` 的清空覆盖。
    if (failure) this.set({ message: failure });
  }

  /** 释放：只清引用，不删除已落盘的库。 */
  dispose(): void {
    this.listeners.clear();
  }
}

/** 库快照的宿主存储端口（IndexedDB / 宿主偏好存储）；失败返回 `"failed"`。 */
export type BrushLibraryStorage = {
  load(): Promise<Uint8Array | null>;
  save(bytes: Uint8Array): Promise<"saved" | "failed">;
};

/** 浏览器 IndexedDB 存储适配；键与旧版无冲突（新库首次引入）。 */
export function createIndexedDbBrushStorage(database = "woohaa.image-editor.brushes.v1"): BrushLibraryStorage {
  const KEY = "library";
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("当前环境不支持 IndexedDB"));
        return;
      }
      const request = indexedDB.open(database, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("library")) db.createObjectStore("library");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("打开笔刷库失败"));
    });
  let queue: Promise<unknown> = Promise.resolve();
  return {
    load: async () => {
      try {
        const db = await open();
        return await new Promise<Uint8Array | null>((resolve, reject) => {
          const transaction = db.transaction("library", "readonly");
          const request = transaction.objectStore("library").get(KEY);
          request.onsuccess = () => {
            const value: unknown = request.result;
            resolve(value instanceof Uint8Array ? value : null);
          };
          request.onerror = () => reject(request.error ?? new Error("读取笔刷库失败"));
          transaction.oncomplete = () => db.close();
        });
      } catch {
        return null;
      }
    },
    save: (bytes) => {
      // 串行队列：旧快照不覆盖新快照。
      const write = queue.then(
        () =>
          new Promise<"saved" | "failed">((resolve) => {
            void (async () => {
              try {
                const db = await open();
                const transaction = db.transaction("library", "readwrite");
                transaction.objectStore("library").put(bytes, KEY);
                transaction.oncomplete = () => {
                  db.close();
                  resolve("saved");
                };
                transaction.onerror = () => {
                  db.close();
                  resolve("failed");
                };
                transaction.onabort = () => {
                  db.close();
                  resolve("failed");
                };
              } catch {
                resolve("failed");
              }
            })();
          })
      );
      queue = write.catch(() => undefined);
      return write;
    }
  };
}

/**
 * React 侧的状态钩子。
 *
 * 控制器实例由调用方持有（工作区级），组件只订阅快照，避免每次渲染重建库。
 */
export function useBrushLibrary(controller: BrushLibraryController) {
  const [version, setVersion] = useState(0);
  useEffect(() => controller.subscribe(() => setVersion((value) => value + 1)), [controller]);
  const state = useMemo(() => controller.snapshot(), [controller, version]);
  const previewCache = useRef(new Map<string, EditorPreview | null>());
  const preview = useCallback(
    (name: string) => {
      if (!previewCache.current.has(name)) previewCache.current.set(name, name ? controller.previewPreset(name) : null);
      return previewCache.current.get(name) ?? null;
    },
    [controller]
  );
  useEffect(() => {
    previewCache.current.clear();
  }, [state.list]);
  return { state, preview };
}
