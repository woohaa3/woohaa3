/**
 * 填充层与图层工作流的**声明侧**参数契约（U57–U64）。
 *
 * 这里只声明「面板能产生什么参数」以及逐字段的界限，不重新实现内核算法：真正的写入、
 * 参数解析、预算与拒绝原因仍由固定 Rust 内核（`features/layers/layer_fill.rs` /
 * `layer_workflows.rs` / `layer_filter_domain.rs`）决定。两层都校验是有意的：
 * 内核是唯一写入口，协议层让宿主在**发出命令前**就能拒绝明显越界/未知的输入，
 * 并在 UI 上给出同一份界限数字。
 *
 * 只导出纯数据与纯函数，零宿主依赖。
 */

/** 填充层种类（与 `Fill` 的序列化分支一一对应）。 */
export const LAYER_FILL_KINDS = ["solid", "gradient", "pattern"] as const;
export type LayerFillKind = (typeof LAYER_FILL_KINDS)[number];

/** 填充层逐项界限（与内核 `layer_fill.rs` / `fill_support.rs` 同一组数字）。 */
export const LAYER_FILL_LIMITS = {
  /** 渐变端点数（含透明度端点）。 */
  maxGradientStops: 1024,
  minGradientStops: 2,
  /** 渐变缩放是百分比；内核按 `0.1..=1.5` 的比例存盘。 */
  minGradientScale: 10,
  maxGradientScale: 150,
  /** 图案缩放同样是百分比：内核按 `0.01..=10` 的比例存盘。 */
  minPatternScalePercent: 1,
  maxPatternScalePercent: 1000,
  /** 图案旋转角度（度）。 */
  maxPatternAngle: 360,
  /** 图层颜色的可选值（与 `LabelColor::from_id` 一致）。 */
  labelColors: [
    "none", "red", "orange", "yellow", "green", "seafoam", "blue",
    "indigo", "magenta", "fuchsia", "violet", "gray",
  ],
} as const;

export type LayerLabelColor = (typeof LAYER_FILL_LIMITS.labelColors)[number];

/** 高级混合的挖空取值。 */
export const LAYER_KNOCKOUTS = ["none", "shallow", "deep"] as const;
export type LayerKnockout = (typeof LAYER_KNOCKOUTS)[number];

/** 一个 Blend If 端点区间：未分离两端点，或分离的四端点。 */
export type BlendIfRange = readonly [number, number] | readonly [number, number, number, number];

/** 一条 Blend If 规则；`channel` 是通道名或通道序号。 */
export type BlendIfEntry = {
  channel: string | number;
  thisLayer?: BlendIfRange | null;
  underlying?: BlendIfRange | null;
};

/** 图层复合数量上限（与内核 `MAX_LAYER_COMPS` 一致）。 */
export const MAX_LAYER_COMPS = 64;

/** 输入是否落在 `[min, max]` 的有限数。 */
function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/** `0..255` 的 Blend If 端点：2 或 4 项且单调不减。 */
export function isBlendIfRange(value: unknown): value is BlendIfRange {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 4)) return false;
  if (!value.every((point) => inRange(point, 0, 255))) return false;
  for (let index = 1; index < value.length; index += 1) {
    if ((value[index] as number) < (value[index - 1] as number)) return false;
  }
  return true;
}

/**
 * Blend If 列表的结构检查。
 *
 * 通道**是否存在**由内核按当前颜色模式判定（GB 文档没有青色通道），这里只拒绝明显的
 * 结构错误：非对象项、未知字段、缺通道、端点越界或交叉。
 */
export function isBlendIfList(value: unknown): value is BlendIfEntry[] {
  if (value === null || value === undefined) return true;
  const list = Array.isArray(value) ? value : [value];
  if (list.length > 8) return false;
  return list.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).some((key) => !["channel", "thisLayer", "underlying"].includes(key))) return false;
    const channel = item.channel;
    if (!(typeof channel === "string" ? channel.trim().length > 0 && channel.length <= 40 : inRange(channel, 0, 16))) return false;
    return ["thisLayer", "underlying"].every((key) => item[key] == null || isBlendIfRange(item[key]));
  });
}

/** 渐变端点 `[位置, 颜色]`：位置单调不减、有颜色值。 */
export function isGradientStops(value: unknown): value is Array<readonly [number, unknown]> {
  if (!Array.isArray(value)) return false;
  if (value.length < LAYER_FILL_LIMITS.minGradientStops || value.length > LAYER_FILL_LIMITS.maxGradientStops) return false;
  let previous = -1;
  return value.every((stop) => {
    if (!Array.isArray(stop) || stop.length !== 2) return false;
    const at = stop[0];
    if (!inRange(at, 0, 1) || at < previous) return false;
    previous = at;
    return stop[1] !== null && stop[1] !== undefined;
  });
}

/**
 * 填充参数的面板规则。
 *
 * 返回 `null` 表示可以发往内核；返回字符串是给人看的具体原因（面板直接显示）。
 * 这里不判断图案/预设**是否存在**——那是工程资源，只有内核知道。
 */
export function layerFillParamError(kind: LayerFillKind, params: unknown): string | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return "填充参数必须为对象";
  const fields = params as Record<string, unknown>;
  if (kind === "solid") {
    const color = fields.color;
    if (typeof color !== "string" || !/^#[0-9a-f]{3,8}$/i.test(color.trim())) return "纯色填充需要 #rrggbb 形式的颜色";
    return null;
  }
  if (kind === "gradient") {
    if (fields.stops !== undefined && !isGradientStops(fields.stops)) {
      return `渐变端点需要 ${LAYER_FILL_LIMITS.minGradientStops}–${LAYER_FILL_LIMITS.maxGradientStops} 项，位置在 0–1 且递增`;
    }
    if (fields.transparency !== undefined) {
      const transparency = fields.transparency;
      // 与内核/上游同单位：透明度端点是**百分比 0–100**（上游 `transparency_param` 除以 100 存盘）。
      if (!Array.isArray(transparency) || transparency.length > LAYER_FILL_LIMITS.maxGradientStops
        || !transparency.every((stop) => Array.isArray(stop) && stop.length === 2 && inRange(stop[0], 0, 1) && inRange(stop[1], 0, 100))) {
        return "透明度端点需要 [位置, 0–100 透明度]";
      }
    }
    if (fields.scale !== undefined && !inRange(fields.scale, LAYER_FILL_LIMITS.minGradientScale, LAYER_FILL_LIMITS.maxGradientScale)) {
      return `渐变缩放必须是 ${LAYER_FILL_LIMITS.minGradientScale}–${LAYER_FILL_LIMITS.maxGradientScale} 的百分比`;
    }
    return null;
  }
  if (typeof fields.pattern !== "string" || !fields.pattern.trim()) return "图案填充需要选择图案";
  if (fields.scale !== undefined && !inRange(fields.scale, LAYER_FILL_LIMITS.minPatternScalePercent, LAYER_FILL_LIMITS.maxPatternScalePercent)) {
    return `图案缩放必须是 ${LAYER_FILL_LIMITS.minPatternScalePercent}–${LAYER_FILL_LIMITS.maxPatternScalePercent} 的百分比`;
  }
  if (fields.angle !== undefined && !inRange(fields.angle, -LAYER_FILL_LIMITS.maxPatternAngle, LAYER_FILL_LIMITS.maxPatternAngle)) {
    return `图案旋转必须在 ±${LAYER_FILL_LIMITS.maxPatternAngle}° 内`;
  }
  return null;
}

/** 面板参数 → 内核参数：去掉面板路由标记 `fillKind`，其余原样透传。 */
export function layerFillCommandParams(kind: LayerFillKind, params: Record<string, unknown>): Record<string, unknown> {
  const { fillKind: _routing, ...rest } = params;
  void _routing;
  void kind;
  return rest;
}

/** 高级混合（U60）的面板规则；返回 `null` 表示可发往内核。 */
export function blendingParamError(params: unknown): string | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return "混合参数必须为对象";
  const fields = params as Record<string, unknown>;
  if (fields.knockout !== undefined && fields.knockout !== null) {
    if (!(LAYER_KNOCKOUTS as readonly unknown[]).includes(fields.knockout)) return "挖空只接受 none、shallow 或 deep";
  }
  for (const key of ["blendInteriorEffectsAsGroup", "blendClippedLayersAsGroup", "transparencyShapesLayer", "layerMaskHidesEffects", "vectorMaskHidesEffects"]) {
    if (fields[key] != null && typeof fields[key] !== "boolean") return `${key} 必须是布尔值`;
  }
  if (fields.channels !== undefined && fields.channels !== null) {
    if (!Array.isArray(fields.channels) || !fields.channels.every((value) => typeof value === "boolean")) {
      return "channels 必须是逐颜色通道的布尔列表";
    }
  }
  if (fields.blendIf !== undefined && !isBlendIfList(fields.blendIf)) {
    return "Blend If 需要通道与 0–255 的端点（分离端点不能交叉）";
  }
  return null;
}

/** 去边/净化（U62）的面板规则。 */
export function mattingParamError(id: string, params: unknown): string | null {
  const fields = (params ?? {}) as Record<string, unknown>;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return "参数必须为对象";
  if (id === "layer.matting.defringe" && fields.width !== undefined && !inRange(fields.width, 1, 200)) return "去边宽度必须是 1–200 像素";
  if (id === "layer.matting.colorDecontaminate") {
    if (fields.amount !== undefined && !inRange(fields.amount, 0, 100)) return "净化强度必须是 0–100";
    if (fields.radius !== undefined && !inRange(fields.radius, 1, 100)) return "净化半径必须是 1–100";
  }
  return null;
}

/** 图层复合（U64）的面板规则：名称与选项都是可保存内容。 */
export function layerCompParamError(id: string, params: unknown): string | null {
  const fields = (params ?? {}) as Record<string, unknown>;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return "参数必须为对象";
  for (const key of ["visibility", "position", "appearance"]) {
    if (fields[key] != null && typeof fields[key] !== "boolean") return `${key} 必须是布尔值`;
  }
  if ((id === "layerComp.new" || id === "layerComp.rename" || id === "layerComp.setOptions") && fields.name !== undefined) {
    const name = fields.name;
    if (typeof name !== "string" || !name.trim() || name.length > 200) return "复合名称必须为 1–200 个字符";
  }
  return null;
}

/** 图层过滤（U63）的面板规则：组合条件是交集，未知值不做静默降级。 */
export function layerFilterParamError(params: unknown): string | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return "过滤参数必须为对象";
  const fields = params as Record<string, unknown>;
  if (fields.by !== undefined && fields.by !== null && !["kind", "name", "mode"].includes(String(fields.by))) return "主条件只接受 kind、name 或 mode";
  if (fields.name !== undefined && fields.name !== null && (typeof fields.name !== "string" || fields.name.length > 200)) return "名称必须是 200 字符以内的字符串";
  if (fields.kinds !== undefined && fields.kinds !== null) {
    if (!Array.isArray(fields.kinds)) return "种类必须是数组";
    const kinds = ["raster", "adjustment", "text", "shape", "smart", "group"];
    if (!fields.kinds.every((kind) => typeof kind === "string" && kinds.includes(kind))) return `种类只接受 ${kinds.join("、")}`;
  }
  if (fields.mode !== undefined && fields.mode !== null && (typeof fields.mode !== "string" || !fields.mode.trim())) return "混合模式必须是非空名称";
  if (fields.onlySelected != null && typeof fields.onlySelected !== "boolean") return "只显示选中层必须是布尔值";
  return null;
}

/** 过滤条件是否在生效（未生效时面板显示全部行）。 */
export function layerFilterActive(params: unknown): boolean {
  if (!params || typeof params !== "object") return false;
  const fields = params as Record<string, unknown>;
  return fields.by === "mode"
    || (typeof fields.name === "string" && fields.name.trim().length > 0)
    || (Array.isArray(fields.kinds) && fields.kinds.length > 0)
    || fields.onlySelected === true;
}

/** 面板展示用的组合条件说明（与内核语义逐条对应）。 */
export const LAYER_FILTER_COMBINATION_NOTE =
  "主条件（种类 / 名称 / 混合模式）与名称、种类同时生效；勾选「只显示选中层」再取交集，选中层的父组始终显示。过滤只改变列表，不改内容、选择或合成。";

/** 样式预设管理的动作（U61）：只有这些动作会被发往内核。 */
export const STYLE_PRESET_ACTIONS = ["rename", "delete", "move", "newGroup", "renameGroup", "deleteGroup"] as const;
export type StylePresetAction = (typeof STYLE_PRESET_ACTIONS)[number];

/**
 * 可设默认值的图层效果种类（U61）。
 *
 * 与内核 `layer_style::effect_from_params` 认识的种类一一对应；面板用它生成「效果默认值」
 * 的下拉，避免用户拼一个内核不认识的名字后只拿到「未知效果种类」。
 */
export const LAYER_EFFECT_KINDS = [
  { id: "dropShadow", label: "投影" },
  { id: "innerShadow", label: "内阴影" },
  { id: "outerGlow", label: "外发光" },
  { id: "innerGlow", label: "内发光" },
  { id: "stroke", label: "描边" },
  { id: "colorOverlay", label: "颜色叠加" },
  { id: "gradientOverlay", label: "渐变叠加" },
  { id: "patternOverlay", label: "图案叠加" },
  { id: "satin", label: "光泽" },
  { id: "bevelEmboss", label: "斜面和浮雕" },
] as const;

/**
 * 样式预设管理（U61）的面板规则。
 *
 * 预设属于会话偏好：这些命令不写文档，因此规则只检查**参数形状**，不判断文档状态
 * （「没有这个预设」由内核按真实会话库回答，面板原样显示）。
 */
export function layerStylePresetParamError(id: string, params: unknown): string | null {
  if (!/^(style\.presets\.(list|new|edit|reset)|layer\.layerStyle\.(defaultFor|makeDefault))$/.test(id)) return `不是样式预设命令：${id}`;
  const fields = (params ?? {}) as Record<string, unknown>;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return "参数必须为对象";
  if (id === "layer.layerStyle.defaultFor" || id === "layer.layerStyle.makeDefault") {
    const allowed = id === "layer.layerStyle.makeDefault" ? ["kind", "params"] : ["kind"];
    const unknown = Object.keys(fields).filter((key) => !allowed.includes(key));
    if (unknown.length) return `样式默认不接受 ${unknown.join("、")}`;
    if (typeof fields.kind !== "string" || !fields.kind.trim()) return "kind 必须是效果种类";
    if (id === "layer.layerStyle.makeDefault" && (!fields.params || typeof fields.params !== "object" || Array.isArray(fields.params))) {
      return "params 必须是参数对象";
    }
    return null;
  }
  if (id === "style.presets.list") {
    const unknown = Object.keys(fields);
    return unknown.length === 0 ? null : `列出预设不接受参数：${unknown.join("、")}`;
  }
  if (id === "style.presets.reset") {
    const unknown = Object.keys(fields).filter((key) => key !== "append");
    if (unknown.length) return `恢复默认不接受 ${unknown.join("、")}`;
    return fields.append != null && typeof fields.append !== "boolean" ? "append 必须是布尔值" : null;
  }
  if (id === "style.presets.new") {
    const allowed = ["name", "group", "layer", "includeEffects", "includeBlending", "effects", "blend", "fillOpacity"];
    const unknown = Object.keys(fields).filter((key) => !allowed.includes(key));
    if (unknown.length) return `保存预设不接受 ${unknown.join("、")}`;
    if (fields.includeEffects === false && fields.includeBlending === false) return "至少要包含图层效果或混合选项之一";
    if (fields.name !== undefined) {
      const name = fields.name;
      if (typeof name !== "string" || !name.trim() || name.length > 200) return "预设名称必须为 1–200 个字符";
    }
    if (fields.effects !== undefined && !Array.isArray(fields.effects)) return "effects 必须是 [[kind, params], …]";
    if (fields.layer !== undefined && (!Number.isInteger(fields.layer) || (fields.layer as number) < 0)) return "图层 id 必须为非负整数";
    return null;
  }
  // style.presets.edit
  const allowed = ["action", "preset", "group", "name", "to", "index"];
  const unknown = Object.keys(fields).filter((key) => !allowed.includes(key));
  if (unknown.length) return `整理预设不接受 ${unknown.join("、")}`;
  const action = fields.action;
  if (typeof action !== "string" || !(STYLE_PRESET_ACTIONS as readonly string[]).includes(action)) {
    return `action 只接受 ${STYLE_PRESET_ACTIONS.join("、")}`;
  }
  if (action === "newGroup" || action === "renameGroup" || action === "deleteGroup") {
    if (action !== "newGroup" && (typeof fields.group !== "string" || !fields.group.trim())) return "group 必须是组名";
    if (action === "renameGroup" && (typeof fields.name !== "string" || !fields.name.trim())) return "组的新名称不能为空";
    return null;
  }
  const preset = fields.preset;
  if (action === "delete") {
    const names = Array.isArray(preset) ? preset : [preset];
    if (!names.length || !names.every((name) => typeof name === "string" && name.trim())) return "preset 必须是名称或非空名称列表";
  } else if (typeof preset !== "string" || !preset.trim()) {
    return "preset 必须是非空名称";
  }
  if (action === "rename" && (typeof fields.name !== "string" || !fields.name.trim())) return "新名称不能为空";
  if (action === "move" && (typeof fields.to !== "string" || !fields.to.trim())) return "to 必须是目标组名";
  if (fields.index !== undefined && (!Number.isInteger(fields.index) || (fields.index as number) < 0)) return "index 必须是非负整数";
  return null;
}
