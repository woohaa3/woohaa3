import { PaintingControlsContext, usePaintingSetting } from "./controls-context.js";
/**
 * 绘画、笔刷动态与颜色的域内面板
 * （change: 2026-10-22-add-photocraft-painting-color-workflows，U27–U36）。
 *
 * 分工：
 *
 * - **内核**执行命令并持有色板/渐变/工具预设库与像素结果；
 * - **本模块**只做参数编辑、命令编排与失败提示，不复制库内容、不自己算像素；
 * - **面板不写共享文件**：所有内核调用经 `controller.features.painting`（域会话），
 *   像素命令走 `paintCommand`（过草稿门 + `afterWrite`），偏好命令走 `preferenceCommand`
 *   （不制造文档 dirty）。
 *
 * 与「画布手势」的边界：铅笔/颜色替换/背景橡皮是笔迹工具，必须由画布拖动画出；共享
 * `photo-editor-app.tsx`/`photo-editor-canvas.tsx` 的手势分发与工具白名单由集成负责人维护，
 * 本域不并改。因此面板对这些工具提供完整参数与明确的「需画布落笔」提示，而渐变、油漆桶、
 * 魔术橡皮、吸管、对称、色板与预设这些**非拖动**入口在此可直接提交真实命令。
 */
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import type { FeaturePanelContext } from "../panel-context.js";
import { Button } from "../../ui/Button.js";
import { isRecord } from "../shared/panels.js";
import type { PaintingSession } from "./workspace.js";
import {
  DEFAULT_BACKGROUND_ERASER,
  DEFAULT_BUCKET,
  DEFAULT_COLOR_REPLACEMENT,
  DEFAULT_EYEDROPPER,
  DEFAULT_GRADIENT,
  DEFAULT_MAGIC_ERASER,
  DEFAULT_PENCIL,
  ERASER_LIMITS,
  ERASER_SAMPLINGS,
  COLOR_REPLACEMENT_MODES,
  GRADIENT_STYLES,
  GRADIENT_METHODS,
  PAINT_BLEND_MODES,
  SAMPLE_LAYERS,
  SAMPLE_SIZES,
  SYMMETRY_MODES,
  buildBackgroundEraser,
  buildBucket,
  buildColorReplacement,
  buildGradient,
  buildMagicEraser,
  buildPencil,
  buildSampleColor,
  buildSymmetry,
  buildSymmetryDisable,
  buildSymmetryFromPath,
  decodeSampledColor,
  decodeSymmetryState,
  type BackgroundEraserSettings,
  type ColorReplacementSettings,
  type ColorReplacementMode,
  type GradientOpacityStop,
  type GradientSettings,
  type GradientStop,
  type PaintBlendMode,
  type SampleSize,
  type SampleLayers,
  type SymmetryMode,
} from "./tool-modes.js";
import { SYMMETRY_LABELS, normalizeSymmetry } from "./tool-settings-state.js";
import type { SymmetrySettings } from "./tool-modes.js";
import {
  buildToolPreset,
  buildToolPresetEdit,
  decodeGradientLibrary,
  decodeSwatchLibrary,
  decodeToolPresets,
  filterToolPresets,
  gradientPresetStops,
  type GradientLibrary,
  type SwatchLibrary,
  type ToolPresetList,
} from "./preset-state.js";

/** 取本域会话；宿主未提供绘画接口时返回 null（面板不渲染）。 */
export function paintingSession(controller: EditorWorkspaceController): PaintingSession | null {
  const features = (controller as unknown as { features?: { painting?: PaintingSession } }).features;
  return features?.painting ?? null;
}

/** 统一的失败提示。 */
function Failure({ text }: { text: string | null }) {
  return text ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{text}</p> : null;
}

/** 受限数字输入（非法输入不写状态，避免「看起来改了」）。 */
function NumberField({ label, value, min, max, step = 1, disabled, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; disabled?: boolean; onChange: (value: number) => void;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </label>
  );
}

// ---------------------------------------------------------------- 绘图工具参数（U27/U28/U29/U34）

const TOOL_LABELS = {
  pencil: "铅笔",
  colorReplacement: "颜色替换",
  gradient: "渐变",
  bucket: "油漆桶",
  backgroundEraser: "背景橡皮擦",
  magicEraser: "魔术橡皮擦",
  eyedropper: "吸管",
} as const;
type PanelTool = keyof typeof TOOL_LABELS;
const PANEL_TOOLS = Object.keys(TOOL_LABELS) as PanelTool[];

/**
 * 绘图工具参数面板。
 *
 * 每个工具记住自己的设置（`defaultPaintingToolSettings`），切换工具不互相污染；非拖动工具
 * 提供直接提交真实命令的入口（渐变端点、油漆桶/魔术橡皮坐标、吸管坐标），拖动工具只给参数
 * 并说明落笔位置由画布手势提供。
 */
export function PaintingToolOptionsPanel({ controller, locked, colors, width, height, gradientPreset, onColor }: {
  controller: EditorWorkspaceController;
  locked: boolean;
  colors: { foreground: string };
  width: number;
  height: number;
  /**
   * 可写颜色端口（任务 3.4）：宿主提供时吸管结果才真的写回共享前景/背景色。
   *
   * 未提供时面板如实降级为「只报告色值」，不渲染一个点了不生效的按钮。
   */
  onColor?: (color: string, target?: "foreground" | "background") => void;
  /**
   * 在「渐变预设」里选中的色标。预设只提供色标，套用与否由用户点按决定：
   * 静默覆盖会把用户正在调的端点/透明度冲掉。
   */
  gradientPreset?: { name: string; stops: GradientStop[]; transparency: GradientOpacityStop[] } | null;
}) {
  const session = paintingSession(controller);
  const controls = useContext(PaintingControlsContext);
  const [localTool, setLocalTool] = useState<PanelTool>("pencil");
  const tool = controls && PANEL_TOOLS.includes(controls.tool as PanelTool) ? controls.tool as PanelTool : localTool;
  const setTool = (next: PanelTool) => { setLocalTool(next); controls?.choose(next); };
  const [pencil, setPencil] = usePaintingSetting("pencil", DEFAULT_PENCIL);
  const [pencilMode, setPencilMode] = usePaintingSetting("blendMode", "normal");
  // 颜色替换有自己的笔头尺寸（沿用默认 30 px 作为初始值），不再借用背景橡皮的状态。
  const [replacement, setReplacement] = usePaintingSetting("colorReplacement", { ...DEFAULT_COLOR_REPLACEMENT, size: DEFAULT_BACKGROUND_ERASER.size });
  const [gradient, setGradient] = usePaintingSetting("gradient", DEFAULT_GRADIENT);
  const [gradientFrom, setGradientFrom] = useState({ x: 0, y: Math.round(height / 2) });
  const [gradientTo, setGradientTo] = useState({ x: Math.round(width), y: Math.round(height / 2) });
  const [bucket, setBucket] = usePaintingSetting("bucket", DEFAULT_BUCKET);
  const [bucketAt, setBucketAt] = useState({ x: Math.round(width / 2), y: Math.round(height / 2) });
  const [backgroundEraser, setBackgroundEraser] = usePaintingSetting("backgroundEraser", DEFAULT_BACKGROUND_ERASER);
  const [magicEraser, setMagicEraser] = usePaintingSetting("magicEraser", DEFAULT_MAGIC_ERASER);
  const [eyedropper, setEyedropper] = usePaintingSetting("eyedropper", DEFAULT_EYEDROPPER);
  const [sampleAt, setSampleAt] = useState({ x: Math.round(width / 2), y: Math.round(height / 2) });
  const [sampled, setSampled] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  if (!session) return null;

  const run = (id: string, params: unknown) => {
    const result = session.paintCommand(id, params);
    setError(result.ok ? null : result.message);
    if (result.ok) setNote("已提交一次可撤销的绘画操作");
    return result.ok;
  };

  const commitGradient = () => {
    const params = buildGradient(gradientFrom, gradientTo, gradient);
    if (!params) { setError("渐变端点或色标无效：端点不能重合，色标必须按位置递增且颜色合法"); return; }
    run("paint.gradient", params);
  };

  // 预设 → 当前渐变色标。只换色标，端点/类型/不透明度保持用户设置。
  const applyPreset = () => {
    if (!gradientPreset) return;
    setGradient((value) => ({
      ...value,
      stops: gradientPreset.stops.map((stop) => ({ ...stop })),
      transparency: gradientPreset.transparency.map((stop) => ({ ...stop }))
    }));
    setError(null);
    setNote(`已套用预设「${gradientPreset.name}」的色标`);
  };

  const commitBucket = (pattern: boolean) => {
    const params = pattern
      ? { ...buildBucket(bucketAt, colors.foreground, bucket), contents: "pattern" }
      : buildBucket(bucketAt, colors.foreground, bucket);
    if (!params) { setError("油漆桶坐标、容差或不透明度无效"); return; }
    run("paint.bucket", params);
  };

  const commitMagicEraser = () => {
    const params = buildMagicEraser(bucketAt, magicEraser);
    if (!params) { setError("魔术橡皮坐标、容差或不透明度无效"); return; }
    run("paint.magicEraser", params);
  };

  const sample = () => {
    const params = buildSampleColor(sampleAt, eyedropper);
    if (!params) { setError("采样坐标或采样尺寸无效"); return; }
    const result = session.sampleColorOptions(params);
    if (!result.ok) { setError(result.message); setSampled(null); return; }
    const color = decodeSampledColor(result.value);
    setError(null);
    setSampled(color === undefined ? "采样结果结构非法" : color === null ? "该点没有有效颜色（图外或透明）" : `${color.hex} · 不透明度 ${Math.round(color.alpha * 100)}%`);
    // 宿主提供可写颜色端口时，取样结果直接落到目标色板（与画布吸管同一条路径）。
    if (onColor && color) onColor(color.hex, eyedropper.target);
  };

  // 拖动类工具的参数预览：面板只编译参数，明确显示「能不能提交」。
  // 铅笔颜色跟随当前前景色（`PencilSettings.color` 只作为兜底默认），与油漆桶/颜色替换一致；
  // 否则用户改了前景色，铅笔仍然用写死的黑色落笔。
  const pencilSettings = { ...pencil, color: colors.foreground };
  const pencilParams = buildPencil([{ x: 0, y: 0 }], pencilSettings, { mode: pencilMode });
  const replacementParams = buildColorReplacement([{ x: 0, y: 0 }], replacement, { size: replacement.size ?? DEFAULT_BACKGROUND_ERASER.size, color: colors.foreground });
  const backgroundParams = buildBackgroundEraser([{ x: 0, y: 0 }], backgroundEraser);

  return (
    <section className="photo-editor__advanced-group" aria-label="绘图工具参数" data-painting-tools={tool}>
      <span className="photo-editor__options-title">绘图工具</span>
      <label>
        工具
        <select value={tool} disabled={locked} onChange={(event) => { setTool(event.currentTarget.value as PanelTool); setError(null); setNote(null); }}>
          {PANEL_TOOLS.map((id) => <option key={id} value={id}>{TOOL_LABELS[id]}</option>)}
        </select>
      </label>

      {tool === "pencil" ? <>
        <NumberField label="尺寸（源像素）" value={pencil.size} min={1} max={512} disabled={locked} onChange={(size) => setPencil((value) => ({ ...value, size }))} />
        <label className="photo-editor__brush-check">
          <input type="checkbox" checked={pencil.autoErase} disabled={locked} onChange={(event) => setPencil((value) => ({ ...value, autoErase: event.currentTarget.checked }))} />自动擦除（在底色上画背景色）
        </label>
        <label>
          混合模式
          <select value={pencilMode} disabled={locked} onChange={(event) => setPencilMode(event.currentTarget.value as PaintBlendMode)}>
            {PAINT_BLEND_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
          </select>
        </label>
        <p className="photo-editor__brush-note">
          {pencilParams ? "硬边笔尖（硬度 100%、无软边与流量）。在画布上拖动落笔。" : "尺寸非法：铅笔不会提交。"}
        </p>
      </> : null}

      {tool === "colorReplacement" ? <>
        <label>
          匹配
          <select value={replacement.mode} disabled={locked} onChange={(event) => setReplacement((value) => ({ ...value, mode: event.currentTarget.value as ColorReplacementMode }))}>
            {COLOR_REPLACEMENT_MODES.map((mode) => <option key={mode} value={mode}>{mode === "hue" ? "色相" : mode === "saturation" ? "饱和度" : mode === "color" ? "颜色" : "明度"}</option>)}
          </select>
        </label>
        <NumberField label="容差" value={replacement.tolerance} min={0} max={100} disabled={locked} onChange={(tolerance) => setReplacement((value) => ({ ...value, tolerance }))} />
        <label>
          取样
          <select value={replacement.sampling} disabled={locked} onChange={(event) => setReplacement((value) => ({ ...value, sampling: event.currentTarget.value as ColorReplacementSettings["sampling"] }))}>
            {ERASER_SAMPLINGS.map((id) => <option key={id} value={id}>{id === "continuous" ? "连续" : id === "once" ? "一次" : "背景色板"}</option>)}
          </select>
        </label>
        <label>
          边界
          <select value={replacement.limits} disabled={locked} onChange={(event) => setReplacement((value) => ({ ...value, limits: event.currentTarget.value as ColorReplacementSettings["limits"] }))}>
            {ERASER_LIMITS.map((id) => <option key={id} value={id}>{id === "discontiguous" ? "不连续" : id === "contiguous" ? "连续" : "查找边缘"}</option>)}
          </select>
        </label>
        <NumberField label="笔头尺寸" value={replacement.size ?? DEFAULT_BACKGROUND_ERASER.size} min={1} max={512} disabled={locked} onChange={(size) => setReplacement((value) => ({ ...value, size }))} />
        <label className="photo-editor__brush-check">
          <input type="checkbox" checked={replacement.antiAlias} disabled={locked} onChange={(event) => setReplacement((value) => ({ ...value, antiAlias: event.currentTarget.checked }))} />抗锯齿
        </label>
        <p className="photo-editor__brush-note">{replacementParams ? "整笔使用同一组匹配/容差/取样设置。在画布上拖动落笔。" : "参数非法：颜色替换不会提交。"}</p>
      </> : null}

      {tool === "gradient" ? <>
        <label>
          类型
          <select value={gradient.style} disabled={locked} onChange={(event) => setGradient((value) => ({ ...value, style: event.currentTarget.value as GradientSettings["style"] }))}>
            {GRADIENT_STYLES.map((style) => <option key={style} value={style}>{style === "linear" ? "线性" : style === "radial" ? "径向" : style === "angle" ? "角度" : style === "reflected" ? "对称" : "菱形"}</option>)}
          </select>
        </label>
        <NumberField label="起点 X" value={gradientFrom.x} min={0} max={width} disabled={locked} onChange={(x) => setGradientFrom((value) => ({ ...value, x }))} />
        <NumberField label="起点 Y" value={gradientFrom.y} min={0} max={height} disabled={locked} onChange={(y) => setGradientFrom((value) => ({ ...value, y }))} />
        <NumberField label="终点 X" value={gradientTo.x} min={0} max={width} disabled={locked} onChange={(x) => setGradientTo((value) => ({ ...value, x }))} />
        <NumberField label="终点 Y" value={gradientTo.y} min={0} max={height} disabled={locked} onChange={(y) => setGradientTo((value) => ({ ...value, y }))} />
        <NumberField label="不透明度" value={gradient.opacity} min={1} max={100} disabled={locked} onChange={(opacity) => setGradient((value) => ({ ...value, opacity }))} />
        {/* U28：插值方式与平滑度。选「直线色标」时不发 `method`，内核按未插值处理。 */}
        <label>
          插值
          <select
            value={gradient.method ?? ""}
            disabled={locked}
            onChange={(event) => {
              // 先取值：`setGradient` 的更新函数在事件返回后才执行，那时 `currentTarget` 已被清空。
              const method = event.currentTarget.value;
              setGradient((value) => {
                if (!method) {
                  // 清掉方法时一并清掉平滑度，避免留下不起作用的半套设置。
                  const { method: _m, smoothness: _s, ...rest } = value;
                  return rest;
                }
                return { ...value, method: method as (typeof GRADIENT_METHODS)[number] };
              });
            }}
          >
            <option value="">直线色标（不插值）</option>
            {GRADIENT_METHODS.map((method) => (
              <option key={method} value={method}>
                {method === "classic" ? "经典" : method === "perceptual" ? "感性" : method === "linear" ? "线性" : "平滑"}
              </option>
            ))}
          </select>
        </label>
        {gradient.method ? (
          <div data-gradient-smoothness>
            <NumberField
              label="插值平滑度"
              value={gradient.smoothness ?? 100}
              min={0} max={100} disabled={locked}
              onChange={(smoothness) => setGradient((value) => ({ ...value, smoothness }))}
            />
          </div>
        ) : null}
        <label className="photo-editor__brush-check">
          <input type="checkbox" checked={gradient.reverse} disabled={locked} onChange={(event) => setGradient((value) => ({ ...value, reverse: event.currentTarget.checked }))} />反向
        </label>
        <label className="photo-editor__brush-check">
          <input type="checkbox" checked={gradient.dither} disabled={locked} onChange={(event) => setGradient((value) => ({ ...value, dither: event.currentTarget.checked }))} />抖动
        </label>
        <div data-gradient-stops={gradient.stops.length}>
          <span className="photo-editor__option-hint">色标（位置 0–1）</span>
          {gradient.stops.map((stop, index) => (
            <div key={index} className="photo-editor__brush-row">
              <input
                type="number" min={0} max={1} step={0.01} value={stop.location} disabled={locked}
                aria-label={`色标 ${index + 1} 位置`}
                onChange={(event) => setGradient((value) => ({ ...value, stops: value.stops.map((item, at) => at === index ? { ...item, location: Number(event.currentTarget.value) } : item) }))}
              />
              <select
                value={stop.color} disabled={locked} aria-label={`色标 ${index + 1} 颜色`}
                onChange={(event) => setGradient((value) => ({ ...value, stops: value.stops.map((item, at) => at === index ? { ...item, color: event.currentTarget.value } : item) }))}
              >
                <option value="foreground">前景色</option>
                <option value="background">背景色</option>
                {/^#[0-9a-f]{6}$/.test(stop.color) ? <option value={stop.color}>{stop.color}</option> : null}
              </select>
              <Button size="sm" tone="ghost" disabled={locked || gradient.stops.length <= 2} onClick={() => setGradient((value) => ({ ...value, stops: value.stops.filter((_, at) => at !== index) }))}>删除</Button>
            </div>
          ))}
          <Button
            size="sm" tone="ghost" disabled={locked || gradient.stops.length >= 64}
            onClick={() => setGradient((value) => {
              const last = value.stops[value.stops.length - 1] ?? { location: 1, color: "background" };
              const location = Math.min(1, Math.round(((value.stops[value.stops.length - 2]?.location ?? 0) + last.location) / 2 * 100) / 100);
              return { ...value, stops: [...value.stops, { location, color: last.color }].sort((a, b) => a.location - b.location) };
            })}
          >添加色标</Button>
        </div>
        <div data-gradient-transparency={gradient.transparency.length}>
          <span className="photo-editor__option-hint">透明度色标</span>
          {gradient.transparency.map((stop, index) => (
            <div key={index} className="photo-editor__brush-row">
              <input type="number" min={0} max={1} step={0.01} value={stop.location} disabled={locked} aria-label={`透明度色标 ${index + 1} 位置`}
                onChange={(event) => setGradient((value) => ({ ...value, transparency: value.transparency.map((item, at) => at === index ? { ...item, location: Number(event.currentTarget.value) } : item) }))} />
              <input type="number" min={0} max={100} value={stop.opacity} disabled={locked} aria-label={`透明度色标 ${index + 1} 不透明度`}
                onChange={(event) => setGradient((value) => ({ ...value, transparency: value.transparency.map((item, at) => at === index ? { ...item, opacity: Number(event.currentTarget.value) } : item) }))} />
              <Button size="sm" tone="ghost" disabled={locked} onClick={() => setGradient((value) => ({ ...value, transparency: value.transparency.filter((_, at) => at !== index) }))}>删除</Button>
            </div>
          ))}
          <Button size="sm" tone="ghost" disabled={locked || gradient.transparency.length >= 64}
            onClick={() => setGradient((value) => ({ ...value, transparency: [...value.transparency, { location: 1, opacity: 0 }] }))}>添加透明度色标</Button>
        </div>
        <Button size="sm" disabled={locked} onClick={commitGradient}>按当前设置填充渐变</Button>
        <Button size="sm" tone="ghost" disabled={locked || !gradientPreset} onClick={applyPreset}>
          {gradientPreset ? `套用预设「${gradientPreset.name}」的色标` : "先在下方选择渐变预设"}
        </Button>
        <p className="photo-editor__brush-note">端点使用源坐标：视图旋转/缩放不影响落点。一次提交一步撤销。</p>
      </> : null}

      {tool === "bucket" ? <>
        <NumberField label="X（源像素）" value={bucketAt.x} min={0} max={width} disabled={locked} onChange={(x) => setBucketAt((value) => ({ ...value, x }))} />
        <NumberField label="Y（源像素）" value={bucketAt.y} min={0} max={height} disabled={locked} onChange={(y) => setBucketAt((value) => ({ ...value, y }))} />
        <NumberField label="容差（0–255）" value={bucket.tolerance} min={0} max={255} disabled={locked} onChange={(tolerance) => setBucket((value) => ({ ...value, tolerance }))} />
        <NumberField label="不透明度" value={bucket.opacity} min={1} max={100} disabled={locked} onChange={(opacity) => setBucket((value) => ({ ...value, opacity }))} />
        <label className="photo-editor__brush-check"><input type="checkbox" checked={bucket.contiguous} disabled={locked} onChange={(event) => setBucket((value) => ({ ...value, contiguous: event.currentTarget.checked }))} />连续</label>
        <label className="photo-editor__brush-check"><input type="checkbox" checked={bucket.antiAlias} disabled={locked} onChange={(event) => setBucket((value) => ({ ...value, antiAlias: event.currentTarget.checked }))} />抗锯齿</label>
        <label className="photo-editor__brush-check"><input type="checkbox" checked={bucket.sampleAllLayers} disabled={locked} onChange={(event) => setBucket((value) => ({ ...value, sampleAllLayers: event.currentTarget.checked }))} />所有图层取样</label>
        <Button size="sm" disabled={locked} onClick={() => commitBucket(false)}>用前景色填充</Button>
        <Button size="sm" tone="ghost" disabled={locked} onClick={() => commitBucket(true)}>用图案填充</Button>
        <p className="photo-editor__brush-note">填充尊重选区、连通域与取样策略；图案填充的图案由 layers 域持有。</p>
      </> : null}

      {tool === "magicEraser" ? <>
        <NumberField label="X（源像素）" value={bucketAt.x} min={0} max={width} disabled={locked} onChange={(x) => setBucketAt((value) => ({ ...value, x }))} />
        <NumberField label="Y（源像素）" value={bucketAt.y} min={0} max={height} disabled={locked} onChange={(y) => setBucketAt((value) => ({ ...value, y }))} />
        <NumberField label="容差（0–255）" value={magicEraser.tolerance} min={0} max={255} disabled={locked} onChange={(tolerance) => setMagicEraser((value) => ({ ...value, tolerance }))} />
        <NumberField label="不透明度" value={magicEraser.opacity} min={1} max={100} disabled={locked} onChange={(opacity) => setMagicEraser((value) => ({ ...value, opacity }))} />
        <label className="photo-editor__brush-check"><input type="checkbox" checked={magicEraser.contiguous} disabled={locked} onChange={(event) => setMagicEraser((value) => ({ ...value, contiguous: event.currentTarget.checked }))} />连续</label>
        <label className="photo-editor__brush-check"><input type="checkbox" checked={magicEraser.antiAlias} disabled={locked} onChange={(event) => setMagicEraser((value) => ({ ...value, antiAlias: event.currentTarget.checked }))} />抗锯齿</label>
        <label className="photo-editor__brush-check"><input type="checkbox" checked={magicEraser.sampleAllLayers} disabled={locked} onChange={(event) => setMagicEraser((value) => ({ ...value, sampleAllLayers: event.currentTarget.checked }))} />所有图层取样</label>
        <Button size="sm" disabled={locked} onClick={commitMagicEraser}>擦除该区域</Button>
      </> : null}

      {tool === "backgroundEraser" ? <>
        <label>
          取样
          <select value={backgroundEraser.sampling} disabled={locked} onChange={(event) => setBackgroundEraser((value) => ({ ...value, sampling: event.currentTarget.value as BackgroundEraserSettings["sampling"] }))}>
            {ERASER_SAMPLINGS.map((id) => <option key={id} value={id}>{id === "continuous" ? "连续" : id === "once" ? "一次" : "背景色板"}</option>)}
          </select>
        </label>
        <label>
          边界
          <select value={backgroundEraser.limits} disabled={locked} onChange={(event) => setBackgroundEraser((value) => ({ ...value, limits: event.currentTarget.value as BackgroundEraserSettings["limits"] }))}>
            {ERASER_LIMITS.map((id) => <option key={id} value={id}>{id === "discontiguous" ? "不连续" : id === "contiguous" ? "连续" : "查找边缘"}</option>)}
          </select>
        </label>
        <NumberField label="容差" value={backgroundEraser.tolerance} min={0} max={100} disabled={locked} onChange={(tolerance) => setBackgroundEraser((value) => ({ ...value, tolerance }))} />
        <NumberField label="尺寸" value={backgroundEraser.size} min={1} max={512} disabled={locked} onChange={(size) => setBackgroundEraser((value) => ({ ...value, size }))} />
        <NumberField label="硬度" value={backgroundEraser.hardness} min={0} max={1} step={0.01} disabled={locked} onChange={(hardness) => setBackgroundEraser((value) => ({ ...value, hardness }))} />
        <label className="photo-editor__brush-check">
          <input type="checkbox" checked={backgroundEraser.protectForegroundColor} disabled={locked} onChange={(event) => setBackgroundEraser((value) => ({ ...value, protectForegroundColor: event.currentTarget.checked }))} />保护前景色
        </label>
        <p className="photo-editor__brush-note">{backgroundParams ? "按取样色擦除，保留无关前景。在画布上拖动落笔。" : "参数非法：背景橡皮不会提交。"}</p>
      </> : null}

      {tool === "eyedropper" ? <>
        <label>
          采样尺寸
          <select value={String(eyedropper.size)} disabled={locked} onChange={(event) => {
            const raw = event.currentTarget.value;
            setEyedropper((value) => ({ ...value, size: (raw === "point" ? "point" : Number(raw)) as SampleSize }));
          }}>
            <option value="point">点采样</option>
            {SAMPLE_SIZES.map((size) => <option key={size} value={size}>{size} × {size}</option>)}
          </select>
        </label>
        <label>
          采样图层
          <select value={eyedropper.sampleLayer} disabled={locked} onChange={(event) => setEyedropper((value) => ({ ...value, sampleLayer: event.currentTarget.value as SampleLayers }))}>
            {SAMPLE_LAYERS.map((id) => <option key={id} value={id}>{id === "current" ? "当前图层" : id === "currentAndBelow" ? "当前及下方" : id === "all" ? "所有图层" : id === "allNoAdjustments" ? "所有图层（不含调整）" : "当前及下方（不含调整）"}</option>)}
          </select>
        </label>
        <NumberField label="X（源像素）" value={sampleAt.x} min={0} max={width} disabled={locked} onChange={(x) => setSampleAt((value) => ({ ...value, x }))} />
        <NumberField label="Y（源像素）" value={sampleAt.y} min={0} max={height} disabled={locked} onChange={(y) => setSampleAt((value) => ({ ...value, y }))} />
        {/* 取色目标：只在宿主提供可写颜色端口时出现，否则是点了不生效的假控件。 */}
        {onColor ? (
          <label>
            写入
            <select value={eyedropper.target} disabled={locked} onChange={(event) => setEyedropper((value) => ({ ...value, target: event.currentTarget.value as "foreground" | "background" }))}>
              <option value="foreground">前景色</option>
              <option value="background">背景色</option>
            </select>
          </label>
        ) : null}
        <Button size="sm" disabled={locked} onClick={sample}>在此取色</Button>
        {sampled ? <p className="photo-editor__brush-note" data-sampled-color={sampled}>{sampled}</p> : null}
        <p className="photo-editor__brush-note">
          取色只读：不推进修订、历史或内容指纹。画布上的 Alt 临时取色仍按当前工具工作。
          {onColor
            ? "画布上的吸管工具会把取到的色写回所选目标色板（前景/背景），落到同一份共享状态。"
            : "当前宿主没有提供可写颜色端口，因此本面板只报告取到的色值，不假装已经改了当前颜色。"}
        </p>
      </> : null}

      <Failure text={error} />
      {note ? <p className="photo-editor__brush-note" data-painting-note="true">{note}</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------- 对称（U33）

export function SymmetryPanel({ controller, locked, width, height, onChanged }: {
  controller: EditorWorkspaceController; locked: boolean; width: number; height: number; onChanged?: () => void;
}) {
  const session = paintingSession(controller);
  const [settings, setSettings] = useState<SymmetrySettings>({ mode: "vertical", center: [Math.round(width / 2), Math.round(height / 2)], rotation: 0 });
  const [pathName, setPathName] = useState("work");
  const [state, setState] = useState<string>("未启用");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    const result = session.symmetryState();
    if (!result.ok) { setError(result.message); return; }
    const decoded = decodeSymmetryState(result.value);
    setState(decoded === null ? "对称状态结构非法"
      : decoded.enabled === false ? "未启用"
      : typeof decoded.mode === "string" && decoded.mode === "path" ? `路径对称：${String(decoded.source ?? "")}`
      : `${SYMMETRY_LABELS[decoded.mode as SymmetryMode] ?? decoded.mode}`);
  }, [session, controller]);

  if (!session) return null;

  const apply = () => {
    const normalized = normalizeSymmetry(settings, width, height);
    const params = buildSymmetry(normalized);
    if (!params) { setError("对称模式/中心/旋转无效"); return; }
    const result = session.preferenceCommand("paint.setSymmetry", params);
    setError(result.ok ? null : result.message);
    if (result.ok) { setSettings(normalized); setState(SYMMETRY_LABELS[normalized.mode]); onChanged?.(); }
  };

  const fromPath = () => {
    const params = buildSymmetryFromPath(pathName);
    if (!params) { setError("路径名无效"); return; }
    const result = session.preferenceCommand("paint.symmetryFromPath", params);
    setError(result.ok ? null : result.message);
    if (result.ok) { setState(`路径对称：${pathName}`); onChanged?.(); }
  };

  const disable = () => {
    const result = session.preferenceCommand("paint.symmetryDisable", buildSymmetryDisable());
    setError(result.ok ? null : result.message);
    if (result.ok) { setState("未启用"); onChanged?.(); }
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="绘画对称" data-symmetry={settings.mode}>
      <span className="photo-editor__options-title">绘画对称</span>
      <p className="photo-editor__option-hint">当前：{state}</p>
      <label>
        模式
        <select value={settings.mode} disabled={locked} onChange={(event) => setSettings((value) => ({ ...value, mode: event.currentTarget.value as SymmetryMode }))}>
          {SYMMETRY_MODES.map((mode) => <option key={mode} value={mode}>{SYMMETRY_LABELS[mode]}</option>)}
        </select>
      </label>
      <NumberField label="中心 X" value={settings.center[0]} min={0} max={width} disabled={locked} onChange={(x) => setSettings((value) => ({ ...value, center: [x, value.center[1]] }))} />
      <NumberField label="中心 Y" value={settings.center[1]} min={0} max={height} disabled={locked} onChange={(y) => setSettings((value) => ({ ...value, center: [value.center[0], y] }))} />
      <NumberField label="旋转（度）" value={settings.rotation} min={0} max={360} disabled={locked} onChange={(rotation) => setSettings((value) => ({ ...value, rotation }))} />
      <Button size="sm" disabled={locked} onClick={apply}>应用对称</Button>
      <label>
        对称路径
        <input value={pathName} disabled={locked} maxLength={200} onChange={(event) => setPathName(event.currentTarget.value)} placeholder="work / layer / 保存的路径名" />
      </label>
      <Button size="sm" tone="ghost" disabled={locked || !pathName.trim()} onClick={fromPath}>用路径定义对称轴</Button>
      <Button size="sm" tone="ghost" disabled={locked || state === "未启用"} onClick={disable}>关闭对称</Button>
      <p className="photo-editor__brush-note">中心与旋转都用源坐标：视图旋转/缩放后对称轴不变；一笔的所有镜像在同一次撤销里移除。</p>
      <Failure text={error} />
    </section>
  );
}

// ---------------------------------------------------------------- 色板（U35）

function swatchError(result: { ok: boolean; message?: string }): string | null {
  return result.ok ? null : result.message ?? "命令失败";
}

export function SwatchesPanel({ controller, locked, colors, onChanged, onColor }: {
  controller: EditorWorkspaceController; locked: boolean; colors: { foreground: string }; onChanged?: () => void;
  /** 可写颜色端口：让「取用色板」同时更新共享外壳的前景/背景色（内核色是另一份权威状态）。 */
  onColor?: (color: string, target?: "foreground" | "background") => void;
}) {
  const session = paintingSession(controller);
  const [library, setLibrary] = useState<SwatchLibrary | null>(null);
  const [name, setName] = useState("");
  const [group, setGroup] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [used, setUsed] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    if (!session) return;
    const result = session.preferenceCommand("swatches.list", {});
    if (!result.ok) { setError(result.message); return; }
    const decoded = decodeSwatchLibrary(result.value);
    if (!decoded) { setError("色板库响应无效"); return; }
    setLibrary(decoded);
    setError(null);
  };

  useEffect(refresh, [controller, session]);

  if (!session) return null;

  const run = (id: string, params: unknown) => {
    const result = session.preferenceCommand(id, params);
    setError(swatchError(result));
    if (result.ok) { refresh(); onChanged?.(); }
    return result;
  };

  const useSwatch = (value: string) => {
    const result = session.preferenceCommand("swatches.use", { swatch: value, target: "foreground" });
    if (!result.ok) { setError(result.message); return; }
    const hex = isRecord(result.value) && typeof result.value.hex === "string" ? result.value.hex : null;
    setUsed(hex);
    setError(hex ? null : "色板命令未返回颜色");
    // 内核前景色与共享外壳色板是两份状态：不写回的话，工具轨仍显示旧色。
    if (hex && onColor) onColor(hex, "foreground");
  };

  const exportLibrary = () => {
    const result = session.preferenceCommand("swatches.export", { format: "aco" });
    if (!result.ok) { setError(result.message); return; }
    const data = isRecord(result.value) && typeof result.value.data === "string" ? result.value.data : null;
    if (!data) { setError("导出未返回字节"); return; }
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "swatches.aco";
    anchor.click();
    URL.revokeObjectURL(url);
    setError(null);
  };

  const importLibrary = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    run("swatches.import", { data: btoa(binary), mode: "append" });
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="色板" data-swatches={library?.count ?? 0}>
      <span className="photo-editor__options-title">色板</span>
      <p className="photo-editor__option-hint">共 {library?.count ?? 0} 条 · 当前前景色 {colors.foreground}</p>
      {(library?.groups ?? []).map((entry) => (
        <div key={entry.name} className="photo-editor__brush-group" data-swatch-group={entry.name}>
          <span className="photo-editor__option-hint">{entry.name || "未分组"}（{entry.swatches.length}）</span>
          <div className="photo-editor__brush-row">
            {entry.swatches.slice(0, 64).map((swatch) => (
              <button
                key={swatch.name}
                type="button"
                className="photo-editor__swatch"
                title={`${swatch.name} · ${swatch.model}`}
                style={{ background: swatch.hex }}
                disabled={locked}
                onClick={() => useSwatch(swatch.name)}
              />
            ))}
          </div>
          <div className="photo-editor__brush-row">
            {(entry.swatches.slice(0, 64)).map((swatch) => (
              <Button key={swatch.name} size="sm" tone="ghost" disabled={locked} onClick={() => run("swatches.delete", { swatch: swatch.name, group: entry.name })}>删除「{swatch.name}」</Button>
            ))}
          </div>
        </div>
      ))}
      {used ? <p className="photo-editor__brush-note" data-used-swatch={used}>已取用 {used}（写入内核前景色，供省略 `color` 或使用 <code>foreground</code> 色标的命令）</p> : null}
      <label>名称<input value={name} disabled={locked} maxLength={255} onChange={(event) => setName(event.currentTarget.value)} placeholder="新色板名称" /></label>
      <label>分组<input value={group} disabled={locked} maxLength={255} onChange={(event) => setGroup(event.currentTarget.value)} placeholder="可选" /></label>
      <Button size="sm" disabled={locked || !name.trim()} onClick={() => run("swatches.add", { color: colors.foreground, name: name.trim(), ...(group.trim() ? { group: group.trim() } : {}) })}>添加当前色</Button>
      <Button size="sm" tone="ghost" disabled={locked} onClick={() => run("swatches.newGroup", { name: group.trim() || "Swatch Group" })}>新建分组</Button>
      <Button size="sm" tone="ghost" disabled={locked || !group.trim()} onClick={() => run("swatches.renameGroup", { group: group.trim(), name: name.trim() || group.trim() })}>重命名分组</Button>
      <Button size="sm" tone="ghost" disabled={locked || !group.trim()} onClick={() => run("swatches.deleteGroup", { group: group.trim(), keepSwatches: true })}>删除分组（保留色板）</Button>
      <div className="photo-editor__brush-row">
        <Button size="sm" tone="ghost" disabled={locked} onClick={() => fileRef.current?.click()}>导入 ACO/ASE</Button>
        <Button size="sm" tone="ghost" disabled={locked || !library?.count} onClick={exportLibrary}>导出 ACO</Button>
        <Button size="sm" tone="ghost" disabled={locked} onClick={() => run("swatches.reset", { append: false })}>恢复默认色板</Button>
      </div>
      <input ref={fileRef} type="file" accept=".aco,.ase,application/octet-stream" hidden onChange={async (event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (file) await importLibrary(file);
      }} />
      <p className="photo-editor__brush-note">色板是本机偏好：增删改不写文档内容、不产生 dirty。</p>
      <Failure text={error} />
    </section>
  );
}

// ---------------------------------------------------------------- 渐变预设（U35）

export function GradientPresetsPanel({ controller, locked, onPick }: {
  controller: EditorWorkspaceController; locked: boolean;
  /** 选中的预设（名称 + 色标）；不改变端点与样式，由调用方决定是否套用。 */
  onPick?: (preset: { name: string; stops: GradientStop[]; transparency: GradientOpacityStop[] }) => void;
}) {
  const session = paintingSession(controller);
  const [library, setLibrary] = useState<GradientLibrary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    if (!session) return;
    const result = session.preferenceCommand("gradient.presets.list", {});
    if (!result.ok) { setError(result.message); return; }
    const decoded = decodeGradientLibrary(result.value);
    if (!decoded) { setError("渐变预设响应无效"); return; }
    setLibrary(decoded);
    setError(null);
  };
  useEffect(refresh, [controller, session]);
  if (!session) return null;

  const selectPreset = (preset: string) => {
    // `applyToLayer: false`：只切换当前渐变，不改已有渐变填充层。
    const result = session.preferenceCommand("gradient.presets.select", { preset, applyToLayer: false });
    if (!result.ok) { setError(result.message); return; }
    refresh();
    // 只解码**新返回的当前预设**：`library` 里的 groups 已经是解码后的对象，重新按
    // `[[t, color]]` 解析会失败，导致选中预设拿不到色标。
    const current = decodeGradientLibrary({ groups: [], current: isRecord(result.value) ? result.value.current : null })?.current ?? null;
    if (current) onPick?.(current);
  };

  const useInline = (name: string, stops: GradientStop[], transparency: GradientOpacityStop[]) => {
    const compiled = gradientPresetStops({ name, stops, transparency });
    const result = session.preferenceCommand("gradient.presets.select", { stops: compiled.stops, ...(compiled.transparency.length ? { transparency: compiled.transparency } : {}), applyToLayer: false });
    setError(result.ok ? null : result.message);
    if (result.ok) onPick?.({ name, stops, transparency });
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="渐变预设" data-gradient-presets={library ? library.groups.length : 0}>
      <span className="photo-editor__options-title">渐变预设</span>
      <p className="photo-editor__option-hint">当前：{library?.current?.name ?? "无"}</p>
      {(library?.groups ?? []).map((entry) => (
        <div key={entry.name} className="photo-editor__brush-group">
          <span className="photo-editor__option-hint">{entry.name}</span>
          <div className="photo-editor__brush-row">
            {entry.presets.slice(0, 32).map((preset) => (
              <Button
                key={preset.name}
                size="sm"
                tone={library?.current?.name === preset.name ? "neutral" : "ghost"}
                disabled={locked}
                title={`${preset.stops.map((stop) => `${Math.round(stop.location * 100)}% ${stop.color}`).join(" → ")}`}
                onClick={() => selectPreset(preset.name)}
              >{preset.name}</Button>
            ))}
          </div>
          <div className="photo-editor__brush-row">
            {entry.presets.slice(0, 32).map((preset) => (
              <Button key={`${preset.name}-inline`} size="sm" tone="ghost" disabled={locked}
                onClick={() => useInline(preset.name, preset.stops, preset.transparency)}>以色标应用「{preset.name}」</Button>
            ))}
          </div>
        </div>
      ))}
      <p className="photo-editor__brush-note">选预设只切换当前渐变色标，端点/类型/透明度由绘画工具参数决定；已有渐变填充层不受影响。</p>
      <Failure text={error} />
    </section>
  );
}

// ---------------------------------------------------------------- 工具预设与重置（U36）

export function ToolPresetsPanel({ controller, locked, onChanged }: {
  controller: EditorWorkspaceController; locked: boolean; onChanged?: () => void;
}) {
  const session = paintingSession(controller);
  const [list, setList] = useState<ToolPresetList | null>(null);
  const [filter, setFilter] = useState("");
  const [name, setName] = useState("");
  const [tool, setTool] = useState("brush");
  const [includeColor, setIncludeColor] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    if (!session) return;
    const result = session.toolPresets(filter);
    if (!result.ok) { setError(result.message); return; }
    const decoded = decodeToolPresets(Array.isArray(result.value) ? { presets: result.value } : result.value);
    if (!decoded) { setError("工具预设响应无效"); return; }
    setList(decoded);
    setError(null);
  };

  useEffect(refresh, [controller, session, filter]);
  if (!session) return null;

  const visible = useMemo(() => filterToolPresets(list, filter), [list, filter]);

  const save = () => {
    const params = buildToolPreset({ name, tool, includeColor });
    if (!params) { setError("预设名称或工具 id 无效"); return; }
    const result = session.saveToolPreset(params);
    setError(result.ok ? null : result.message);
    if (result.ok) { setName(""); setNote("已保存工具预设（偏好，不写文档）"); refresh(); onChanged?.(); }
  };

  const select = (preset: string) => {
    const result = session.selectToolPreset(preset);
    setError(result.ok ? null : result.message);
    if (result.ok) {
      const applied = isRecord(result.value) && typeof result.value.tool === "string" ? result.value.tool : null;
      setNote(applied ? `已套用预设，目标工具：${applied}` : "已套用预设");
      onChanged?.();
    }
  };

  const edit = (action: "rename" | "delete", preset: string) => {
    const next = action === "rename" ? (name.trim() || `${preset} 2`) : undefined;
    const params = buildToolPresetEdit(action, preset, next);
    if (!params) { setError(action === "rename" ? "新名称无效" : "预设名称无效"); return; }
    const result = session.preferenceCommand("tool.presets.edit", params);
    setError(result.ok ? null : result.message);
    if (result.ok) { setName(""); refresh(); onChanged?.(); }
  };

  const resetTool = () => {
    const result = session.resetTool(tool);
    setError(result.ok ? null : result.message);
    if (result.ok) setNote(`已恢复「${tool}」的工具默认值（仅声明范围，不动文档）`);
  };

  const resetAll = () => {
    const result = session.resetAllTools();
    setError(result.ok ? null : result.message);
    if (result.ok) setNote("已恢复全部绘画工具默认值；文档、历史与工作区布局未改变");
  };

  const exportPresets = () => {
    const snapshot = session.toolPresetSnapshot();
    if (!snapshot.ok) { setError(snapshot.message); return; }
    const url = URL.createObjectURL(new Blob([new Uint8Array(snapshot.value)], { type: "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "tool-presets.bin";
    anchor.click();
    URL.revokeObjectURL(url);
    setError(null);
  };

  const importPresets = async (file: File) => {
    const result = session.restoreToolPresets(new Uint8Array(await file.arrayBuffer()));
    setError(result.ok ? null : result.message);
    if (result.ok) refresh();
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="工具预设" data-tool-presets={visible.length}>
      <span className="photo-editor__options-title">工具预设</span>
      <label>按工具过滤<input value={filter} disabled={locked} onChange={(event) => setFilter(event.currentTarget.value)} placeholder="brush / pencil…" /></label>
      <ul>
        {visible.slice(0, 64).map((preset) => (
          <li key={preset.name} data-tool-preset={preset.name}>
            <Button size="sm" disabled={locked} onClick={() => select(preset.name)}>{preset.name}</Button>
            <span className="photo-editor__option-hint">{preset.tool}{preset.foreground ? ` · ${preset.foreground}` : ""}</span>
            <Button size="sm" tone="ghost" disabled={locked} onClick={() => edit("rename", preset.name)}>改名</Button>
            <Button size="sm" tone="ghost" disabled={locked} onClick={() => edit("delete", preset.name)}>删除</Button>
          </li>
        ))}
      </ul>
      <label>新预设名称<input value={name} disabled={locked} maxLength={255} onChange={(event) => setName(event.currentTarget.value)} /></label>
      <label>工具<select value={tool} disabled={locked} onChange={(event) => setTool(event.currentTarget.value)}>
        {["brush", "pencil", "eraser", "backgroundEraser", "magicEraser", "colorReplacement", "gradient", "bucket", "eyedropper"].map((id) => <option key={id} value={id}>{id}</option>)}
      </select></label>
      <label className="photo-editor__brush-check"><input type="checkbox" checked={includeColor} disabled={locked} onChange={(event) => setIncludeColor(event.currentTarget.checked)} />包含前景色</label>
      <Button size="sm" disabled={locked || !name.trim()} onClick={save}>保存当前工具预设</Button>
      <div className="photo-editor__brush-row">
        <Button size="sm" tone="ghost" disabled={locked} onClick={resetTool}>恢复「{tool}」默认</Button>
        <Button size="sm" tone="ghost" disabled={locked} onClick={resetAll}>恢复全部工具默认</Button>
      </div>
      <div className="photo-editor__brush-row">
        <Button size="sm" tone="ghost" disabled={locked} onClick={exportPresets}>导出工具预设</Button>
        <Button size="sm" tone="ghost" disabled={locked} onClick={() => fileRef.current?.click()}>导入工具预设</Button>
      </div>
      <input ref={fileRef} type="file" accept="application/octet-stream" hidden onChange={async (event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (file) await importPresets(file);
      }} />
      <p className="photo-editor__brush-note">工具预设与重置只改工具/偏好状态：不删除文档、不改历史、不产生 dirty。</p>
      <Failure text={error} />
      {note ? <p className="photo-editor__brush-note" data-tool-preset-note="true">{note}</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------- 笔刷分组与选区笔尖（U32）

export function BrushGroupsPanel({ controller, locked, hasSelection, onChanged }: {
  controller: EditorWorkspaceController; locked: boolean; hasSelection: boolean; onChanged?: () => void;
}) {
  const session = paintingSession(controller);
  const library = controller.brushLibrary();
  const [groups, setGroups] = useState<{ group: string; count: number }[]>([]);
  const [group, setGroup] = useState("");
  const [newName, setNewName] = useState("");
  const [tipName, setTipName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // 分组表来自内核笔刷库摘要（`brushPresetsJson(false).groups`），不另存一份。
  const loadGroups = () => {
    library.refresh();
    const state = library.snapshot();
    setGroups(state.list?.groups ?? []);
    setError(state.message);
  };

  useEffect(loadGroups, [controller, library]);

  const run = (action: () => { ok: boolean; message?: string }) => {
    const result = action();
    setError(result.ok ? null : result.message ?? "命令失败");
    if (result.ok) { loadGroups(); onChanged?.(); }
  };

  const defineTip = () => {
    if (!session) { setError("当前宿主未提供绘画域接口"); return; }
    const result = session.defineBrushFromSelection(tipName.trim(), group.trim());
    setError(result.ok ? null : result.message);
    if (result.ok) {
      setNote(`已从选区定义笔尖「${tipName.trim()}」`);
      setTipName("");
      loadGroups();
      onChanged?.();
    }
  };

  if (!session) return null;

  return (
    <section className="photo-editor__advanced-group" aria-label="笔刷分组" data-brush-groups={groups.length}>
      <span className="photo-editor__options-title">笔刷分组</span>
      <ul>
        {groups.map((entry) => (
          <li key={entry.group} data-brush-group={entry.group}>
            <span>{entry.group || "未分组"}（{entry.count}）</span>
            <Button size="sm" tone="ghost" disabled={locked} onClick={() => run(() => session.moveBrushGroup(entry.group, 0))}>置顶</Button>
            <Button size="sm" tone="ghost" disabled={locked || !newName.trim()} onClick={() => run(() => session.renameBrushGroup(entry.group, newName.trim()))}>改名</Button>
            <Button size="sm" tone="ghost" disabled={locked} onClick={() => run(() => session.deleteBrushGroup(entry.group, true))}>删除（保留笔刷）</Button>
          </li>
        ))}
      </ul>
      <label>分组<input value={group} disabled={locked} maxLength={255} onChange={(event) => setGroup(event.currentTarget.value)} placeholder="目标分组" /></label>
      <label>新名称<input value={newName} disabled={locked} maxLength={255} onChange={(event) => setNewName(event.currentTarget.value)} placeholder="改名用的名称" /></label>
      <label>笔尖名称<input value={tipName} disabled={locked} maxLength={255} onChange={(event) => setTipName(event.currentTarget.value)} placeholder="从选区定义的新笔尖" /></label>
      <Button size="sm" disabled={locked || !hasSelection || !tipName.trim()} onClick={defineTip}>从选区定义笔尖</Button>
      <p className="photo-editor__brush-note">
        {hasSelection ? "笔尖取自当前选区像素；已冻结的笔迹不受随后删库影响。" : "先在画布建立选区，再定义静态笔尖。"}
        分组改名/排序/删除会立即落到本机笔刷库。
      </p>
      <Failure text={error} />
      {note ? <p className="photo-editor__brush-note" data-brush-group-note="true">{note}</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------- 组装

/** 「绘画工具与预设」区：工具参数 + 对称 + 色板 + 渐变预设 + 工具预设 + 笔刷分组。 */
export function PaintingWorkflowPanel({ context }: { context: FeaturePanelContext }) {
  const width = context.documentView?.width ?? 0;
  const height = context.documentView?.height ?? 0;
  const hasSelection = context.documentView?.hasSelection ?? false;
  // 选预设只记录「想用哪套色标」；真正套用要用户再点一次，免得冲掉正在调的端点。
  const [preset, setPreset] = useState<{ name: string; stops: GradientStop[]; transparency: GradientOpacityStop[] } | null>(null);
  return (
    <div className="photo-editor__advanced-section" data-advanced-section="painting">
      <PaintingToolOptionsPanel controller={context.controller} locked={context.locked} colors={context.colors} width={width} height={height} gradientPreset={preset}
        {...(context.setColor ? { onColor: context.setColor } : {})} />
      <SymmetryPanel controller={context.controller} locked={context.locked} width={width} height={height} onChanged={context.refreshPreview} />
      <SwatchesPanel controller={context.controller} locked={context.locked} colors={context.colors}
        {...(context.setColor ? { onColor: context.setColor } : {})} />
      <GradientPresetsPanel controller={context.controller} locked={context.locked}
        onPick={(picked) => setPreset(picked)} />
      <ToolPresetsPanel controller={context.controller} locked={context.locked} />
      <BrushGroupsPanel controller={context.controller} locked={context.locked} hasSelection={hasSelection} />
    </div>
  );
}

export { TOOL_LABELS as PAINTING_PANEL_TOOL_LABELS, PANEL_TOOLS as PAINTING_PANEL_TOOLS };
