import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import { isRecord, supports } from "../shared/panels.js";
import { ADJUSTMENT_LABELS, type AdjustmentKind } from "./tool-parameters.js";
import { KindParameters } from "./direct-adjustment-panel.js";

// ---------------------------------------------------------------- 直方图（任务 7.2）

export type HistogramState = {
  channels: number[][];
  samples: number;
  source: "layer" | "composite";
  channel: "rgb" | "luminance";
  generation: number;
};

/** 解码内核直方图；非法结构返回 null（不显示半截图）。 */
export function decodeHistogram(input: unknown): HistogramState | null {
  if (!isRecord(input) || !Array.isArray(input.channels)) return null;
  if (input.channels.length !== 3) return null;
  const channels: number[][] = [];
  for (const bins of input.channels) {
    if (!Array.isArray(bins) || bins.length !== 256) return null;
    if (!bins.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return null;
    channels.push(bins as number[]);
  }
  const source = input.source === "layer" ? "layer" : "composite";
  const channel = input.channel === "luminance" ? "luminance" : "rgb";
  return {
    channels,
    samples: typeof input.samples === "number" ? input.samples : 0,
    source,
    channel,
    generation: typeof input.generation === "number" ? input.generation : 0
  };
}

/** 直方图绘制：三条通道曲线（亮度模式只显示一条）。 */
export function HistogramGraph({ state, width = 256, height = 80 }: { state: HistogramState | null; width?: number; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, width, height);
    if (!state) return;
    const colors = state.channel === "luminance"
      ? ["#b9b9b9"]
      : ["#e05252", "#52b46b", "#5b8ce0"];
    const peak = Math.max(1, ...state.channels.flat());
    state.channels.forEach((bins, index) => {
      if (state.channel === "luminance" && index > 0) return;
      context.strokeStyle = colors[index] ?? "#999";
      context.beginPath();
      bins.forEach((value, bin) => {
        const x = (bin / 255) * width;
        const y = height - (value / peak) * (height - 2);
        if (bin === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
    });
  }, [state, width, height]);
  return <canvas ref={ref} width={width} height={height} className="photo-editor__histogram" data-histogram={state?.channel ?? "none"} />;
}

/** 直方图面板：目标与通道切换；迟到结果按代际丢弃。 */
export function HistogramPanel({ controller, readonly }: { controller: EditorWorkspaceController; readonly: boolean }) {
  const [source, setSource] = useState<"layer" | "composite">("composite");
  const [channel, setChannel] = useState<"rgb" | "luminance">("rgb");
  const [state, setState] = useState<HistogramState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const request = useRef(0);

  const sample = useCallback(() => {
    if (!supports(controller, "histogram")) return;
    const generation = ++request.current;
    const result = controller.histogram({ source, channel });
    if (generation !== request.current) return;
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    const decoded = decodeHistogram(result.value);
    if (!decoded) {
      setMessage("直方图响应无效");
      return;
    }
    setMessage(null);
    setState(decoded);
  }, [controller, source, channel]);

  useEffect(() => {
    sample();
  }, [sample]);

  if (!supports(controller, "histogram")) return null;
  return (
    <section className="photo-editor__histogram-panel" data-histogram-panel="true">
      <header>
        <span>直方图</span>
        <select value={source} disabled={readonly} onChange={(event) => setSource(event.currentTarget.value as "layer" | "composite")} aria-label="直方图来源">
          <option value="composite">可见合成</option>
          <option value="layer">当前层</option>
        </select>
        <select value={channel} disabled={readonly} onChange={(event) => setChannel(event.currentTarget.value as "rgb" | "luminance")} aria-label="直方图通道">
          <option value="rgb">RGB</option>
          <option value="luminance">亮度</option>
        </select>
      </header>
      <HistogramGraph state={state} />
      <p className="photo-editor__brush-note">
        {state ? `${state.samples} 个样本 · 修订 ${state.generation}` : "采样中"}
        {message ? ` · ${message}` : ""}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- 调色（任务 7.1）

/** P5 新增调整层的参数编辑（色阶／自然饱和度／黑白），复用同一草稿协议。 */
/**
 * 已有调整层的参数编辑：覆盖本域实现的**全部**逐类调整（与 `direct_adjustment::ADJUSTMENT_KINDS`
 * 同一套类型），复用直接调整面板的同一批参数控件与默认值，不维护第二套范围表。
 *
 * 参数合并成一次 `layer.setAdjustment`：直接调整是「提交时落一笔像素」，调整层是「改可重编层」，
 * 两条路径共用参数语义，只有落点不同。
 */
export function AdvancedAdjustmentPanel({
  endpoint,
  readonly,
  onApply
}: {
  endpoint: EditorWorkspaceController;
  readonly: boolean;
  onApply: () => void;
}) {
  const snapshot = endpoint.snapshot();
  const document = snapshot.view.document;
  const active = document?.layers.find((layer) => layer.id === document.activeLayerId) ?? null;
  const kind = active?.adjustment ?? null;
  const params = active?.adjustmentParams ?? null;
  const [message, setMessage] = useState<string | null>(null);

  // 只有本域实现的逐类调整可重编；LUT 等范围外的类型即使被导入也不渲染半截图控件。
  if (!kind || !(kind in ADJUSTMENT_LABELS)) return null;

  const run = (patch: Record<string, unknown>) => {
    const result = endpoint.dispatch("layer.setAdjustment", { layer: active?.id, ...patch });
    setMessage(result.ok ? null : result.message);
    if (result.ok) onApply();
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="高级调整" data-advanced-adjustment={kind}>
      <span className="photo-editor__options-title">{ADJUSTMENT_LABELS[kind as AdjustmentKind] ?? kind}</span>
      <KindParameters
        kind={kind as AdjustmentKind}
        values={params ?? {}}
        disabled={readonly}
        foreground="#ffffff"
        endpoint={endpoint}
        onChange={run}
      />
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}
