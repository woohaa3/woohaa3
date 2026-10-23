import { useEffect, useMemo, useRef, useState } from "react";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import { Button } from "../../ui/Button.js";
import { supports, isRecord } from "../shared/panels.js";
import {
  LAYER_EFFECT_KINDS,
  LAYER_FILL_KINDS,
  LAYER_FILL_LIMITS,
  LAYER_FILTER_COMBINATION_NOTE,
  LAYER_KNOCKOUTS,
  type LayerFillKind,
} from "@woohaa3/photocraft-protocol";

/** 图层过滤（U63）：只改变列表行，不改内容、选择或合成。 */
export function LayerFilterPanel({ controller, revision, onFilter }: { controller: EditorWorkspaceController; revision: number; onFilter: (ids: number[] | null) => void }) {
  const [by, setBy] = useState<"kind" | "name" | "mode">("kind");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("");
  const [mode, setMode] = useState("");
  const [onlySelected, setOnlySelected] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!supports(controller, "filterLayers")) return;
    const kinds = kind ? kind.split(",") : [];
    const result = controller.filterLayers({ by, name, kinds, mode: mode || undefined, onlySelected });
    if (!result.ok) {
      // 非法条件不静默退回「全部」：说明原因并保持上一次的行集合。
      setMessage(result.message);
      return;
    }
    setMessage(null);
    if (isRecord(result.value) && Array.isArray(result.value.layers)) {
      setCount(typeof result.value.visible === "number" ? result.value.visible : result.value.layers.length);
      onFilter(result.value.active === true ? result.value.layers.flatMap((row) => isRecord(row) && typeof row.layer === "number" ? [row.layer] : []) : null);
    }
  }, [controller, by, name, kind, mode, onlySelected, revision, onFilter]);

  if (!supports(controller, "filterLayers")) return null;
  return (
    <section className="photo-editor__advanced-group" aria-label="图层过滤" data-layer-filter="true">
      <span className="photo-editor__options-title">图层过滤</span>
      <label>
        主条件
        <select value={by} onChange={(event) => setBy(event.currentTarget.value as typeof by)}>
          <option value="kind">种类</option>
          <option value="name">名称</option>
          <option value="mode">混合模式</option>
        </select>
      </label>
      <label>
        名称
        <input value={name} maxLength={200} onChange={(event) => setName(event.currentTarget.value)} placeholder="按名称筛选" />
      </label>
      <label>
        种类
        <select value={kind} onChange={(event) => setKind(event.currentTarget.value)}>
          <option value="">全部</option>
          <option value="raster">像素</option>
          <option value="group">组</option>
          <option value="text">文字</option>
          <option value="adjustment">调整与填充</option>
          <option value="shape">形状</option>
          <option value="smart">智能对象</option>
          <option value="raster,shape">像素与形状</option>
        </select>
      </label>
      {by === "mode" ? (
        <label>
          混合模式
          <select value={mode} onChange={(event) => setMode(event.currentTarget.value)}>
            <option value="">全部</option>
            <option value="normal">正常</option>
            <option value="multiply">正片叠底</option>
            <option value="screen">滤色</option>
            <option value="overlay">叠加</option>
            <option value="darken">变暗</option>
            <option value="lighten">变亮</option>
            <option value="pass-through">穿透（仅组）</option>
          </select>
        </label>
      ) : null}
      <label>
        <input type="checkbox" checked={onlySelected} onChange={(event) => setOnlySelected(event.currentTarget.checked)} />
        只显示选中层
      </label>
      {count !== null ? <span className="photo-editor__option-hint">{count} 层匹配</span> : null}
      <p className="photo-editor__option-hint">{LAYER_FILTER_COMBINATION_NOTE}</p>
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}

/** 可重编辑的填充层（U57）：纯色 / 渐变 / 图案。 */
export function FillLayerPanel({ controller, readonly, activeLayerId }: { controller: EditorWorkspaceController; readonly: boolean; activeLayerId: number | null }) {
  const layers = controller.features?.layers;
  const [kind, setKind] = useState<LayerFillKind>("solid");
  const [color, setColor] = useState("#3366ff");
  const [from, setFrom] = useState("#ff0000");
  const [to, setTo] = useState("#0000ff");
  const [angle, setAngle] = useState(45);
  const [style, setStyle] = useState("linear");
  const [scale, setScale] = useState(100);
  const [offset, setOffset] = useState("0,0");
  const [reverse, setReverse] = useState(false);
  const [dither, setDither] = useState(false);
  const [align, setAlign] = useState(true);
  const [pattern, setPattern] = useState("");
  const [patternLink, setPatternLink] = useState(true);
  const [patternPhase, setPatternPhase] = useState("0,0");
  const [transparency, setTransparency] = useState("");
  /** 建层时用哪条路径做矢量蒙版：`""` 表示按选区（上游缺省）。只在**创建**时有效。 */
  const [maskPath, setMaskPath] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [info, setInfo] = useState<Record<string, unknown> | null>(null);
  const [preview, setPreview] = useState<{ width: number; height: number; pixels: number[] } | null>(null);

  // 可用路径来自文档本身（工作路径 + 已保存路径）：凭空造名字只会被内核拒绝。
  const paths = useMemo(() => {
    const result = controller.vectorSnapshot?.();
    if (!result || !result.ok || !isRecord(result.value)) return [] as string[];
    const list = Array.isArray(result.value.paths) ? result.value.paths : [];
    return list.flatMap((entry) => isRecord(entry) && typeof entry.name === "string" ? [entry.name] : []);
  }, [controller]);

  const patterns = useMemo(() => {
    const result = controller.patternLibrary?.();
    if (!result || !result.ok || !isRecord(result.value)) return [] as Array<{ id: string; name: string }>;
    const presets = Array.isArray(result.value.patternPresets) ? result.value.patternPresets : [];
    const merged = [...presets, ...(Array.isArray(result.value.presets) ? result.value.presets : [])];
    return merged.flatMap((entry) => isRecord(entry) && typeof entry.name === "string" ? [{ id: String(entry.id ?? entry.name), name: entry.name }] : []);
  }, [controller]);

  // 选中填充层时读回规范参数，重开后仍能继续改（含端点、反相、抖动与对齐）。
  useEffect(() => {
    if (activeLayerId === null || !layers?.fillLayerInfo) { setInfo(null); return; }
    const result = layers.fillLayerInfo(activeLayerId);
    const value = result.ok && isRecord(result.value) ? result.value : null;
    setInfo(value && typeof value.kind === "string" ? value : null);
    if (!value) return;
    if (value.kind === "solid" && typeof value.color === "string") { setKind("solid"); setColor(value.color); }
    if (value.kind === "gradient" && isRecord(value.gradient)) {
      const gradient = value.gradient;
      setKind("gradient");
      if (typeof gradient.style === "string") setStyle(gradient.style);
      if (typeof gradient.angle === "number") setAngle(gradient.angle);
      if (typeof gradient.scale === "number") setScale(Math.round(gradient.scale * 100) / 100);
      if (typeof gradient.reverse === "boolean") setReverse(gradient.reverse);
      if (typeof gradient.dither === "boolean") setDither(gradient.dither);
      if (typeof gradient.align === "boolean") setAlign(gradient.align);
      if (Array.isArray(gradient.offset) && gradient.offset.length === 2) setOffset(gradient.offset.map((value) => round(Number(value))).join(","));
      // 端点读回成起止色：`stops` 是权威值，`from`/`to` 是画布手柄坐标（不是颜色）。
      const stops = Array.isArray(gradient.stops) ? gradient.stops.filter(isRecordPair) : [];
      if (stops.length >= 2 && typeof stops[0]![1] === "string") setFrom(String(stops[0]![1]));
      if (stops.length >= 2 && typeof stops[stops.length - 1]![1] === "string") setTo(String(stops[stops.length - 1]![1]));
      const opacity = Array.isArray(gradient.transparency) ? gradient.transparency.filter(isRecordPair) : [];
      setTransparency(opacity.length ? opacity.map((pair) => `${round(Number(pair[0]))}:${round(Number(pair[1]))}`).join(", ") : "");
    }
    if (value.kind === "pattern" && isRecord(value.pattern)) {
      const entry = value.pattern;
      setKind("pattern");
      if (typeof entry.name === "string") setPattern(entry.name);
      if (typeof entry.scale === "number") setScale(Math.round(entry.scale));
      if (typeof entry.angle === "number") setAngle(entry.angle);
      if (typeof entry.link === "boolean") setPatternLink(entry.link);
      if (Array.isArray(entry.phase) && entry.phase.length === 2) setPatternPhase(entry.phase.map((value) => round(Number(value))).join(","));
    }
  }, [activeLayerId, layers, controller]);

  if (!layers?.createFillLayer) return null;

  const params = (): Record<string, unknown> => {
    if (kind === "solid") return { color };
    if (kind === "gradient") {
      // 面板只给两种颜色时用 `stops`：`from`/`to` 在上游是画布坐标，发颜色会被拒。
      const opacity = parsePairs(transparency);
      return {
        stops: [[0, from], [1, to]],
        style,
        angle,
        scale,
        reverse,
        dither,
        align,
        offset: parseNumbers(offset),
        ...(opacity.length ? { transparency: opacity } : {}),
      };
    }
    return { pattern, scale, angle, link: patternLink, phase: parseNumbers(patternPhase) };
  };

  const run = (result: { ok: boolean; message?: string }) => setMessage(result.ok ? null : result.message ?? "操作失败");

  return (
    <section className="photo-editor__advanced-group" aria-label="填充层" data-fill-layer-panel="true">
      <span className="photo-editor__options-title">填充层</span>
      <label>
        种类
        <select value={kind} disabled={readonly} onChange={(event) => setKind(event.currentTarget.value as LayerFillKind)}>
          {LAYER_FILL_KINDS.map((entry) => <option key={entry} value={entry}>{entry === "solid" ? "纯色" : entry === "gradient" ? "渐变" : "图案"}</option>)}
        </select>
      </label>
      {kind === "solid" ? (
        <label>颜色<input type="color" value={color} disabled={readonly} onChange={(event) => setColor(event.currentTarget.value)} /></label>
      ) : null}
      {kind === "gradient" ? (
        <>
          <label>起点<input type="color" value={from} disabled={readonly} onChange={(event) => setFrom(event.currentTarget.value)} /></label>
          <label>终点<input type="color" value={to} disabled={readonly} onChange={(event) => setTo(event.currentTarget.value)} /></label>
          <label>
            样式
            <select value={style} disabled={readonly} onChange={(event) => setStyle(event.currentTarget.value)}>
              <option value="linear">线性</option>
              <option value="radial">径向</option>
              <option value="angle">角度</option>
              <option value="reflected">对称</option>
              <option value="diamond">菱形</option>
            </select>
          </label>
          <label>透明度端点<input value={transparency} disabled={readonly} placeholder="0:100, 1:0（0–100）" onChange={(event) => setTransparency(event.currentTarget.value)} /></label>
          <label>偏移 %<input value={offset} disabled={readonly} placeholder="0,0" onChange={(event) => setOffset(event.currentTarget.value)} /></label>
          <label><input type="checkbox" checked={reverse} disabled={readonly} onChange={(event) => setReverse(event.currentTarget.checked)} />反相</label>
          <label><input type="checkbox" checked={dither} disabled={readonly} onChange={(event) => setDither(event.currentTarget.checked)} />仿色</label>
          <label><input type="checkbox" checked={align} disabled={readonly} onChange={(event) => setAlign(event.currentTarget.checked)} />与图层对齐</label>
        </>
      ) : null}
      {kind === "pattern" ? (
        <>
          <label>
            图案
            <select value={pattern} disabled={readonly} onChange={(event) => setPattern(event.currentTarget.value)}>
              <option value="">选择图案</option>
              {patterns.map((entry) => <option key={entry.id} value={entry.name}>{entry.name}</option>)}
            </select>
          </label>
          <label><input type="checkbox" checked={patternLink} disabled={readonly} onChange={(event) => setPatternLink(event.currentTarget.checked)} />与图层链接</label>
          <label>相位<input value={patternPhase} disabled={readonly} placeholder="0,0" onChange={(event) => setPatternPhase(event.currentTarget.value)} /></label>
        </>
      ) : null}
      {kind !== "solid" ? (
        <>
          <label>
            {kind === "gradient" ? "缩放 %" : "图案缩放 %"}
            <input type="number" min={kind === "gradient" ? LAYER_FILL_LIMITS.minGradientScale : LAYER_FILL_LIMITS.minPatternScalePercent}
              max={kind === "gradient" ? LAYER_FILL_LIMITS.maxGradientScale : LAYER_FILL_LIMITS.maxPatternScalePercent}
              value={scale} disabled={readonly} onChange={(event) => setScale(Number(event.currentTarget.value))} />
          </label>
          <label>角度<input type="number" min={-360} max={360} value={angle} disabled={readonly} onChange={(event) => setAngle(Number(event.currentTarget.value))} /></label>
        </>
      ) : null}
      <label>
        蒙版路径（仅新建）
        <select value={maskPath} disabled={readonly} onChange={(event) => setMaskPath(event.currentTarget.value)}>
          <option value="">按选区生成图层蒙版</option>
          {paths.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      <Button size="sm" disabled={readonly} onClick={() => run(layers.createFillLayer(kind, { ...params(), ...(maskPath ? { path: maskPath } : {}) }))}>新建填充层</Button>
      {info ? (
        <>
          <Button size="sm" disabled={readonly || activeLayerId === null} onClick={() => {
            if (activeLayerId === null) return;
            const result = layers.previewFillLayer(activeLayerId, kind, params());
            if (!result.ok) { setMessage(result.message); return; }
            // 真实候选像素：画在同一条面板里，确认前文档与历史都不动。
            setPreview(workflowPreviewOf(result.value));
            setMessage("预览已更新；确认前不会改文档");
          }}>预览</Button>
          <Button size="sm" tone="primary" disabled={readonly || activeLayerId === null} onClick={() => {
            if (activeLayerId === null) return;
            const applied = layers.applyFillLayer(activeLayerId, kind, params());
            setMessage(applied.ok ? (isRecord(applied.value) && applied.value.changed === false ? "参数未变化" : null) : applied.message);
            if (applied.ok) setPreview(null);
          }}>应用参数</Button>
        </>
      ) : null}
      <WorkflowPreview preview={preview} title="填充层预览" />
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}

/** `0:100, 1:0` → `[[0,100],[1,0]]`；解析失败返回空数组，由内核给出明确拒绝。 */
function parsePairs(text: string): Array<[number, number]> {
  return text.split(",").flatMap((entry) => {
    const [at, value] = entry.split(":");
    const position = Number(at);
    const amount = Number(value);
    return Number.isFinite(position) && Number.isFinite(amount) ? [[position, amount] as [number, number]] : [];
  });
}

/** 预览必须是正尺寸 RGBA8 数组；形状不对就不画（不猜、不补零）。 */
function isPreview(value: unknown): value is { width: number; height: number; pixels: number[] } {
  if (!isRecord(value)) return false;
  const { width, height, pixels } = value;
  if (typeof width !== "number" || typeof height !== "number" || !Array.isArray(pixels)) return false;
  return width > 0 && height > 0 && pixels.length === width * height * 4;
}

/**
 * 内核候选像素的画布（U57/U60/U62）。
 *
 * 预览全部来自内核在同一份候选文档上的合成结果，界面不做任何近似或占位图；
 * 没有像素时返回 `null`，面板因此不会显示「假预览」。
 */
export function WorkflowPreview({ preview, title }: { preview: { width: number; height: number; pixels: number[] } | null; title: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !preview) return;
    canvas.width = preview.width;
    canvas.height = preview.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    const image = context.createImageData(preview.width, preview.height);
    image.data.set(preview.pixels);
    context.putImageData(image, 0, 0);
  }, [preview]);
  if (!preview) return null;
  return <canvas ref={ref} className="photo-editor__workflow-preview" width={preview.width} height={preview.height} title={title} data-workflow-preview={title} />;
}

/** 从内核返回值里取候选像素：`preview.preview` 或顶层的 `preview`。 */
function workflowPreviewOf(value: unknown) {
  if (!isRecord(value)) return null;
  const candidate = isRecord(value.preview) ? value.preview : value;
  return isPreview(candidate) ? candidate : null;
}

/** `1,2` → `[1,2]`；任一项不是有限数时返回 `undefined`（交给内核判断「缺省」）。 */
function parseNumbers(text: string): number[] | undefined {
  const parts = text.split(",").map((entry) => Number(entry.trim()));
  return parts.length && parts.every((value) => Number.isFinite(value)) ? parts : undefined;
}

function isRecordPair(value: unknown): value is [number, unknown] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "number";
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 高级混合与 Blend If（U60）：拖动时预览真实合成过渡，松手提交。 */
export function BlendingPanel({ controller, readonly, activeLayerId }: { controller: EditorWorkspaceController; readonly: boolean; activeLayerId: number | null }) {
  const layers = controller.features?.layers;
  const [blend, setBlend] = useState("normal");
  const [knockout, setKnockout] = useState("none");
  const [channels, setChannels] = useState([true, true, true]);
  const [interior, setInterior] = useState(false);
  const [clipped, setClipped] = useState(true);
  const [transparency, setTransparency] = useState(true);
  const [layerMask, setLayerMask] = useState(false);
  const [vectorMask, setVectorMask] = useState(false);
  const [blendIf, setBlendIf] = useState({ channel: "gray", thisLayer: "0,255", underlying: "0,255" });
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ width: number; height: number; pixels: number[] } | null>(null);

  // 读回已保存的高级混合：不然「应用」会用面板默认值覆盖已有 Blend If / 挖空。
  const active = controller.currentView().document?.layers.find((layer) => layer.id === activeLayerId);
  // 依赖用**值签名**而不是对象引用：视图模型每次刷新都会给新对象，引用做依赖会让读回反复触发。
  const signature = active
    ? [active.id, active.blend, active.advancedBlending.knockout, active.advancedBlending.blendInterior,
      active.advancedBlending.blendClipped, active.advancedBlending.transparencyShapes,
      active.advancedBlending.layerMaskHidesEffects, active.advancedBlending.vectorMaskHidesEffects,
      (active.channels ?? []).join(""), JSON.stringify(active.blendIf)].join("|")
    : "";
  useEffect(() => {
    if (!active) return;
    setBlend(active.blend.toLowerCase());
    setKnockout(active.advancedBlending.knockout);
    if (active.channels) setChannels(active.channels.slice(0, 3));
    setInterior(active.advancedBlending.blendInterior);
    setClipped(active.advancedBlending.blendClipped);
    setTransparency(active.advancedBlending.transparencyShapes);
    setLayerMask(active.advancedBlending.layerMaskHidesEffects);
    setVectorMask(active.advancedBlending.vectorMaskHidesEffects);
    const first = active.blendIf[0];
    setBlendIf({
      channel: first ? blendChannelName(first.channel) : "gray",
      thisLayer: first ? first.thisLayer.join(",") : "0,255",
      underlying: first ? first.underlying.join(",") : "0,255",
    });
    setMessage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signature 已覆盖 active 的全部读取字段
  }, [signature]);

  if (!layers?.previewBlending) return null;

  const params = () => ({
    ...(activeLayerId === null ? {} : { layer: activeLayerId }),
    blend,
    knockout,
    channels,
    blendInteriorEffectsAsGroup: interior,
    blendClippedLayersAsGroup: clipped,
    transparencyShapesLayer: transparency,
    layerMaskHidesEffects: layerMask,
    vectorMaskHidesEffects: vectorMask,
    blendIf: {
      channel: blendIf.channel,
      thisLayer: parseRange(blendIf.thisLayer),
      underlying: parseRange(blendIf.underlying),
    },
  });

  const run = (result: { ok: boolean; message?: string; value?: unknown }) => {
    if (result.ok) { setPreview(workflowPreviewOf(result.value)); setMessage(null); }
    else setMessage(result.message ?? "操作失败");
  };

  /**
   * 端点改动统一走这里：文本与滑块写同一份状态，且都用**最新**状态预览，
   * 避免连续拖动时后一次预览用到上一次的闭包值。
   */
  const setRange = (key: "thisLayer" | "underlying", next: string) => {
    const state = { ...blendIf, [key]: next };
    setBlendIf(state);
    run(layers.previewBlending({
      ...params(),
      blendIf: {
        channel: state.channel,
        thisLayer: parseRange(state.thisLayer),
        underlying: parseRange(state.underlying),
      },
    }));
  };
  const toggleSplit = (key: "thisLayer" | "underlying", split: boolean) => {
    const values = parseRange(blendIf[key]);
    if (values.length !== 2 && values.length !== 4) return;
    // 分离：外层端点保持不变，中间新增两个手柄（此刻过渡宽度仍为 0）；合回：取最外两点。
    const next = split
      ? [values[0]!, values[0]!, values.at(-1)!, values.at(-1)!]
      : [values[0]!, values.at(-1)!];
    setRange(key, next.join(","));
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="混合选项" data-blending-panel="true">
      <span className="photo-editor__options-title">混合选项</span>
      <label>
        混合模式
        <select value={blend} disabled={readonly} onChange={(event) => { setBlend(event.currentTarget.value); run(layers.previewBlending(params())); }}>
          {["normal", "multiply", "screen", "overlay", "darken", "lighten", "difference", "hue", "saturation", "color", "luminosity", "pass-through"].map((mode) => <option key={mode} value={mode}>{mode}</option>)}
        </select>
      </label>
      <label>
        挖空
        <select value={knockout} disabled={readonly} onChange={(event) => setKnockout(event.currentTarget.value)}>
          {LAYER_KNOCKOUTS.map((entry) => <option key={entry} value={entry}>{entry === "none" ? "无" : entry === "shallow" ? "浅" : "深"}</option>)}
        </select>
      </label>
      <label>
        混合通道
        <span>
          {["R", "G", "B"].map((channel, index) => (
            <label key={channel}>
              <input type="checkbox" checked={channels[index] ?? true} disabled={readonly}
                onChange={(event) => setChannels((current) => current.map((value, at) => at === index ? event.currentTarget.checked : value))} />
              {channel}
            </label>
          ))}
        </span>
      </label>
      <label>
        Blend If 通道
        <select value={blendIf.channel} disabled={readonly} onChange={(event) => setBlendIf((current) => ({ ...current, channel: event.currentTarget.value }))}>
          <option value="gray">灰度</option>
          <option value="red">红</option>
          <option value="green">绿</option>
          <option value="blue">蓝</option>
        </select>
      </label>
      <BlendIfSliders label="本图层" values={parseRange(blendIf.thisLayer)} readonly={readonly}
        onChange={(values) => setRange("thisLayer", values.join(","))} />
      <BlendIfSliders label="下层" values={parseRange(blendIf.underlying)} readonly={readonly}
        onChange={(values) => setRange("underlying", values.join(","))} />
      <label><input type="checkbox" checked={parseRange(blendIf.thisLayer).length === 4} disabled={readonly}
        onChange={(event) => toggleSplit("thisLayer", event.currentTarget.checked)} />本图层分离端点</label>
      <label><input type="checkbox" checked={parseRange(blendIf.underlying).length === 4} disabled={readonly}
        onChange={(event) => toggleSplit("underlying", event.currentTarget.checked)} />下层分离端点</label>
      <label>本图层端点<input value={blendIf.thisLayer} disabled={readonly} placeholder="0,255 或 30,60,200,235"
        onChange={(event) => setRange("thisLayer", event.currentTarget.value)} /></label>
      <label>下层端点<input value={blendIf.underlying} disabled={readonly} placeholder="0,255 或 30,60,200,235"
        onChange={(event) => setRange("underlying", event.currentTarget.value)} /></label>
      <label><input type="checkbox" checked={interior} disabled={readonly} onChange={(event) => setInterior(event.currentTarget.checked)} />内部效果成组</label>
      <label><input type="checkbox" checked={clipped} disabled={readonly} onChange={(event) => setClipped(event.currentTarget.checked)} />剪贴层成组</label>
      <label><input type="checkbox" checked={transparency} disabled={readonly} onChange={(event) => setTransparency(event.currentTarget.checked)} />透明形状图层</label>
      <label><input type="checkbox" checked={layerMask} disabled={readonly} onChange={(event) => setLayerMask(event.currentTarget.checked)} />图层蒙版隐藏效果</label>
      <label><input type="checkbox" checked={vectorMask} disabled={readonly} onChange={(event) => setVectorMask(event.currentTarget.checked)} />矢量蒙版隐藏效果</label>
      <Button size="sm" tone="primary" disabled={readonly} onClick={() => run(layers.applyBlending(params()))}>应用混合选项</Button>
      <WorkflowPreview preview={preview} title="混合预览" />
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}

/** `0,255` 或 `30,60,200,235` → 端点数组；解析失败返回原文本以外的空数组。 */
function parseRange(text: string): number[] {
  return text.split(",").map((entry) => Number(entry.trim())).filter((value) => Number.isFinite(value));
}

/**
 * Blend If 端点滑块（U60）。
 *
 * 未分离时两个手柄（暗部/高亮）；勾选「分离端点」后变成四个手柄，中间两个决定过渡宽度——
 * 这正是上游「分离端点产生平滑过渡」的输入。拖动只改端点数组，预览仍由面板统一发往内核，
 * 因此还是每一次移动都画出真实合成像素。
 */
export function BlendIfSliders({ label, values, readonly, onChange }: {
  label: string;
  values: number[];
  readonly: boolean;
  onChange: (values: number[]) => void;
}) {
  const handles = values.length === 2 ? values.slice(0, 2) : values.length === 4 ? values.slice(0, 4) : null;
  if (!handles) return null;
  // 非有限值（例如内核回读被截断）按 0 显示：受控滑块不能因为 `undefined` 变成非受控。
  const safe = handles.map((value) => (Number.isFinite(value) ? Math.round(value) : 0));
  const names = safe.length === 4 ? ["暗部", "暗部过渡", "亮部过渡", "高亮"] : ["暗部", "高亮"];
  const set = (index: number, next: number) => {
    if (!Number.isFinite(next)) return;
    // 端点必须单调不减（上游会拒绝交叉），因此在邻居之间夹住，而不是让内核事后报错。
    const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, Math.round(value)));
    const copy = safe.slice();
    const low = index > 0 ? copy[index - 1]! : 0;
    const high = index + 1 < copy.length ? copy[index + 1]! : 255;
    copy[index] = clamp(next, low, high);
    onChange(copy);
  };
  return (
    <fieldset className="photo-editor__blend-if" data-blend-if={label}>
      <legend>{label} Blend If（{safe.length === 4 ? "分离端点" : "合并端点"}）</legend>
      {safe.map((value, index) => (
        <label key={names[index]}>
          {names[index]}
          <input type="range" min={0} max={255} step={1} value={value} disabled={readonly}
            data-blend-if-handle={`${label}-${index}`}
            onChange={(event) => set(index, Number(event.currentTarget.value))} />
          <output>{value}</output>
        </label>
      ))}
    </fieldset>
  );
}

/** 内核 Blend If 通道序号 → 面板通道名（1=R/2=G/3=B/4=A，0=灰度）。 */
function blendChannelName(channel: number): string {
  return channel === 1 ? "red" : channel === 2 ? "green" : channel === 3 ? "blue" : "gray";
}

/** 去边与颜色净化（U62）：预览真实像素，确认一步提交。 */
export function MattingPanel({ controller, readonly, activeLayerId }: { controller: EditorWorkspaceController; readonly: boolean; activeLayerId: number | null }) {
  const layers = controller.features?.layers;
  const [command, setCommand] = useState("layer.matting.defringe");
  const [width, setWidth] = useState(1);
  const [amount, setAmount] = useState(100);
  const [radius, setRadius] = useState(4);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ width: number; height: number; pixels: number[] } | null>(null);
  if (!layers?.matting) return null;

  const params = () => ({
    ...(activeLayerId === null ? {} : { layer: activeLayerId }),
    ...(command === "layer.matting.defringe" ? { width } : {}),
    ...(command === "layer.matting.colorDecontaminate" ? { amount, radius } : {}),
  });
  const run = (result: { ok: boolean; message?: string }) => setMessage(result.ok ? null : result.message ?? "操作失败");

  return (
    <section className="photo-editor__advanced-group" aria-label="去边与净化" data-matting-panel="true">
      <span className="photo-editor__options-title">去边与净化</span>
      <label>
        操作
        <select value={command} disabled={readonly} onChange={(event) => setCommand(event.currentTarget.value)}>
          <option value="layer.matting.defringe">去边…</option>
          <option value="layer.matting.removeBlackMatte">移除黑色杂边</option>
          <option value="layer.matting.removeWhiteMatte">移除白色杂边</option>
          <option value="layer.matting.colorDecontaminate">颜色净化…</option>
        </select>
      </label>
      {command === "layer.matting.defringe" ? (
        <label>宽度<input type="number" min={1} max={200} value={width} disabled={readonly} onChange={(event) => setWidth(Number(event.currentTarget.value))} /></label>
      ) : null}
      {command === "layer.matting.colorDecontaminate" ? (
        <>
          <label>强度<input type="number" min={0} max={100} value={amount} disabled={readonly} onChange={(event) => setAmount(Number(event.currentTarget.value))} /></label>
          <label>半径<input type="number" min={1} max={100} value={radius} disabled={readonly} onChange={(event) => setRadius(Number(event.currentTarget.value))} /></label>
        </>
      ) : null}
      <Button size="sm" disabled={readonly || activeLayerId === null} onClick={() => { const result = layers.matting(command, params(), true); if (result.ok) setPreview(workflowPreviewOf(result.value)); run(result); }}>预览</Button>
      <Button size="sm" tone="primary" disabled={readonly || activeLayerId === null} onClick={() => { const result = layers.matting(command, params(), false); if (result.ok) setPreview(null); run(result); }}>应用</Button>
      <WorkflowPreview preview={preview} title="去边与净化预览" />
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}

/** 图层复合（U64）：可见性/位置/外观快照，切换只恢复声明字段。 */
export function LayerCompPanel({ controller, readonly, revision }: { controller: EditorWorkspaceController; readonly: boolean; revision: number }) {
  const layers = controller.features?.layers;
  const [comps, setComps] = useState<Array<Record<string, unknown>>>([]);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState("");
  const [visibility, setVisibility] = useState(true);
  const [position, setPosition] = useState(true);
  const [appearance, setAppearance] = useState(true);
  const [renameTo, setRenameTo] = useState("");
  const [comment, setComment] = useState("");
  const [warnings, setWarnings] = useState<Array<{ name: string; missingLayers: number[] }>>([]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!layers?.layerComps) return;
    const result = layers.layerComps();
    if (result.ok && isRecord(result.value) && Array.isArray(result.value.comps)) {
      setComps(result.value.comps.filter(isRecord) as Array<Record<string, unknown>>);
    }
  }, [layers, revision]);

  if (!layers?.layerComp) return null;
  const run = (id: string, params: Record<string, unknown>) => {
    const result = layers.layerComp(id, params);
    if (!result.ok) { setMessage(result.message); return; }
    setMessage(null);
    if (isRecord(result.value)) {
      // `updateWarnings` 的 `warnings` 在 result 内，其它命令的复合列表在 `comps` 内。
      const inner = isRecord(result.value.result) ? result.value.result : null;
      if (inner && Array.isArray(inner.warnings)) {
        setWarnings(inner.warnings.filter(isRecord).flatMap((warning) => typeof warning.name === "string" && Array.isArray(warning.missingLayers)
          ? [{ name: warning.name, missingLayers: warning.missingLayers.filter((id): id is number => typeof id === "number") }]
          : []));
      }
      if (isRecord(result.value.comps) && Array.isArray(result.value.comps.comps)) {
        setComps(result.value.comps.comps.filter(isRecord) as Array<Record<string, unknown>>);
      }
    }
  };
  // 选中复合的规范快照：按可见性/位置/外观裁剪，`null` 表示切换时不动该字段。
  const selectedComp = comps.find((comp) => comp.name === selected);
  const snapshot = useMemo(() => {
    if (!selectedComp || !Array.isArray(selectedComp.snapshot)) return null;
    const entries = new Map<number, string>();
    for (const row of selectedComp.snapshot) {
      if (!isRecord(row) || typeof row.layer !== "number") continue;
      const fields = [
        row.visible === null ? null : `可见=${row.visible}`,
        row.position === null ? null : `位置=${JSON.stringify(row.position)}`,
        row.appearance === null ? null : "外观",
      ].filter(Boolean).join(" ");
      entries.set(row.layer, fields);
    }
    return entries.size ? entries : null;
  }, [selectedComp]);

  /**
   * 交付规范快照（U64 的「导出」）。
   *
   * 上游 `file.export.layerCompsToFiles` 需要写目录，浏览器宿主没有目录权限；因此导出走
   * 宿主已有的下载通道：把 `layerComps()` 的**权威快照**序列化成 JSON 交给浏览器下载，
   * 既不重新计算也不改写文档，取消/失败都不会动文档与历史。
   */
  const exportSnapshot = () => {
    if (comps.length === 0) { setMessage("还没有可导出的图层复合"); return; }
    const payload = {
      format: "photocraft-layer-comps",
      version: 1,
      comps: comps.map((comp) => ({
        id: comp.id,
        name: comp.name,
        comment: comp.comment ?? "",
        visibility: comp.visibility === true,
        position: comp.position === true,
        appearance: comp.appearance === true,
        missingLayers: Array.isArray(comp.missingLayers) ? comp.missingLayers : [],
        snapshot: Array.isArray(comp.snapshot) ? comp.snapshot : [],
      })),
    };
    try {
      if (typeof URL?.createObjectURL !== "function") throw new Error("当前环境不支持下载");
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "photocraft-layer-comps.json";
      link.click();
      URL.revokeObjectURL(url);
      setMessage(null);
    } catch (reason) {
      setMessage(`导出失败：${reason instanceof Error ? reason.message : String(reason)}`);
    }
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="图层复合" data-layer-comp-panel="true">
      <span className="photo-editor__options-title">图层复合</span>
      <label>名称<input value={name} maxLength={200} disabled={readonly} placeholder="新复合名称" onChange={(event) => setName(event.currentTarget.value)} /></label>
      <label><input type="checkbox" checked={visibility} disabled={readonly} onChange={(event) => setVisibility(event.currentTarget.checked)} />记录可见性</label>
      <label><input type="checkbox" checked={position} disabled={readonly} onChange={(event) => setPosition(event.currentTarget.checked)} />记录位置</label>
      <label><input type="checkbox" checked={appearance} disabled={readonly} onChange={(event) => setAppearance(event.currentTarget.checked)} />记录外观</label>
      <Button size="sm" disabled={readonly} onClick={() => run("layerComp.new", { name: name.trim(), visibility, position, appearance })}>新建复合</Button>
      <label>
        复合
        <select value={selected} disabled={readonly || comps.length === 0} onChange={(event) => setSelected(event.currentTarget.value)}>
          <option value="">选择复合</option>
          {comps.map((comp) => <option key={String(comp.id)} value={String(comp.name)}>{String(comp.name)}{Array.isArray(comp.missingLayers) && comp.missingLayers.length ? `（缺 ${comp.missingLayers.length} 层）` : ""}</option>)}
        </select>
      </label>
      <Button size="sm" disabled={readonly || !selected} onClick={() => run("layerComp.apply", { comp: selected })}>切换</Button>
      <Button size="sm" disabled={readonly || !selected} onClick={() => run("layerComp.update", { comp: selected, what: "all" })}>更新</Button>
      <Button size="sm" disabled={readonly || !selected} onClick={() => run("layerComp.duplicate", { comp: selected })}>复制</Button>
      <Button size="sm" disabled={readonly || !selected} onClick={() => run("layerComp.delete", { comp: selected })}>删除</Button>
      <Button size="sm" tone="ghost" disabled={readonly} onClick={() => run("layerComp.previous", {})}>上一个</Button>
      <Button size="sm" tone="ghost" disabled={readonly} onClick={() => run("layerComp.next", {})}>下一个</Button>
      <span className="photo-editor__option-hint">复合属性</span>
      <label>改名为<input value={renameTo} maxLength={200} disabled={readonly || !selected} placeholder="新名称" onChange={(event) => setRenameTo(event.currentTarget.value)} /></label>
      <Button size="sm" disabled={readonly || !selected || !renameTo.trim()} onClick={() => { run("layerComp.rename", { comp: selected, name: renameTo.trim() }); setSelected(renameTo.trim()); }}>重命名</Button>
      <label>注释<input value={comment} maxLength={2000} disabled={readonly || !selected} placeholder="备注" onChange={(event) => setComment(event.currentTarget.value)} /></label>
      <Button size="sm" disabled={readonly || !selected} onClick={() => run("layerComp.setComment", { comp: selected, comment })}>保存注释</Button>
      <Button size="sm" disabled={readonly || !selected} onClick={() => run("layerComp.setOptions", { comp: selected, visibility, position, appearance })}>保存选项</Button>
      <Button size="sm" tone="ghost" disabled={readonly} onClick={() => run("layerComp.restoreLastDocumentState", {})}>恢复上次状态</Button>
      <Button size="sm" tone="ghost" disabled={readonly} onClick={() => run("layerComp.updateWarnings", selected ? { comp: selected } : {})}>检查缺失层</Button>
      <Button size="sm" tone="ghost" disabled={comps.length === 0} onClick={exportSnapshot}>导出快照 JSON</Button>
      {warnings.length ? <p className="photo-editor__option-hint">{warnings.map((warning) => `${warning.name}：缺 ${warning.missingLayers.length} 层`).join("；")}</p> : null}
      {snapshot ? (
        <p className="photo-editor__option-hint" data-comp-snapshot="true">
          快照：{[...snapshot.entries()].slice(0, 3).map(([id, fields]) => `#${id} ${fields}`).join("，")}
          {snapshot.size > 3 ? ` …共 ${snapshot.size} 层` : ""}
        </p>
      ) : null}
      {comps.some((comp) => Array.isArray(comp.missingLayers) && comp.missingLayers.length) ? (
        <p className="photo-editor__option-hint">部分复合引用了已删除的图层：切换时这些层被跳过，可更新复合以清除引用。</p>
      ) : null}
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}

/**
 * 样式预设管理（U61）：列出/保存/整理/恢复默认。
 *
 * 预设属于**会话偏好**，不是文档内容：这里所有操作都不调用内容刷新，成功与否只看返回的
 * `presetsRevision`。上游 `style.presets.*` 早已存在，缺的只是本域入口——之前只能「应用」
 * 一份预设，用户无法先保存自己的一份。
 */
export function StylePresetPanel({ controller, readonly, activeLayerId }: { controller: EditorWorkspaceController; readonly: boolean; activeLayerId: number | null }) {
  const layers = controller.features?.layers;
  const [groups, setGroups] = useState<Array<{ name: string; presets: Array<{ name: string }> }>>([]);
  const [preset, setPreset] = useState("");
  const [name, setName] = useState("");
  const [scale, setScale] = useState(100);
  const [target, setTarget] = useState<number | null>(null);
  const [effectKind, setEffectKind] = useState("dropShadow");
  const [defaults, setDefaults] = useState<{ kind: string; params: string; user: boolean } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  /** 可选的样式目标层：来自最新视图模型，避免发一个已删除的 id 让内核报「图层不存在」。 */
  const layerOptions = (controller.currentView?.().document?.layers ?? []).map((row) => ({ id: row.id, name: row.name }));

  const load = () => {
    const result = layers?.stylePresets?.("style.presets.list", {});
    if (!result || !result.ok) { setMessage(result && !result.ok ? result.message : "预设列表不可用"); return; }
    const value = result.value;
    if (!isRecord(value) || !isRecord(value.presets) || !Array.isArray(value.presets.groups)) { setGroups([]); return; }
    setGroups(value.presets.groups.filter(isRecord).map((group) => ({
      name: String(group.name ?? ""),
      presets: Array.isArray(group.presets) ? group.presets.filter(isRecord).map((entry) => ({ name: String(entry.name ?? "") })) : [],
    })));
    setMessage(null);
  };

  useEffect(() => { load(); /* 只在挂载时读一次偏好库 */ }, [layers]);

  if (!layers?.stylePresets) return null;
  const run = (id: string, params: Record<string, unknown>) => {
    const result = layers.stylePresets!(id, params);
    if (!result.ok) { setMessage(result.message); return; }
    setMessage(null);
    load();
  };
  /** 样式跨层动作（拷贝/粘贴/清除/缩放/转层/栅格化）：一步提交，走真实文档命令。 */
  const style = (id: string, params: Record<string, unknown>) => {
    const result = layers.layerCommand(id, params);
    setMessage(result.ok ? null : result.message ?? "操作失败");
  };
  const names = groups.flatMap((group) => group.presets.map((entry) => entry.name));
  /** 效果默认值（`defaultFor`/`makeDefault`）：会话偏好，读回后可直接编辑再保存。 */
  const loadDefault = (kind: string) => {
    const result = layers.stylePresets!("layer.layerStyle.defaultFor", { kind });
    if (!result.ok) { setMessage(result.message); setDefaults(null); return; }
    const presets = isRecord(result.value) && isRecord(result.value.presets) ? result.value.presets : null;
    const params = presets && isRecord(presets.params) ? presets.params : null;
    if (!params) { setDefaults(null); return; }
    setDefaults({ kind, params: JSON.stringify(params, null, 2), user: presets!.user === true });
    setMessage(null);
  };
  const saveDefault = () => {
    if (!defaults) return;
    let params: unknown;
    try { params = JSON.parse(defaults.params); } catch { setMessage("默认参数不是合法 JSON"); return; }
    if (!isRecord(params)) { setMessage("默认参数必须是 JSON 对象"); return; }
    const result = layers.stylePresets!("layer.layerStyle.makeDefault", { kind: defaults.kind, params });
    if (!result.ok) { setMessage(result.message); return; }
    setMessage(null);
    loadDefault(defaults.kind);
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="样式预设" data-style-preset-panel="true">
      <span className="photo-editor__options-title">样式预设</span>
      <span className="photo-editor__option-hint">跨层应用</span>
      <Button size="sm" disabled={readonly || activeLayerId === null} onClick={() => activeLayerId !== null && style("layer.layerStyle.copyLayerStyle", { layer: activeLayerId })}>拷贝样式</Button>
      <Button size="sm" disabled={readonly || activeLayerId === null} onClick={() => activeLayerId !== null && style("layer.layerStyle.pasteLayerStyle", { layer: activeLayerId })}>粘贴样式</Button>
      <Button size="sm" disabled={readonly || activeLayerId === null} onClick={() => activeLayerId !== null && style("layer.layerStyle.clear", { layer: activeLayerId })}>清除样式</Button>
      <label>缩放 %<input type="number" min={1} max={1000} value={scale} disabled={readonly} onChange={(event) => setScale(Number(event.currentTarget.value))} /></label>
      <Button size="sm" disabled={readonly || activeLayerId === null} onClick={() => activeLayerId !== null && style("layer.layerStyle.scaleEffects", { layer: activeLayerId, scale })}>缩放效果</Button>
      <Button size="sm" disabled={readonly || activeLayerId === null} onClick={() => activeLayerId !== null && style("layer.layerStyle.createLayer", { layer: activeLayerId })}>效果转层</Button>
      <Button size="sm" disabled={readonly || activeLayerId === null} onClick={() => activeLayerId !== null && style("layer.rasterize.layerStyle", { layer: activeLayerId })}>样式栅格化</Button>
      <span className="photo-editor__option-hint">预设管理</span>
      <label>
        预设
        <select value={preset} disabled={readonly || names.length === 0} onChange={(event) => setPreset(event.currentTarget.value)}>
          <option value="">选择预设</option>
          {names.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
        </select>
      </label>
      <label>新名称<input value={name} maxLength={200} disabled={readonly} placeholder="另存为…" onChange={(event) => setName(event.currentTarget.value)} /></label>
      <Button size="sm" tone="primary" disabled={readonly || !preset || activeLayerId === null} onClick={() => activeLayerId !== null && style("style.presets.apply", { preset, layer: activeLayerId })}>应用预设</Button>
      <Button size="sm" disabled={readonly || activeLayerId === null} onClick={() => run("style.presets.new", { name: name.trim(), ...(activeLayerId === null ? {} : { layer: activeLayerId }) })}>从当前层保存</Button>
      <Button size="sm" disabled={readonly || !preset || !name.trim()} onClick={() => { run("style.presets.edit", { action: "rename", preset, name: name.trim() }); setPreset(name.trim()); }}>重命名</Button>
      <Button size="sm" disabled={readonly || !preset} onClick={() => { run("style.presets.edit", { action: "delete", preset }); setPreset(""); }}>删除</Button>
      <Button size="sm" tone="ghost" disabled={readonly} onClick={() => run("style.presets.reset", {})}>恢复默认</Button>
      <span className="photo-editor__option-hint">效果移到别的图层</span>
      <label>
        目标层
        <select value={target === null ? "" : String(target)} disabled={readonly || layerOptions.length === 0} data-style-target="true"
          onChange={(event) => setTarget(event.currentTarget.value === "" ? null : Number(event.currentTarget.value))}>
          <option value="">选择目标层</option>
          {layerOptions.map((row) => <option key={row.id} value={row.id}>{row.name || `图层 ${row.id}`}</option>)}
        </select>
      </label>
      <Button size="sm" disabled={readonly || activeLayerId === null || target === null || target === activeLayerId}
        onClick={() => activeLayerId !== null && target !== null && style("layer.layerStyle.transferEffects", { from: activeLayerId, to: target, copy: true })}>复制效果到目标层</Button>
      <Button size="sm" disabled={readonly || activeLayerId === null || target === null || target === activeLayerId}
        onClick={() => activeLayerId !== null && target !== null && style("layer.layerStyle.transferEffects", { from: activeLayerId, to: target, copy: false })}>移动效果到目标层</Button>
      <span className="photo-editor__option-hint">效果默认值（会话偏好，不改文档）</span>
      <label>
        效果种类
        <select value={effectKind} disabled={readonly} onChange={(event) => { setEffectKind(event.currentTarget.value); setDefaults(null); }}>
          {LAYER_EFFECT_KINDS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </label>
      <Button size="sm" disabled={readonly} onClick={() => loadDefault(effectKind)}>读取默认值</Button>
      {defaults ? (
        <>
          <p className="photo-editor__option-hint">{defaults.user ? "当前为用户默认（可改）" : "当前为出厂默认"}</p>
          <textarea className="photo-editor__effect-defaults" rows={6} value={defaults.params} disabled={readonly} data-effect-defaults={defaults.kind}
            onChange={(event) => setDefaults({ ...defaults, params: event.currentTarget.value })} />
          <Button size="sm" tone="primary" disabled={readonly} onClick={saveDefault}>设为该效果默认</Button>
        </>
      ) : null}
      {names.length === 0 ? <p className="photo-editor__option-hint">预设库为空，可先「从当前层保存」创建一份。</p> : null}
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}
