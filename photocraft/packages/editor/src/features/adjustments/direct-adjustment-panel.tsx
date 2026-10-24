import { useCallback, useMemo, useState } from "react";
import { Button } from "../../ui/Button.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import { AdjustmentRange } from "./adjustment-range.js";
import { RgbCurveEditor, type CurvePoint } from "./rgb-curve-editor.js";
import { CurveMapEditor } from "./curve-map-editor.js";
import { isRecord } from "../shared/panels.js";
import { clamp } from "../shared/tool-parameters.js";
import {
  ADJUSTMENT_LABELS,
  COMMAND_LABELS,
  CURVE_CHANNEL_LABELS,
  CURVE_CHANNELS,
  HUE_RANGES,
  HUE_RANGE_LABELS,
  PHOTO_FILTER_PRESETS,
  SELECTIVE_RANGES,
  SELECTIVE_RANGE_LABELS,
  buildBlackWhite,
  buildBrightnessContrast,
  buildChannelMixer,
  buildColorBalance,
  buildCurveMap,
  buildCurvePoints,
  buildCurves,
  buildExposure,
  buildEyedropper,
  buildGradientStops,
  buildHueRange,
  buildHueSaturation,
  buildLevels,
  buildLevelsChannel,
  buildMatchColor,
  buildPhotoFilter,
  buildPosterize,
  buildReplaceColor,
  buildSelectiveColor,
  buildShadowsHighlights,
  buildThreshold,
  buildVibrance,
  curveMapOf,
  curveOf,
  decodeDirectTargets,
  defaultAdjustmentParams,
  insertGradientStop,
  isParameterlessTarget,
  levelsOf,
  normalizeHexColor,
  pointsFromMap,
  smoothCurveMap,
  validCurveMap,
  type AdjustmentCommand,
  type AdjustmentKind,
  type DirectAdjustmentDocument,
  type CurveChannel,
  type HueRangeId,
  type LevelsChannel,
  type SelectiveRangeId
} from "./tool-parameters.js";

type DomainSession = EditorWorkspaceController["features"]["adjustments"];

/** 参数控件与草稿的薄封装：每次改动都进入同一份草稿，确认才提交。 */
function Range({ label, value, min, max, step = 1, disabled, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; disabled: boolean; onChange: (value: number) => void;
}) {
  // AdjustmentRange 只处理整数滑杆；这里把小数步长换成一个 number 输入，语义仍是同一参数。
  if (!Number.isInteger(step)) {
    return (
      <label data-adjustment-control>
        {label}
        <input type="number" min={min} max={max} step={step} value={value} disabled={disabled}
          onChange={(event) => {
            const next = event.currentTarget.valueAsNumber;
            if (Number.isFinite(next)) onChange(next);
          }} />
        <output>{value}</output>
      </label>
    );
  }
  return <AdjustmentRange label={label} value={value} min={min} max={max} disabled={disabled} onChange={onChange} onEnd={() => true} />;
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function triple(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) return fallback;
  return [number(value[0], fallback[0]), number(value[1], fallback[1]), number(value[2], fallback[2])];
}

/**
 * 图像 ▸ 调整：直接作用在像素层的调整草稿（U40–U44）。
 *
 * 入口与「新建调整图层」并列但不相同：这里确认后只增加一步历史、不新增图层；是否可开始
 * （命令门 + 可写像素目标）全部由内核判定，界面只渲染内核报告的真实入口。
 */
export function DirectAdjustmentPanel({ endpoint, readonly, foreground, onApply, initialTarget }: {
  initialTarget?: string;
  endpoint: EditorWorkspaceController;
  readonly: boolean;
  foreground: string;
  onApply: () => void;
}) {
  const session = (endpoint.features as { adjustments?: DomainSession } | undefined)?.adjustments;
  const snapshot = endpoint.snapshot();
  // 目标清单里带着「可匹配的来源文档」，它会随打开/关闭文档变化：按整份快照重取，
  // 不能只按会话对象缓存一次，否则打开第二份图后来源下拉仍是旧的。
  const targets = useMemo(() => {
    if (!session || typeof session.directAdjustmentTargets !== "function") return null;
    const result = session.directAdjustmentTargets();
    return result.ok ? decodeDirectTargets(result.value) : null;
  }, [session, snapshot]);

  const document = snapshot.view.document;
  const active = document?.layers.find((layer) => layer.id === document.activeLayerId) ?? null;
  const [target, setTarget] = useState<string | null>(initialTarget ?? null);
  const [params, setParams] = useState<Record<string, Record<string, unknown>>>({});
  const [active_draft, setActiveDraft] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const current = target ?? targets?.kinds[0] ?? targets?.commands[0] ?? null;
  const isCommand = current !== null && (targets?.commands.includes(current as AdjustmentCommand) ?? false);
  const values = (current !== null ? params[current] : undefined) ?? (current === null ? {} : defaultParams(current));

  const run = useCallback((patch: Record<string, unknown>) => {
    if (!session || current === null) return;
    const merged = { ...values, ...patch };
    setParams((all) => ({ ...all, [current]: merged }));
    if (active_draft) {
      // 预览失败会让草稿失效：保留会话让用户修正或取消，不能确认上一版成功预览。
      const result = session.previewDirectAdjustment(patch);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setMessage(null);
      onApply();
      return;
    }
    const result = session.beginDirectAdjustment(current, merged, undefined);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setMessage(null);
    setActiveDraft(true);
    onApply();
  }, [session, current, values, active_draft, onApply]);

  const commit = () => {
    if (!session) return;
    const result = session.commitDirectAdjustment();
    setMessage(result.ok ? null : result.message);
    if (result.ok) setActiveDraft(false);
    if (result.ok) onApply();
  };

  const cancel = () => {
    session?.cancelDirectAdjustment();
    setActiveDraft(false);
    setMessage(null);
    onApply();
  };

  if (!targets) return null;
  if (current === null) {
    return (
      <section className="photo-editor__advanced-group" aria-label="直接调整" data-direct-adjustment="none">
        <span className="photo-editor__options-title">直接调整（图像 ▸ 调整）</span>
        <p className="photo-editor__brush-note">运行时尚未开放任何直接调整命令。</p>
      </section>
    );
  }
  const open = active_draft;

  return (
    <section className="photo-editor__advanced-group" aria-label="直接调整" data-direct-adjustment={current}>
      <span className="photo-editor__options-title">直接调整（图像 ▸ 调整）</span>
      <label>
        调整
        <select value={current} disabled={readonly || open} onChange={(event) => {
          setTarget(event.currentTarget.value);
          setMessage(null);
        }}>
          {targets.kinds.length ? <optgroup label="逐类调整">
            {targets.kinds.map((kind) => <option key={kind} value={kind}>{ADJUSTMENT_LABELS[kind]}</option>)}
          </optgroup> : null}
          {targets.commands.length ? <optgroup label="自动与颜色匹配">
            {targets.commands.map((command) => <option key={command} value={command}>{COMMAND_LABELS[command]}</option>)}
          </optgroup> : null}
        </select>
      </label>
      <p className="photo-editor__option-hint">
        目标：{active ? `${active.name}（像素层，使用当前选区）` : "未选择图层"}
        {open ? " · 预览中" : ""}
      </p>
      {isCommand
        ? <CommandParameters command={current as AdjustmentCommand} values={values} disabled={readonly} foreground={foreground} targets={targets} onChange={run} />
        : <KindParameters kind={current as AdjustmentKind} values={values} disabled={readonly} foreground={foreground} endpoint={endpoint} onChange={run} />}
      {!open && isParameterlessTarget(current) ? (
        // 没有参数的调整（反相、自动校正、去色、均衡）没有滑杆可拖：必须有一个显式起点，
        // 否则草稿永远开不了，确认按钮也就永远不可用。
        <div className="photo-editor__options-group">
          <Button size="sm" disabled={readonly} onClick={() => run({})}>应用调整</Button>
        </div>
      ) : null}
      <div className="photo-editor__options-group">
        <Button size="sm" disabled={readonly || !open} onClick={commit}>确认调整</Button>
        <Button size="sm" tone="ghost" disabled={!open} onClick={cancel}>取消调整</Button>
      </div>
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}

function defaultParams(target: string): Record<string, unknown> {
  if (target in ADJUSTMENT_LABELS) return defaultAdjustmentParams(target as AdjustmentKind);
  return {};
}

/**
 * 逐类调整的参数控件（直接调整与调整层共用同一套控件）。
 *
 * 两种目标的参数语义相同，只有落点不同；复制一套会让范围表与默认值在两处漂移。
 */
export function KindParameters({ kind, values, disabled, foreground, endpoint, onChange }: {
  kind: AdjustmentKind; values: Record<string, unknown>; disabled: boolean; foreground: string;
  endpoint: EditorWorkspaceController; onChange: (patch: Record<string, unknown>) => void;
}) {
  switch (kind) {
    case "brightnessContrast":
      return <>
        <Range label="亮度" value={number(values.brightness, 0)} min={-150} max={150} disabled={disabled}
          onChange={(value) => onChange(buildBrightnessContrast(value, number(values.contrast, 0), values.legacy === true))} />
        <Range label="对比度" value={number(values.contrast, 0)} min={-50} max={100} disabled={disabled}
          onChange={(value) => onChange(buildBrightnessContrast(number(values.brightness, 0), value, values.legacy === true))} />
      </>;
    case "exposure":
      return <>
        <Range label="曝光度" value={number(values.exposure, 0)} min={-20} max={20} step={0.05} disabled={disabled}
          onChange={(value) => onChange(buildExposure(value, number(values.offset, 0), number(values.gamma, 1)))} />
        <Range label="偏移" value={number(values.offset, 0)} min={-0.5} max={0.5} step={0.01} disabled={disabled}
          onChange={(value) => onChange(buildExposure(number(values.exposure, 0), value, number(values.gamma, 1)))} />
        <Range label="伽马校正" value={number(values.gamma, 1)} min={0.01} max={9.99} step={0.01} disabled={disabled}
          onChange={(value) => onChange(buildExposure(number(values.exposure, 0), number(values.offset, 0), value))} />
      </>;
    case "vibrance":
      return <>
        <Range label="自然饱和度" value={number(values.vibrance, 0)} min={-100} max={100} disabled={disabled}
          onChange={(value) => onChange(buildVibrance(value, number(values.saturation, 0)))} />
        <Range label="饱和度" value={number(values.saturation, 0)} min={-100} max={100} disabled={disabled}
          onChange={(value) => onChange(buildVibrance(number(values.vibrance, 0), value))} />
      </>;
    case "hueSaturation":
      return <HueSaturationParameters values={values} disabled={disabled} onChange={onChange} />;
    case "curves":
      return <CurvesParameters values={values} disabled={disabled} foreground={foreground} endpoint={endpoint} onChange={onChange} />;
    case "levels":
      return <LevelsParameters values={values} disabled={disabled} foreground={foreground} onChange={onChange} />;
    case "colorBalance":
      return <ColorBalanceParameters values={values} disabled={disabled} onChange={onChange} />;
    case "blackWhite":
      return <BlackWhiteParameters values={values} disabled={disabled} onChange={onChange} />;
    case "photoFilter":
      return <>
        <label>
          滤镜
          <select value={typeof values.filter === "string" ? values.filter : "warming85"} disabled={disabled}
            onChange={(event) => onChange(buildPhotoFilter(event.currentTarget.value, number(values.density, 25)))}>
            {PHOTO_FILTER_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          </select>
        </label>
        <Range label="浓度" value={number(values.density, 25)} min={0} max={100} disabled={disabled}
          onChange={(value) => onChange(buildPhotoFilter(typeof values.filter === "string" ? values.filter : "warming85", value))} />
        <label>
          保留明度
          <input type="checkbox" checked={values.preserveLuminosity !== false} disabled={disabled}
            onChange={(event) => onChange({ preserveLuminosity: event.currentTarget.checked })} />
        </label>
      </>;
    case "channelMixer":
      return <ChannelMixerParameters values={values} disabled={disabled} onChange={onChange} />;
    case "invert":
      return <p className="photo-editor__option-hint">反相没有参数：确认后直接反转目标像素（尊重选区）。</p>;
    case "posterize":
      return <Range label="色阶数" value={number(values.levels, 4)} min={2} max={255} disabled={disabled}
        onChange={(value) => onChange(buildPosterize(value))} />;
    case "threshold":
      return <Range label="阈值色阶" value={number(values.level, 128)} min={1} max={255} disabled={disabled}
        onChange={(value) => onChange(buildThreshold(value))} />;
    case "gradientMap":
      return <GradientMapParameters values={values} disabled={disabled} onChange={onChange} />;
    case "selectiveColor":
      return <SelectiveColorParameters values={values} disabled={disabled} onChange={onChange} />;
  }
}

function HueSaturationParameters({ values, disabled, onChange }: {
  values: Record<string, unknown>; disabled: boolean; onChange: (patch: Record<string, unknown>) => void;
}) {
  const [range, setRange] = useState<HueRangeId>("reds");
  const colorize = values.colorize === true;
  const current = isRecord(values[range]) ? (values[range] as Record<string, unknown>) : {};
  const bounds = Array.isArray(current.range) && current.range.length === 4
    ? current.range.map((value: unknown, index: number) => number(value, [-45, -15, 15, 45][index]!)) as [number, number, number, number]
    : undefined;
  // 总参数与六个色域写在同一个对象里：改总参数必须把已有色域原样带上，切到着色也一样。
  const master = (hue: number, saturation: number, lightness: number, nextColorize = colorize) =>
    onChange(buildHueSaturation(hue, saturation, lightness, {
      colorize: nextColorize,
      ranges: Object.fromEntries(
        HUE_RANGES.filter((id) => isRecord(values[id])).map((id) => [id, values[id] as Record<string, unknown>])
      )
    }));
  return <>
    <Range label={colorize ? "着色色相" : "色相"} value={number(values.hue, 0)} min={colorize ? 0 : -180} max={colorize ? 360 : 180} disabled={disabled}
      onChange={(value) => master(value, number(values.saturation, 0), number(values.lightness, 0))} />
    <Range label="饱和度" value={number(values.saturation, 0)} min={colorize ? 0 : -100} max={100} disabled={disabled}
      onChange={(value) => master(number(values.hue, 0), value, number(values.lightness, 0))} />
    <Range label="明度" value={number(values.lightness, 0)} min={-100} max={100} disabled={disabled}
      onChange={(value) => master(number(values.hue, 0), number(values.saturation, 0), value)} />
    <label>
      着色
      <input type="checkbox" checked={colorize} disabled={disabled}
        onChange={(event) => master(number(values.hue, 0), number(values.saturation, 0), number(values.lightness, 0), event.currentTarget.checked)} />
    </label>
    <label>
      色域
      <select value={range} disabled={disabled} onChange={(event) => setRange(event.currentTarget.value as HueRangeId)}>
        {HUE_RANGES.map((id) => <option key={id} value={id}>{HUE_RANGE_LABELS[id]}</option>)}
      </select>
    </label>
    <Range label="色域色相" value={number(current.hue, 0)} min={-180} max={180} disabled={disabled}
      onChange={(value) => onChange({ [range]: buildHueRange(value, number(current.saturation, 0), number(current.lightness, 0), bounds) })} />
    <Range label="色域饱和度" value={number(current.saturation, 0)} min={-100} max={100} disabled={disabled}
      onChange={(value) => onChange({ [range]: buildHueRange(number(current.hue, 0), value, number(current.lightness, 0), bounds) })} />
    <Range label="色域明度" value={number(current.lightness, 0)} min={-100} max={100} disabled={disabled}
      onChange={(value) => onChange({ [range]: buildHueRange(number(current.hue, 0), number(current.saturation, 0), value, bounds) })} />
    <p className="photo-editor__option-hint">范围滑杆（左界 / 左羽化 / 右羽化 / 右界，角度）：</p>
    <div className="photo-editor__options-group">
      {[0, 1, 2, 3].map((index) => (
        <label key={index} data-adjustment-control>
          {["左界", "左羽化", "右羽化", "右界"][index]}
          <input type="number" min={-360} max={360} value={bounds?.[index] ?? 0} disabled={disabled}
            onChange={(event) => {
              const next = event.currentTarget.valueAsNumber;
              if (!Number.isFinite(next)) return;
              const updated: [number, number, number, number] = [...(bounds ?? [0, 0, 0, 0])] as [number, number, number, number];
              updated[index] = next;
              onChange({ [range]: buildHueRange(number(current.hue, 0), number(current.saturation, 0), number(current.lightness, 0), updated) });
            }} />
        </label>
      ))}
    </div>
  </>;
}

function CurvesParameters({ values, disabled, foreground, endpoint, onChange }: {
  values: Record<string, unknown>; disabled: boolean; foreground: string; endpoint: EditorWorkspaceController;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const [channel, setChannel] = useState<CurveChannel>("rgb");
  const pencil = values.pencil === true;
  const smooth = number(values.smooth, 0);
  // 铅笔参数是一整条 256 级映射，点参数是控制点；两者由同一个键承载，模式看 `pencil`。
  const stored = useMemo(() => {
    const raw = channel === "rgb" ? values.points : values[channel];
    return Array.isArray(raw) && validCurveMap(raw as number[]) ? (raw as number[]).map((value) => clamp(value, 0, 255)) : null;
  }, [values, channel]);
  const points = useMemo(() => (stored ? pointsFromMap(stored) : curveOf(values, channel)), [stored, values, channel]);
  // 点曲线的真实形状来自内核样条 LUT（与上游 `points_to_map` 同一份），不是本地直线近似。
  const spline = useMemo(() => {
    if (pencil || typeof endpoint.curveGeometry !== "function") return null;
    const result = endpoint.curveGeometry(points);
    return result.ok && result.value.length === 256 ? result.value : null;
  }, [endpoint, points, pencil]);
  // 有映射用映射；点曲线优先用内核样条，取不到样条端口才退回本地直线换算（`curveMapOf`）。
  const baseMap = stored ?? spline ?? curveMapOf(values, channel);
  // 平滑是铅笔模式下的一次次半径 3 均值：图形按同样次数显示，所见即内核所用。
  const map = useMemo(() => {
    let next = baseMap;
    for (let pass = 0; pass < smooth; pass++) next = smoothCurveMap(next);
    return next;
  }, [baseMap, smooth]);
  const samples = pencil ? map : (spline ?? curveSamples(points));
  const eyedropper = (point: "black" | "gray" | "white") => {
    const color = hexToTriple(foreground);
    if (!color) return;
    onChange({ eyedropper: buildEyedropper(point, { color }) });
  };
  return <>
    <label>
      通道
      <select value={channel} disabled={disabled} onChange={(event) => setChannel(event.currentTarget.value as CurveChannel)}>
        {CURVE_CHANNELS.map((id) => <option key={id} value={id}>{CURVE_CHANNEL_LABELS[id]}</option>)}
      </select>
    </label>
    {pencil
      ? <CurveMapEditor map={map} readonly={disabled}
          // 新笔画就是新的整条映射：写进去后平滑归零，避免在已平滑的图上再叠一层。
          onChange={(next) => onChange(buildCurveMap(channel, next, { smooth: 0 }))} />
      // 调整层：曲线必须直接可拖。inline（不套 Popover）让属性面板里就有曲线图形（A4）。
      : <RgbCurveEditor points={points} samples={samples} readonly={disabled} editing inline
          onChange={(next: CurvePoint[]) => onChange(buildCurves(channel, next, { pencil: false, smooth: smooth > 0 ? smooth : undefined }))}
          onApply={() => true} onEnd={() => true} />}
    <label>
      铅笔曲线
      <input type="checkbox" checked={pencil} disabled={disabled}
        onChange={(event) => {
          // 切到铅笔：把当前曲线按内核样条换算成 256 级映射；切回点：把看到的映射折回控制点。
          if (event.currentTarget.checked) onChange(buildCurveMap(channel, baseMap, { smooth: smooth > 0 ? smooth : undefined }));
          else onChange(buildCurves(channel, pointsFromMap(map), { pencil: false, smooth: 0 }));
        }} />
    </label>
    <Range label="平滑次数" value={smooth} min={0} max={10} disabled={disabled || !pencil}
      onChange={(value) => onChange({ smooth: value })} />
    <div className="photo-editor__options-group">
      {(["black", "gray", "white"] as const).map((point) => (
        <Button key={point} size="sm" tone="ghost" disabled={disabled}
          title="以当前前景色作为取样色（画布点选取样由共享画布端口提供）"
          onClick={() => eyedropper(point)}>
          {point === "black" ? "设黑场" : point === "gray" ? "设灰场" : "设白场"}
        </Button>
      ))}
    </div>
  </>;
}

function LevelsParameters({ values, disabled, foreground, onChange }: {
  values: Record<string, unknown>; disabled: boolean; foreground: string; onChange: (patch: Record<string, unknown>) => void;
}) {
  const [channel, setChannel] = useState<"rgb" | "red" | "green" | "blue">("rgb");
  const levels = levelsOf(values, channel);
  const write = (next: LevelsChannel) => onChange(channel === "rgb" ? buildLevels(next) : buildLevelsChannel(channel, next));
  const eyedropper = (point: "black" | "gray" | "white") => {
    const color = hexToTriple(foreground);
    if (!color) return;
    onChange({ eyedropper: buildEyedropper(point, { color }) });
  };
  return <>
    <label>
      通道
      <select value={channel} disabled={disabled} onChange={(event) => setChannel(event.currentTarget.value as "rgb" | "red" | "green" | "blue")}>
        {(["rgb", "red", "green", "blue"] as const).map((id) => <option key={id} value={id}>{CURVE_CHANNEL_LABELS[id]}</option>)}
      </select>
    </label>
    <Range label="输入黑场" value={levels.inBlack} min={0} max={253} disabled={disabled}
      onChange={(value) => write({ ...levels, inBlack: value })} />
    <Range label="伽马" value={levels.gamma} min={0.1} max={9.99} step={0.01} disabled={disabled}
      onChange={(value) => write({ ...levels, gamma: value })} />
    <Range label="输入白场" value={levels.inWhite} min={2} max={255} disabled={disabled}
      onChange={(value) => write({ ...levels, inWhite: value })} />
    <Range label="输出黑场" value={levels.outBlack} min={0} max={255} disabled={disabled}
      onChange={(value) => write({ ...levels, outBlack: value })} />
    <Range label="输出白场" value={levels.outWhite} min={0} max={255} disabled={disabled}
      onChange={(value) => write({ ...levels, outWhite: value })} />
    <div className="photo-editor__options-group">
      {(["black", "gray", "white"] as const).map((point) => (
        <Button key={point} size="sm" tone="ghost" disabled={disabled}
          title="以当前前景色作为取样色（画布点选取样由共享画布端口提供）"
          onClick={() => eyedropper(point)}>
          {point === "black" ? "设黑场" : point === "gray" ? "设灰场" : "设白场"}
        </Button>
      ))}
    </div>
  </>;
}

function ColorBalanceParameters({ values, disabled, onChange }: {
  values: Record<string, unknown>; disabled: boolean; onChange: (patch: Record<string, unknown>) => void;
}) {
  const shadows = triple(values.shadows, [0, 0, 0]);
  const midtones = triple(values.midtones, [0, 0, 0]);
  const highlights = triple(values.highlights, [0, 0, 0]);
  const preserve = values.preserveLuminosity !== false;
  const row = (label: string, current: [number, number, number], apply: (next: [number, number, number]) => void) => (
    <>
      {["青色 ↔ 红色", "洋红 ↔ 绿色", "黄色 ↔ 蓝色"].map((axis, index) => (
        <Range key={`${label}-${axis}`} label={`${label} ${axis}`} value={current[index]!} min={-100} max={100} disabled={disabled}
          onChange={(value) => {
            const next: [number, number, number] = [...current];
            next[index] = value;
            apply(next);
          }} />
      ))}
    </>
  );
  return <>
    {row("阴影", shadows, (next) => onChange(buildColorBalance(next, midtones, highlights, preserve)))}
    {row("中间调", midtones, (next) => onChange(buildColorBalance(shadows, next, highlights, preserve)))}
    {row("高光", highlights, (next) => onChange(buildColorBalance(shadows, midtones, next, preserve)))}
    <label>
      保留明度
      <input type="checkbox" checked={preserve} disabled={disabled}
        onChange={(event) => onChange({ preserveLuminosity: event.currentTarget.checked })} />
    </label>
  </>;
}

function BlackWhiteParameters({ values, disabled, onChange }: {
  values: Record<string, unknown>; disabled: boolean; onChange: (patch: Record<string, unknown>) => void;
}) {
  const tint = values.tint === true;
  const tintColor = typeof values.tintColor === "string" ? values.tintColor : "#e1d3b3";
  const weights = useMemo(() => {
    const out: Partial<Record<HueRangeId, number>> = {};
    for (const range of HUE_RANGES) out[range] = number(values[range], 40);
    return out;
  }, [values]);
  return <>
    {HUE_RANGES.map((range) => (
      <Range key={range} label={HUE_RANGE_LABELS[range]} value={weights[range] ?? 40} min={-200} max={300} disabled={disabled}
        onChange={(value) => onChange(buildBlackWhite({ ...weights, [range]: value }, tint ? { enabled: true, color: tintColor } : undefined))} />
    ))}
    <label>
      色调
      <input type="checkbox" checked={tint} disabled={disabled}
        onChange={(event) => onChange(buildBlackWhite(weights, { enabled: event.currentTarget.checked, color: tintColor }))} />
    </label>
    <label>
      色调颜色
      <input type="color" value={normalizeHexColor(tintColor) ?? "#e1d3b3"} disabled={disabled || !tint}
        onChange={(event) => onChange(buildBlackWhite(weights, { enabled: true, color: event.currentTarget.value }))} />
    </label>
  </>;
}

function ChannelMixerParameters({ values, disabled, onChange }: {
  values: Record<string, unknown>; disabled: boolean; onChange: (patch: Record<string, unknown>) => void;
}) {
  const monochrome = values.monochrome === true;
  const row = (key: "red" | "green" | "blue" | "gray") => {
    const raw = values[key];
    return Array.isArray(raw) && raw.length === 4 ? raw.map((value, index) => number(value, [100, 0, 0, 0][index]!)) as [number, number, number, number] : undefined;
  };
  const label = (key: string) => (key === "red" ? "红色" : key === "green" ? "绿色" : key === "blue" ? "蓝色" : "灰色");
  return <>
    <label>
      单色
      <input type="checkbox" checked={monochrome} disabled={disabled}
        onChange={(event) => onChange({ monochrome: event.currentTarget.checked })} />
    </label>
    {(["red", "green", "blue"] as const).filter((key) => !monochrome || key === "red").map((key) => {
      const current = row(key) ?? [100, 0, 0, 0];
      return ["红 %", "绿 %", "蓝 %", "常数 %"].map((axis, index) => (
        <Range key={`${key}-${axis}`} label={`${label(key)} ${axis}`} value={current[index]!} min={-200} max={200} disabled={disabled}
          onChange={(value) => {
            const next: [number, number, number, number] = [...current];
            next[index] = value;
            onChange(buildChannelMixer({ [key]: next }, monochrome));
          }} />
      ));
    })}
  </>;
}

function GradientMapParameters({ values, disabled, onChange }: {
  values: Record<string, unknown>; disabled: boolean; onChange: (patch: Record<string, unknown>) => void;
}) {
  const raw = Array.isArray(values.stops) ? values.stops : [[0, "#000000"], [1, "#ffffff"]];
  const stops = raw.map((stop) => {
    const pair = Array.isArray(stop) ? stop : [0, "#000000"];
    return [number(pair[0], 0), typeof pair[1] === "string" ? pair[1] : "#000000"] as [number, string];
  });
  const write = (next: Array<[number, string]>) => onChange({ stops: buildGradientStops(next) });
  return <>
    {stops.map(([position, color], index) => (
      <div key={index} className="photo-editor__options-group">
        <label data-adjustment-control>
          位置
          <input type="number" min={0} max={1} step={0.01} value={position} disabled={disabled}
            onChange={(event) => {
              const next = event.currentTarget.valueAsNumber;
              if (!Number.isFinite(next)) return;
              const updated = stops.map((stop, i) => (i === index ? [next, stop[1]] as [number, string] : stop));
              write(updated);
            }} />
        </label>
        <label data-adjustment-control>
          颜色
          <input type="color" value={normalizeHexColor(color) ?? "#000000"} disabled={disabled}
            onChange={(event) => write(stops.map((stop, i) => (i === index ? [stop[0], event.currentTarget.value] as [number, string] : stop)))} />
        </label>
        <Button size="sm" tone="ghost" disabled={disabled || stops.length <= 2}
          onClick={() => write(stops.filter((_, i) => i !== index))}>移除</Button>
      </div>
    ))}
    <Button size="sm" tone="ghost" disabled={disabled || stops.length >= 64}
      onClick={() => onChange({ stops: insertGradientStop(stops) })}>添加站点</Button>
    <label>
      反转
      <input type="checkbox" checked={values.reverse === true} disabled={disabled}
        onChange={(event) => onChange({ reverse: event.currentTarget.checked })} />
    </label>
    <label>
      仿色
      <input type="checkbox" checked={values.dither === true} disabled={disabled}
        onChange={(event) => onChange({ dither: event.currentTarget.checked })} />
    </label>
  </>;
}

function SelectiveColorParameters({ values, disabled, onChange }: {
  values: Record<string, unknown>; disabled: boolean; onChange: (patch: Record<string, unknown>) => void;
}) {
  const [range, setRange] = useState<SelectiveRangeId>("reds");
  const method = values.method === "absolute" ? "absolute" : "relative";
  const raw = values[range];
  const current: [number, number, number, number] = Array.isArray(raw) && raw.length === 4
    ? [number(raw[0], 0), number(raw[1], 0), number(raw[2], 0), number(raw[3], 0)]
    : [0, 0, 0, 0];
  const axisLabels = ["青色", "洋红", "黄色", "黑色"];
  return <>
    <label>
      方法
      <select value={method} disabled={disabled}
        onChange={(event) => onChange(buildSelectiveColor(event.currentTarget.value as "relative" | "absolute", range, current))}>
        <option value="relative">相对</option>
        <option value="absolute">绝对</option>
      </select>
    </label>
    <label>
      颜色范围
      <select value={range} disabled={disabled} onChange={(event) => setRange(event.currentTarget.value as SelectiveRangeId)}>
        {SELECTIVE_RANGES.map((id) => <option key={id} value={id}>{SELECTIVE_RANGE_LABELS[id]}</option>)}
      </select>
    </label>
    {axisLabels.map((axis, index) => (
      <Range key={axis} label={axis} value={current[index]!} min={-100} max={100} disabled={disabled}
        onChange={(value) => {
          const next: [number, number, number, number] = [...current];
          next[index] = value;
          onChange(buildSelectiveColor(method, range, next));
        }} />
    ))}
  </>;
}

/** 自动校正与匹配/替换颜色的参数控件。 */
function CommandParameters({ command, values, disabled, foreground, targets, onChange }: {
  command: AdjustmentCommand; values: Record<string, unknown>; disabled: boolean; foreground: string;
  targets: { documents: DirectAdjustmentDocument[] };
  onChange: (patch: Record<string, unknown>) => void;
}) {
  switch (command) {
    case "image.autoTone":
    case "image.autoContrast":
    case "image.autoColor":
    case "image.adjustments.desaturate":
    case "image.adjustments.equalize":
      return <p className="photo-editor__option-hint">该命令没有参数：确认后按当前选区作用到目标像素层。</p>;
    case "image.adjustments.shadowsHighlights":
      return <>
        <Range label="阴影数量" value={number(values.shadowAmount, 35)} min={0} max={100} disabled={disabled}
          onChange={(value) => onChange(buildShadowsHighlights({ ...readShadows(values), shadowAmount: value }))} />
        <Range label="阴影色调宽度" value={number(values.shadowTone, 50)} min={0} max={100} disabled={disabled}
          onChange={(value) => onChange(buildShadowsHighlights({ ...readShadows(values), shadowTone: value }))} />
        <Range label="阴影半径" value={number(values.shadowRadius, 30)} min={0} max={2500} disabled={disabled}
          onChange={(value) => onChange(buildShadowsHighlights({ ...readShadows(values), shadowRadius: value }))} />
        <Range label="高光数量" value={number(values.highlightAmount, 0)} min={0} max={100} disabled={disabled}
          onChange={(value) => onChange(buildShadowsHighlights({ ...readShadows(values), highlightAmount: value }))} />
        <Range label="高光色调宽度" value={number(values.highlightTone, 50)} min={0} max={100} disabled={disabled}
          onChange={(value) => onChange(buildShadowsHighlights({ ...readShadows(values), highlightTone: value }))} />
        <Range label="高光半径" value={number(values.highlightRadius, 30)} min={0} max={2500} disabled={disabled}
          onChange={(value) => onChange(buildShadowsHighlights({ ...readShadows(values), highlightRadius: value }))} />
        <Range label="颜色校正" value={number(values.color, 20)} min={-100} max={100} disabled={disabled}
          onChange={(value) => onChange(buildShadowsHighlights({ ...readShadows(values), color: value }))} />
        <Range label="中间调对比度" value={number(values.midtone, 0)} min={-100} max={100} disabled={disabled}
          onChange={(value) => onChange(buildShadowsHighlights({ ...readShadows(values), midtone: value }))} />
        <Range label="黑色剪贴" value={number(values.blackClip, 0.01)} min={0} max={50} step={0.01} disabled={disabled}
          onChange={(value) => onChange(buildShadowsHighlights({ ...readShadows(values), blackClip: value }))} />
        <Range label="白色剪贴" value={number(values.whiteClip, 0.01)} min={0} max={50} step={0.01} disabled={disabled}
          onChange={(value) => onChange(buildShadowsHighlights({ ...readShadows(values), whiteClip: value }))} />
      </>;
    case "image.adjustments.replaceColor": {
      const color = typeof values.color === "string" ? values.color : foreground;
      return <>
        <label>
          目标颜色
          <input type="color" value={normalizeHexColor(color) ?? "#000000"} disabled={disabled}
            onChange={(event) => onChange(buildReplaceColor({ ...readReplace(values), color: event.currentTarget.value }))} />
        </label>
        <Range label="颜色容差" value={number(values.fuzziness, 40)} min={0} max={200} disabled={disabled}
          onChange={(value) => onChange(buildReplaceColor({ ...readReplace(values), fuzziness: value }))} />
        <Range label="色相" value={number(values.hue, 0)} min={-180} max={180} disabled={disabled}
          onChange={(value) => onChange(buildReplaceColor({ ...readReplace(values), hue: value }))} />
        <Range label="饱和度" value={number(values.saturation, 0)} min={-100} max={100} disabled={disabled}
          onChange={(value) => onChange(buildReplaceColor({ ...readReplace(values), saturation: value }))} />
        <Range label="明度" value={number(values.lightness, 0)} min={-100} max={100} disabled={disabled}
          onChange={(value) => onChange(buildReplaceColor({ ...readReplace(values), lightness: value }))} />
        <label>
          局部化颜色聚类
          <input type="checkbox" checked={values.localized === true} disabled={disabled}
            onChange={(event) => onChange(buildReplaceColor({ ...readReplace(values), localized: event.currentTarget.checked, range: number(values.range, 100) }))} />
        </label>
        <p className="photo-editor__option-hint">取样点由画布端口提供；未提供时不要开启局部化聚类（内核会拒绝）。</p>
      </>;
    }
    case "image.adjustments.matchColor": {
      // 来源清单来自内核会话（`directAdjustmentTargets().documents`），不是共享视图模型。
      const documents = targets.documents;
      const others = documents.filter((document) => !document.active);
      // 默认是「当前图像」（不写 source）。不能默认挑第一份别的文档：界面显示的来源必须
      // 就是内核实际使用的来源。
      const source = typeof values.source === "number" ? values.source : null;
      return <>
        {others.length ? <>
          <label>
            来源图像
            <select value={source === null ? "" : String(source)} disabled={disabled}
              onChange={(event) => {
                const next = event.currentTarget.value;
                const patch = buildMatchColor({ ...readMatch(values), ...(next === "" ? {} : { source: Number(next) }) });
                // 回到「当前图像」要显式清除来源键：省略键只会保留上一份来源。
                onChange(next === "" ? { ...patch, source: null } : patch);
              }}>
              <option value="">当前图像</option>
              {others.map((document) => (
                <option key={document.index} value={document.index}>{document.name}（{document.width}×{document.height}）</option>
              ))}
            </select>
          </label>
          <label>
            来源使用来源选区
            <input type="checkbox" checked={values.useSelectionInSource === true} disabled={disabled || source === null}
              onChange={(event) => onChange(buildMatchColor({ ...readMatch(values), useSelectionInSource: event.currentTarget.checked }))} />
          </label>
        </> : null}
        <Range label="明亮度" value={number(values.luminance, 100)} min={1} max={200} disabled={disabled}
          onChange={(value) => onChange(buildMatchColor({ ...readMatch(values), luminance: value }))} />
        <Range label="颜色强度" value={number(values.intensity, 100)} min={1} max={200} disabled={disabled}
          onChange={(value) => onChange(buildMatchColor({ ...readMatch(values), intensity: value }))} />
        <Range label="渐隐" value={number(values.fade, 0)} min={0} max={100} disabled={disabled}
          onChange={(value) => onChange(buildMatchColor({ ...readMatch(values), fade: value }))} />
        <label>
          中和
          <input type="checkbox" checked={values.neutralize === true} disabled={disabled}
            onChange={(event) => onChange(buildMatchColor({ ...readMatch(values), neutralize: event.currentTarget.checked }))} />
        </label>
        <p className="photo-editor__option-hint">
          {others.length
            ? "来源统计取自开始调整时的冻结快照；来源图像本身不会被修改。"
            : "只打开了一份图像：来源固定为当前图像。"}
        </p>
      </>;
    }
  }
}

function readShadows(values: Record<string, unknown>) {
  return {
    shadowAmount: number(values.shadowAmount, 35),
    shadowTone: number(values.shadowTone, 50),
    shadowRadius: number(values.shadowRadius, 30),
    highlightAmount: number(values.highlightAmount, 0),
    highlightTone: number(values.highlightTone, 50),
    highlightRadius: number(values.highlightRadius, 30),
    color: number(values.color, 20),
    midtone: number(values.midtone, 0),
    blackClip: number(values.blackClip, 0.01),
    whiteClip: number(values.whiteClip, 0.01)
  };
}

function readReplace(values: Record<string, unknown>) {
  return {
    color: typeof values.color === "string" ? values.color : "#000000",
    fuzziness: number(values.fuzziness, 40),
    hue: number(values.hue, 0),
    saturation: number(values.saturation, 0),
    lightness: number(values.lightness, 0),
    ...(values.localized === true ? { localized: true, range: number(values.range, 100) } : {})
  };
}

function readMatch(values: Record<string, unknown>) {
  return {
    luminance: number(values.luminance, 100),
    intensity: number(values.intensity, 100),
    fade: number(values.fade, 0),
    neutralize: values.neutralize === true,
    // 来源选择必须随每次参数改动一起带回去，否则调一个滑杆就把跨文档来源丢成「本图统计」。
    ...(typeof values.source === "number" ? { source: values.source } : {}),
    ...(typeof values.sourceLayer === "number" ? { sourceLayer: values.sourceLayer } : {}),
    ...(values.useSelectionInSource === true ? { useSelectionInSource: true } : {})
  };
}

/** `#rrggbb` → `[r, g, b]`（0–1）；非法返回 null。 */
function hexToTriple(hex: string): [number, number, number] | null {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return null;
  const channel = (offset: number) => parseInt(normalized.slice(offset, offset + 2), 16) / 255;
  return [channel(1), channel(3), channel(5)];
}

/** 曲线的界面采样：点曲线直线连接（真实样条由内核绘制预览）。 */
function curveSamples(points: readonly CurvePoint[]): number[] {
  const sorted = buildCurvePoints(points);
  if (sorted.length < 2) return Array.from({ length: 256 }, (_, index) => index);
  const samples: number[] = [];
  for (let x = 0; x < 256; x++) {
    const right = sorted.findIndex((point) => point[0] >= x);
    if (right <= 0) { samples.push(sorted[0]![1]); continue; }
    const a = sorted[right - 1]!;
    const b = sorted[right]!;
    const t = b[0] === a[0] ? 0 : (x - a[0]) / (b[0] - a[0]);
    samples.push(a[1] + (b[1] - a[1]) * t);
  }
  return samples;
}
