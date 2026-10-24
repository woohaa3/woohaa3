/**
 * 润饰类画笔的工具注册表。
 *
 * 这些工具在固定核心里是独立命令（`paint.*`）；本模块只把本机工具设置编译成对应命令参数。
 * 像素结果、选区遮罩、锁定与资源预算仍由内核执行。画笔尺寸/硬度/不透明度/流量按固定引擎
 * 注册表以百分比传入，不为界面复制一份像素算法。
 */
import {strokePoints, type DocumentPoint, type SelectionMode} from "./photo-editor-tools.js";

export type RetouchToolId =
  | "cloneStamp" | "healingBrush"
  | "colorReplacement" | "mixer" | "patternStamp" | "historyBrush"
  | "dodge" | "burn" | "sponge" | "blur" | "sharpen" | "smudge"
  | "spotHealing" | "redEye" | "magicEraser" | "backgroundEraser";

export type RetouchSettings = {
  size: number; hardness: number; opacity: number; flow: number;
  mode: string;
  sampling: "continuous" | "once" | "backgroundSwatch";
  limits: "contiguous" | "discontiguous" | "findEdges";
  tolerance: number;
  antiAlias: boolean;
  contiguous: boolean;
  sampleAllLayers: boolean;
  wet: number; load: number; mix: number; cleanAfterStroke: boolean; loadAfterStroke: boolean;
  pattern: string; aligned: boolean; impressionist: boolean; scale: number; angle: number;
  historyState: number | null;
  toneRange: "shadows" | "midtones" | "highlights";
  exposure: number;
  protectTones: boolean;
  saturate: boolean;
  strength: number;
  protectDetail: boolean;
  fingerPainting: boolean;
  healingType: "contentAware" | "createTexture" | "proximityMatch";
  pupilSize: number;
  darken: number;
  protectForegroundColor: boolean;
  /** 克隆类工具：取样图层与（Alt 取样后的）显式来源点或偏移。 */
  sampleLayer: "current" | "currentAndBelow" | "all";
  source: [number, number] | null;
  offset: [number, number] | null;
};

export const DEFAULT_RETOUCH: RetouchSettings = {
  size: 24, hardness: 80, opacity: 100, flow: 100,
  mode: "color", sampling: "continuous", limits: "contiguous", tolerance: 30, antiAlias: true,
  contiguous: true, sampleAllLayers: false,
  wet: 50, load: 50, mix: 50, cleanAfterStroke: true, loadAfterStroke: true,
  pattern: "", aligned: true, impressionist: false, scale: 100, angle: 0,
  historyState: null,
  toneRange: "midtones", exposure: 50, protectTones: true, saturate: false,
  strength: 50, protectDetail: true, fingerPainting: false,
  healingType: "contentAware",
  pupilSize: 50, darken: 50, protectForegroundColor: false,
  sampleLayer: "current", source: null, offset: null
};

const percent = (value: number) => Math.round(Math.min(100, Math.max(1, Number.isFinite(value) ? value : 1)));

type Spec = {
  command: string;
  label: string;
  point?: boolean;
  needsPattern?: boolean;
  params: (point: DocumentPoint, points: DocumentPoint[], settings: RetouchSettings, color: string) => Record<string, unknown> | null;
};

const stroke = (points: DocumentPoint[], settings: RetouchSettings) => ({
  points: strokePoints(points, true),
  size: Math.min(5000, Math.max(1, Math.round(settings.size))),
  hardness: percent(settings.hardness), opacity: percent(settings.opacity), flow: percent(settings.flow)
});

export const RETOUCH_SPECS: Record<RetouchToolId, Spec> = {
  cloneStamp: {
    command: "paint.cloneStamp", label: "仿制图章",
    /** 没有显式来源点时由内核使用「克隆源」面板的活动槽位。 */
    params: (_point, points, settings) => ({
      ...stroke(points, settings),
      aligned: settings.aligned, sampleLayer: settings.sampleLayer,
      ...(settings.source ? {source: settings.source} : settings.offset ? {offset: settings.offset} : {})
    })
  },
  healingBrush: {
    command: "paint.healingBrush", label: "修复画笔",
    params: (_point, points, settings) => ({
      ...stroke(points, settings),
      aligned: settings.aligned, sampleLayer: settings.sampleLayer,
      ...(settings.source ? {source: settings.source} : settings.offset ? {offset: settings.offset} : {})
    })
  },
  colorReplacement: {
    command: "paint.colorReplacement", label: "颜色替换画笔",
    params: (_point, points, settings, color) => ({
      ...stroke(points, settings),
      mode: settings.mode, sampling: settings.sampling, limits: settings.limits,
      tolerance: Math.round(Math.min(100, Math.max(0, settings.tolerance))),
      antiAlias: settings.antiAlias, color, target: "pixels"
    })
  },
  mixer: {
    command: "paint.mixerBrush", label: "混合画笔",
    params: (_point, points, settings, color) => ({
      ...stroke(points, settings),
      wet: percent(settings.wet), load: percent(settings.load), mix: percent(settings.mix),
      color, sampleAllLayers: settings.sampleAllLayers,
      cleanAfterStroke: settings.cleanAfterStroke, loadAfterStroke: settings.loadAfterStroke
    })
  },
  patternStamp: {
    command: "paint.patternStamp", label: "图案图章", needsPattern: true,
    params: (_point, points, settings) => settings.pattern ? ({
      ...stroke(points, settings),
      pattern: settings.pattern, scale: Math.min(1000, Math.max(1, Math.round(settings.scale))),
      angle: settings.angle, aligned: settings.aligned, impressionist: settings.impressionist
    }) : null
  },
  historyBrush: {
    command: "paint.historyBrush", label: "历史记录画笔",
    params: (_point, points, settings) => ({
      ...stroke(points, settings),
      ...(settings.historyState === null ? {} : {state: settings.historyState})
    })
  },
  dodge: {
    command: "paint.dodge", label: "减淡工具",
    params: (_point, points, settings) => ({
      ...stroke(points, settings),
      range: settings.toneRange, exposure: percent(settings.exposure), protectTones: settings.protectTones,
      sampleAllLayers: settings.sampleAllLayers
    })
  },
  burn: {
    command: "paint.burn", label: "加深工具",
    params: (_point, points, settings) => ({
      ...stroke(points, settings),
      range: settings.toneRange, exposure: percent(settings.exposure), protectTones: settings.protectTones,
      sampleAllLayers: settings.sampleAllLayers
    })
  },
  sponge: {
    command: "paint.sponge", label: "海绵工具",
    params: (_point, points, settings) => ({
      ...stroke(points, settings),
      mode: settings.saturate ? "saturate" : "desaturate", vibrance: settings.saturate,
      sampleAllLayers: settings.sampleAllLayers
    })
  },
  blur: {
    command: "paint.blur", label: "模糊工具",
    params: (_point, points, settings) => ({
      ...stroke(points, settings),
      strength: percent(settings.strength), sampleAllLayers: settings.sampleAllLayers
    })
  },
  sharpen: {
    command: "paint.sharpen", label: "锐化工具",
    params: (_point, points, settings) => ({
      ...stroke(points, settings),
      strength: percent(settings.strength), protectDetail: settings.protectDetail,
      sampleAllLayers: settings.sampleAllLayers
    })
  },
  smudge: {
    command: "paint.smudge", label: "涂抹工具",
    params: (_point, points, settings, color) => ({
      ...stroke(points, settings),
      strength: percent(settings.strength), fingerPainting: settings.fingerPainting,
      color, sampleAllLayers: settings.sampleAllLayers
    })
  },
  spotHealing: {
    command: "paint.spotHealing", label: "污点修复画笔",
    params: (_point, points, settings) => ({
      ...stroke(points, settings),
      type: settings.healingType, sampleAllLayers: settings.sampleAllLayers
    })
  },
  redEye: {
    command: "paint.redEye", label: "红眼工具", point: true,
    params: (point, _points, settings) => ({
      x: Math.round(point.x), y: Math.round(point.y),
      pupilSize: percent(settings.pupilSize), darken: Math.round(Math.min(100, Math.max(0, settings.darken)))
    })
  },
  magicEraser: {
    command: "paint.magicEraser", label: "魔术橡皮擦", point: true,
    params: (point, _points, settings) => ({
      x: Math.round(point.x), y: Math.round(point.y),
      tolerance: Math.round(Math.min(255, Math.max(0, settings.tolerance))),
      antiAlias: settings.antiAlias, contiguous: settings.contiguous,
      sampleAllLayers: settings.sampleAllLayers, opacity: percent(settings.opacity)
    })
  },
  backgroundEraser: {
    command: "paint.backgroundEraser", label: "背景橡皮擦",
    params: (_point, points, settings) => ({
      ...stroke(points, settings),
      sampling: settings.sampling, limits: settings.limits,
      tolerance: Math.round(Math.min(100, Math.max(0, settings.tolerance))),
      protectForegroundColor: settings.protectForegroundColor
    })
  }
};

export function retouchToolIds(): RetouchToolId[] { return Object.keys(RETOUCH_SPECS) as RetouchToolId[]; }

/** 编译笔画命令；返回 `null` 表示参数不完整（调用方不得提交半截操作）。 */
export function buildRetouch(tool: RetouchToolId, point: DocumentPoint, points: readonly DocumentPoint[], settings: RetouchSettings, color: string, _target: "pixels"|"mask", _zoom: number, _mode?: SelectionMode): Record<string, unknown> | null {
  const spec = RETOUCH_SPECS[tool];
  const usable = spec.point ? [point] : points.length ? [...points] : [point];
  if (!usable.every(candidate => Number.isFinite(candidate.x) && Number.isFinite(candidate.y))) return null;
  return spec.params(point, usable, settings, color);
}

/** 单点工具在按下时立即提交；其余在释放时提交整条路径。 */
export function retouchSpec(tool: RetouchToolId): Spec { return RETOUCH_SPECS[tool]; }
/** 引擎当前只为 Clone Stamp / History Brush 提供实时笔画；本产品首批润饰工具在释放时一次提交。 */
export function supportsLivePreview(tool: RetouchToolId): boolean { return tool === "historyBrush"; }
