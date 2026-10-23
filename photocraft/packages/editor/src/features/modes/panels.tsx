import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../ui/Button.js";
import type { FeaturePanelContext } from "../panel-context.js";
import {
  BITMAP_METHODS,
  COLOR_TABLE_PRESETS,
  DUOTONE_TYPES,
  HALFTONE_SHAPES,
  IMAGE_MODE_LIMITS,
  IMAGE_MODE_TARGETS,
  INDEXED_DITHER,
  INDEXED_FORCED,
  INDEXED_PALETTES,
  MODE_LABELS,
  modeExportAvailability,
  unsupportedModeTools,
  type ImageModeInfo,
  type ImageModeInk,
  type ImageModePlan,
  type ImageModeReport,
  type ImageModeTarget,
  type ModeParams
} from "./mode-data.js";
import type { createSession } from "./workspace.js";

/**
 * 图像模式与调色板面板
 * （change: 2026-10-22-add-photocraft-image-mode-workflows，任务 2.1 / design D1/D3）。
 *
 * 界面只做「选目标 → 填参数 → 预览 → 确认」，没有长草稿：
 *
 * - 预览在独立会话里算完整转换，正式文档、修订与历史都不动；
 * - **任何参数改动都作废当前预览**，必须重新预览才能确认，非法最后输入不会提交旧候选；
 * - 确认时把预览的 `baseRevision`/`baseContentHash` 交回内核，文档已经变化即拒绝并提示重来。
 *
 * 所有模式数据来自本域内核入口（`modeInfo`），界面不推断模式，也不复制颜色表/油墨。
 */

type ModeSession = ReturnType<typeof createSession>;
type ModesFeature = { readonly modes?: ModeSession };

/** 导出矩阵的一句话摘要：哪些目标能表达当前模式、哪些保持关闭及原因。 */
function exportSummary(mode: ImageModeInfo["mode"]): string {
  const targets: { id: "psd" | "png" | "project"; label: string }[] = [
    { id: "psd", label: "PSD" },
    { id: "png", label: "PNG" },
    { id: "project", label: "工程" }
  ];
  return "导出：" + targets.map(({ id, label }) => {
    const availability = modeExportAvailability(mode, id);
    // 未判定（范围外颜色模型）不能写成「可用」：那会替共享编码器承诺结果。
    if (!availability.assessed) return `${label} 不做判定（${availability.reason}）`;
    return availability.enabled ? `${label} 可用` : `${label} 关闭（${availability.reason}）`;
  }).join(" · ");
}

/** 本域会话；精简宿主或测试替身缺该端口时整块面板不渲染（design D11）。 */
function modeSession(controller: FeaturePanelContext["controller"]): ModeSession | null {
  const modes = (controller as unknown as { features?: ModesFeature }).features?.modes;
  return modes && typeof modes.modeInfo === "function" ? modes : null;
}

const TYPE_LABELS = MODE_LABELS;

const BITMAP_LABELS: Record<string, string> = { diffusion: "扩散仿色", threshold: "阈值", pattern: "图案仿色", halftone: "半调网屏" };
const SHAPE_LABELS: Record<string, string> = { round: "圆", ellipse: "椭圆", line: "直线", square: "方形", diamond: "菱形", cross: "十字" };
const PALETTE_LABELS: Record<string, string> = {
  selective: "可感知（选择性）",
  perceptual: "可感知",
  adaptive: "随样性",
  exact: "精确",
  systemMac: "Mac OS 系统",
  systemWindows: "Windows 系统",
  web: "Web 216 色",
  uniform: "平均分布"
};
const FORCED_LABELS: Record<string, string> = { blackWhite: "黑白", none: "无", primaries: "原色", web: "Web" };
const DITHER_LABELS: Record<string, string> = { diffusion: "扩散", none: "无", pattern: "图案", noise: "杂色" };
const DUOTONE_LABELS: Record<string, string> = { monotone: "单色调", duotone: "双色调", tritone: "三色调", quadtone: "四色调" };
const TABLE_LABELS: Record<string, string> = {
  custom: "自定义",
  blackBody: "黑体",
  grayscale: "灰度",
  spectrum: "光谱",
  systemMac: "Mac OS 系统",
  systemWindows: "Windows 系统",
  web: "Web"
};
const DROPPED_LABELS: Record<string, string> = {
  raster: "像素层",
  group: "图层组",
  adjustment: "调整层",
  fill: "填充层",
  text: "文字层",
  shape: "形状层",
  smart: "智能对象"
};
const TOOL_LABELS: Record<string, string> = {
  move: "移动",
  marquee: "矩形选框",
  lasso: "套索",
  wand: "魔棒",
  quick: "快速选择",
  brush: "画笔",
  eraser: "橡皮",
  text: "文字",
  clone: "仿制图章",
  heal: "修复",
  retouch: "修饰",
  pen: "钢笔"
};

function inkCount(type: string): number {
  return type === "monotone" ? 1 : type === "duotone" ? 2 : type === "tritone" ? 3 : 4;
}

/**
 * 双色调类型对应的默认油墨（仅用于**新建**双色调，或用户主动增加油墨数量时补位）。
 *
 * 名字、颜色与默认曲线逐项取自内核 `mode_cmds::default_inks`（`Black #000000`、`Warm Brown
 * #9e612e`、`Gold #dbad2e`、`Slate Blue #456194`，曲线为恒等两点），这样从界面新建的双色调与
 * 内核默认值一致。油墨是真实持久内容，编辑既有文档时必须用文档里的油墨（见 `duotoneState`）。
 */
function defaultInks(type: string): ImageModeInk[] {
  const palette = [
    { name: "Black", color: "#000000" },
    { name: "Warm Brown", color: "#9e612e" },
    { name: "Gold", color: "#dbad2e" },
    { name: "Slate Blue", color: "#456194" }
  ];
  return palette.slice(0, inkCount(type)).map((ink) => ({ ...ink, curve: [[0, 0], [100, 100]] as [number, number][] }));
}

/**
 * 由只读信息推导双色调编辑器的初始状态。
 *
 * 已经是双色调的文档必须沿用 `info.duotone.inks`（含名称、颜色与曲线）：否则打开面板再点确认
 * 会把用户的真实油墨静默替换成界面默认值，那不是「编辑」而是覆盖。
 */
function duotoneState(info: ImageModeInfo | null): { type: string; inks: ImageModeInk[] } {
  const inks = info?.duotone?.inks;
  if (!inks || inks.length === 0) return { type: "duotone", inks: defaultInks("duotone") };
  const type = inks.length === 1 ? "monotone" : inks.length === 2 ? "duotone" : inks.length === 3 ? "tritone" : "quadtone";
  return { type, inks: inks.map((ink) => ({ name: ink.name, color: ink.color, curve: ink.curve.map((point) => [...point] as [number, number]) })) };
}

/** 报告里的结构损失：图层拼合与丢弃的分类型计数。 */
export function modeLossText(report: ImageModeReport): string {
  const parts: string[] = [];
  if (report.flattened) parts.push(`图层 ${report.layersBefore} → ${report.layersAfter}`);
  const dropped = Object.entries(report.dropped).map(([kind, count]) => `${DROPPED_LABELS[kind] ?? kind} ${count}`);
  if (dropped.length) parts.push(`丢弃 ${dropped.join("、")}`);
  if (report.colorCount !== null) parts.push(`${report.colorCount} 色`);
  if (report.transparentIndex !== null) parts.push(`透明索引 ${report.transparentIndex}`);
  if (!parts.length) parts.push("结构不变");
  return parts.join(" · ");
}

/** 预览像素画在面板自带的 canvas 上（不走共享预览通道，正式文档没有候选像素）。 */
function ModePixelPreview({ plan }: { plan: ImageModePlan }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    canvas.width = plan.preview.width;
    canvas.height = plan.preview.height;
    const image = new ImageData(new Uint8ClampedArray(plan.preview.pixels), plan.preview.width, plan.preview.height);
    context.putImageData(image, 0, 0);
  }, [plan]);
  return (
    <div className="photo-editor__advanced-group" data-mode-preview="true">
      <canvas
        ref={ref}
        style={{ maxWidth: "100%", maxHeight: 180, imageRendering: "pixelated", background: "#1b1b1b", display: "block" }}
      />
      <span className="photo-editor__option-hint">{plan.preview.width} × {plan.preview.height} 预览</span>
    </div>
  );
}

function ReportLines({ report, hint }: { report: ImageModeReport; hint: string }) {
  return (
    <dl className="photo-editor__geometry-properties" data-mode-report={report.target}>
      <dt>目标</dt><dd>{report.label}{report.fromMode ? `（${TYPE_LABELS[report.fromMode] ?? report.fromMode}）` : ""}</dd>
      <dt>深度</dt><dd>{report.depth} 位/通道</dd>
      <dt>{hint}</dt><dd>{modeLossText(report)}</dd>
      {report.lossy ? <><dt>损失</dt><dd>不可逆的量化或拼合，确认后一步历史可撤销</dd></> : null}
      {report.inks?.length ? <><dt>油墨</dt><dd>{report.inks.map((ink) => `${ink.name} ${ink.color}`).join("、")}</dd></> : null}
    </dl>
  );
}

function ReportNotes({ report }: { report: ImageModeReport }) {
  return (
    <>
      {report.notes.map((note) => <p key={note} className="photo-editor__brush-note">{note}</p>)}
      {!report.changed ? <p className="photo-editor__brush-note">这次转换与当前状态一致，确认不会新增历史。</p> : null}
    </>
  );
}

// ------------------------------------------------------------------ 油墨曲线

function InkCurveEditor({ ink, disabled, onChange }: { ink: ImageModeInk; disabled: boolean; onChange: (curve: [number, number][]) => void }) {
  const setPoint = (index: number, axis: 0 | 1, value: number) => {
    const next = ink.curve.map((point) => [...point] as [number, number]);
    next[index][axis] = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
    onChange(next);
  };
  /**
   * 与「删除」同一类约束：内核只在点数 ≥2 时采用曲线，1 点会被**静默**换成恒等曲线。
   * 从空曲线或单点添点时一次补到可保存的形状，界面才不会留下内核并不使用的点。
   */
  const addPoint = () => {
    if (ink.curve.length < 2) return onChange([[0, 0], [100, 100]]);
    onChange([...ink.curve, [0, 0]]);
  };
  return (
    <div className="photo-editor__advanced-group" data-ink-curve={ink.name}>
      <span className="photo-editor__option-hint">油墨曲线（输入 % → 输出 %，最多 {IMAGE_MODE_LIMITS.maxInkCurvePoints} 点）</span>
      {ink.curve.map((point, index) => (
        <div key={index}>
          <label>
            输入
            <input type="number" min={0} max={100} value={point[0]} disabled={disabled} onChange={(event) => setPoint(index, 0, Number(event.currentTarget.value))} />
          </label>
          <label>
            输出
            <input type="number" min={0} max={100} value={point[1]} disabled={disabled} onChange={(event) => setPoint(index, 1, Number(event.currentTarget.value))} />
          </label>
          <Button
            size="sm"
            tone="ghost"
            disabled={disabled}
            // 内核的 `parse_inks` 只在曲线点数 ≥2 时采用它，1 点会**静默**退回恒等曲线：
            // 界面上留着的那一个点就变成了假状态。删到不足 2 点时显式清空，让界面与结果一致。
            onClick={() => {
              const next = ink.curve.filter((_, at) => at !== index);
              onChange(next.length >= 2 ? next : []);
            }}
          >删除</Button>
        </div>
      ))}
      <Button
        size="sm"
        tone="ghost"
        disabled={disabled || ink.curve.length >= IMAGE_MODE_LIMITS.maxInkCurvePoints}
        onClick={addPoint}
      >加点</Button>
      <p className="photo-editor__option-hint">少于 2 个控制点按恒等映射处理（内核会改用默认曲线）；曲线只影响显示与导出，不改像素。</p>
    </div>
  );
}

// ------------------------------------------------------------------ 模式面板

export function ModesPanel({ controller, locked, documentView, refreshPreview, setMessage: reportHostMessage }: FeaturePanelContext) {
  const session = modeSession(controller);
  const [info, setInfo] = useState<ImageModeInfo | null>(null);
  const [target, setTarget] = useState<ImageModeTarget>("grayscale");
  const [bitmap, setBitmap] = useState({ method: "diffusion", frequency: 53, angle: 45, shape: "round" });
  const [indexed, setIndexed] = useState({ palette: "selective", colors: 256, forced: "blackWhite", dither: "diffusion", amount: 75, transparency: true });
  const [duotone, setDuotone] = useState(() => duotoneState(null));
  const [modePlan, setModePlan] = useState<ImageModePlan | null>(null);
  const [tablePlan, setTablePlan] = useState<ImageModePlan | null>(null);
  const [tableDraft, setTableDraft] = useState<{ preset: string; colors: string[]; transparent: number | null; index: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const revision = documentView?.revision ?? null;
  // 归属键：修订号在多文档之间会重复（两份新文档都是修订 1），名称/尺寸也可能相同；
  // 加上宿主文档 id 与代际才能把「切到另一份同规格文档」「关闭后重开同一节点」都判成换文档
  // （change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.3）。
  const owner = controller.documentOwner?.() ?? null;
  const ownerKey = owner ? `${owner.documentId ?? "-"}#${owner.generation}` : "-";
  const documentKey = documentView
    ? `${ownerKey}|${documentView.name}|${documentView.width}x${documentView.height}`
    : null;
  /** 目标自动纠正只对每个「文档 + 模式」做一次，免得反复顶掉用户特意选中来读原因的目标。 */
  const correctedKey = useRef<string | null>(null);

  /** 每次刷新都重新取只读信息；切文档或修订变化后旧报告不再展示。 */
  useEffect(() => {
    if (!session) return;
    const result = session.modeInfo();
    if (!result.ok) {
      setInfo(null);
      setMessage(result.message);
      return;
    }
    setInfo(result.value);
    setMessage(null);
    setModePlan(null);
    setTablePlan(null);
    // 打开只读信息时若选中的目标本身不可用（例如灰度文档默认选中的就是「灰度」），预览一进来
    // 就是禁用状态，看起来像坏掉了。换成第一个可用目标。只在文档/模式首次变化时纠正，
    // 同一文档后续编辑不会把用户特意选中来读原因的目标顶掉。
    const key = `${documentKey}|${result.value.mode}|${result.value.rawMode}`;
    if (correctedKey.current !== key) {
      correctedKey.current = key;
      setTarget((current) => {
        const selected = result.value.targets.find((entry) => entry.id === current);
        if (selected?.available) return current;
        const first = result.value.targets.find((entry) => entry.available);
        return first ? (first.id as ImageModeTarget) : current;
      });
    }
  }, [session, revision, documentKey]);

  /** 索引色的颜色表随只读信息同步；用户改动保留在本地草稿里。 */
  useEffect(() => {
    if (!info?.colorTable) {
      setTableDraft(null);
      return;
    }
    setTableDraft({ preset: "custom", colors: [...info.colorTable.colors], transparent: info.colorTable.transparent, index: 0 });
  }, [info]);

  /**
   * 双色调油墨以文档为准：打开已有的双色调文档时载入它真实的油墨（名称/颜色/曲线）。
   * 没有这一步，点一次确认就会把用户油墨换成界面默认值。
   */
  useEffect(() => {
    if (!info?.duotone) return;
    setDuotone(duotoneState(info));
  }, [info]);

  const params = useCallback((): ModeParams => {
    switch (target) {
      case "bitmap":
        return { ...bitmap };
      case "indexed":
        return { ...indexed };
      case "duotone":
        return { type: duotone.type, inks: duotone.inks.map((ink) => ({ name: ink.name, color: ink.color, curve: ink.curve })) };
      default:
        return {};
    }
  }, [target, bitmap, indexed, duotone]);

  // 任一参数变化都让当前预览失效：确认时只能提交刚刚预览过的参数。
  useEffect(() => {
    setModePlan(null);
  }, [params]);

  const tableParams = useCallback((): ModeParams => {
    if (!tableDraft) return {};
    return tableDraft.preset === "custom"
      ? { colors: tableDraft.colors, transparent: tableDraft.transparent }
      : { table: tableDraft.preset, transparent: tableDraft.transparent };
    // 依赖只有真正的转换参数：`index` 是「当前在编辑哪一格」的界面选择，不参与转换。
    // 若把整个 `tableDraft` 当依赖，预览后点一下别的色块就会重建参数对象、作废刚算好的
    // 预览并把「确认颜色表」变灰——用户看到的是一次莫名其妙的失效。
  }, [tableDraft?.preset, tableDraft?.colors, tableDraft?.transparent]);

  useEffect(() => {
    setTablePlan(null);
  }, [tableParams]);

  if (!session) return null;

  const readOnly = locked || Boolean(info?.readOnly);
  const activeTarget = info?.targets.find((entry) => entry.id === target) ?? null;
  const unsupported = unsupportedModeTools(info?.mode ?? null);

  const preview = () => {
    setBusy(true);
    const result = session.planMode(target, params());
    setBusy(false);
    if (!result.ok) {
      setModePlan(null);
      setMessage(result.message);
      return;
    }
    setModePlan(result.value);
    setMessage(null);
  };

  const apply = () => {
    if (!modePlan) return;
    setBusy(true);
    const result = session.applyMode(target, modePlan, params());
    setBusy(false);
    if (!result.ok) {
      setModePlan(null);
      setMessage(result.message);
      return;
    }
    setModePlan(null);
    setMessage(null);
    reportHostMessage(`已转换为${TYPE_LABELS[target]}`);
    refreshPreview();
  };

  const previewTable = () => {
    setBusy(true);
    const result = session.planColorTable(tableParams());
    setBusy(false);
    if (!result.ok) {
      setTablePlan(null);
      setMessage(result.message);
      return;
    }
    setTablePlan(result.value);
    setMessage(null);
  };

  const applyTable = () => {
    if (!tablePlan) return;
    setBusy(true);
    const result = session.applyColorTable(tablePlan, tableParams());
    setBusy(false);
    if (!result.ok) {
      setTablePlan(null);
      setMessage(result.message);
      return;
    }
    setTablePlan(null);
    setMessage(null);
    reportHostMessage("颜色表已更新");
    refreshPreview();
  };

  const patchInk = (index: number, patch: Partial<ImageModeInk>) => {
    setDuotone((current) => ({
      ...current,
      inks: current.inks.map((ink, at) => (at === index ? { ...ink, ...patch } : ink))
    }));
  };

  const setType = (type: string) => {
    const count = inkCount(type);
    setDuotone((current) => ({
      type,
      inks: Array.from({ length: count }, (_, index) => current.inks[index] ?? defaultInks(type)[index])
    }));
  };

  const setTableColor = (index: number, color: string) => {
    setTableDraft((current) => current
      ? { ...current, preset: "custom", colors: current.colors.map((entry, at) => (at === index ? color : entry)) }
      : current);
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="图像模式与调色板" data-modes-panel="true">
      <span className="photo-editor__options-title">图像模式</span>
      {info ? (
        <>
          <p className="photo-editor__option-hint" data-mode-readout={info.mode ?? "unsupported"}>
            {info.mode ? TYPE_LABELS[info.mode] ?? info.mode : `不在本次范围（${info.rawMode}）`}
            {" · "}{info.depth} 位/通道 · {info.layers} 层 · 修订 {info.revision}
          </p>
          {/* 位图文档只有黑白两点，但工程按 8 位通道存展开像素；不加这句会让「位图 · 8 位/通道」
              看起来像悄悄升级了位深。报告里的 depth 是通道采样位深，不是位图的 1 位/像素。 */}
          {info.mode === "bitmap"
            ? <p className="photo-editor__option-hint" data-mode-bitmap-depth="true">位图只有黑白两点；上面的位深是通道采样位深（8 位），不是 1 位/像素。</p>
            : null}
          <label>
            目标
            <select value={target} disabled={readOnly} onChange={(event) => setTarget(event.currentTarget.value as ImageModeTarget)}>
              {IMAGE_MODE_TARGETS.map((id) => {
                const entry = info.targets.find((candidate) => candidate.id === id);
                // 不把不可用目标做成 disabled：那样用户永远看不到「为什么不可用」，
                // 反而像占位。选择后给出原因并禁用预览，才是真实反馈。
                return <option key={id} value={id} data-mode-target-available={entry?.available === false ? "false" : "true"}>{entry?.label ?? TYPE_LABELS[id]}</option>;
              })}
            </select>
          </label>
          {activeTarget && !activeTarget.available ? (
            <p className="photo-editor__brush-note photo-editor__brush-note--error" data-mode-blocked={target}>{activeTarget.reason}</p>
          ) : null}
        </>
      ) : <p className="photo-editor__brush-note">{message ?? "读取模式信息…"}</p>}

      {/* ---------------------------------------------------------- 目标参数 */}
      {info && target === "bitmap" ? (
        <>
          <label>
            方法
            <select value={bitmap.method} disabled={readOnly} onChange={(event) => setBitmap((current) => ({ ...current, method: event.currentTarget.value }))}>
              {BITMAP_METHODS.map((id) => <option key={id} value={id}>{BITMAP_LABELS[id] ?? id}</option>)}
            </select>
          </label>
          {bitmap.method === "halftone" ? (
            <>
              <label>网频<input type="number" min={1} max={999} value={bitmap.frequency} disabled={readOnly}
                onChange={(event) => setBitmap((current) => ({ ...current, frequency: Number(event.currentTarget.value) }))} /></label>
              <label>角度<input type="number" min={-180} max={180} value={bitmap.angle} disabled={readOnly}
                onChange={(event) => setBitmap((current) => ({ ...current, angle: Number(event.currentTarget.value) }))} /></label>
              <label>
                网形
                <select value={bitmap.shape} disabled={readOnly} onChange={(event) => setBitmap((current) => ({ ...current, shape: event.currentTarget.value }))}>
                  {HALFTONE_SHAPES.map((id) => <option key={id} value={id}>{SHAPE_LABELS[id] ?? id}</option>)}
                </select>
              </label>
            </>
          ) : null}
        </>
      ) : null}

      {info && target === "indexed" ? (
        <>
          <label>
            调板
            <select value={indexed.palette} disabled={readOnly} onChange={(event) => setIndexed((current) => ({ ...current, palette: event.currentTarget.value }))}>
              {INDEXED_PALETTES.map((id) => <option key={id} value={id}>{PALETTE_LABELS[id] ?? id}</option>)}
            </select>
          </label>
          <label>颜色数<input type="number" min={2} max={IMAGE_MODE_LIMITS.maxTableColors} value={indexed.colors} disabled={readOnly}
            onChange={(event) => setIndexed((current) => ({ ...current, colors: Number(event.currentTarget.value) }))} /></label>
          <label>
            强制
            <select value={indexed.forced} disabled={readOnly} onChange={(event) => setIndexed((current) => ({ ...current, forced: event.currentTarget.value }))}>
              {INDEXED_FORCED.map((id) => <option key={id} value={id}>{FORCED_LABELS[id] ?? id}</option>)}
            </select>
          </label>
          <label>
            仿色
            <select value={indexed.dither} disabled={readOnly} onChange={(event) => setIndexed((current) => ({ ...current, dither: event.currentTarget.value }))}>
              {INDEXED_DITHER.map((id) => <option key={id} value={id}>{DITHER_LABELS[id] ?? id}</option>)}
            </select>
          </label>
          <label>仿色量<input type="number" min={0} max={100} value={indexed.amount} disabled={readOnly}
            onChange={(event) => setIndexed((current) => ({ ...current, amount: Number(event.currentTarget.value) }))} /></label>
          <label>
            透明度
            <input type="checkbox" checked={indexed.transparency} disabled={readOnly}
              onChange={(event) => setIndexed((current) => ({ ...current, transparency: event.currentTarget.checked }))} />
          </label>
        </>
      ) : null}

      {info && target === "duotone" ? (
        <>
          <label>
            类型
            <select value={duotone.type} disabled={readOnly} onChange={(event) => setType(event.currentTarget.value)}>
              {DUOTONE_TYPES.map((id) => <option key={id} value={id}>{DUOTONE_LABELS[id] ?? id}</option>)}
            </select>
          </label>
          {duotone.inks.map((ink, index) => (
            <div key={index} data-duotone-ink={index}>
              <label>
                油墨 {index + 1}
                <input type="text" maxLength={IMAGE_MODE_LIMITS.maxInkNameLength} value={ink.name} disabled={readOnly}
                  onChange={(event) => patchInk(index, { name: event.currentTarget.value })} />
              </label>
              <label>
                颜色
                <input type="color" value={ink.color} disabled={readOnly} onChange={(event) => patchInk(index, { color: event.currentTarget.value })} />
              </label>
              <InkCurveEditor ink={ink} disabled={readOnly} onChange={(curve) => patchInk(index, { curve })} />
            </div>
          ))}
        </>
      ) : null}

      {info ? (
        <>
          <Button size="sm" disabled={readOnly || busy || Boolean(activeTarget && !activeTarget.available)} onClick={preview}>预览</Button>
          {/* 计划里 `changed=false` 时内核不会提交（`no-change`）：按钮保持可点只会让用户看到
              一条红色错误，而报告同时写着「确认不会新增历史」。两处说法必须一致，所以直接禁用。 */}
          <Button size="sm" disabled={readOnly || busy || !modePlan || !modePlan.changed} onClick={apply}>确认</Button>
          <Button size="sm" tone="ghost" disabled={!modePlan} onClick={() => { setModePlan(null); setMessage(null); }}>取消</Button>
          <p className="photo-editor__option-hint" data-mode-export={info.mode ?? "unsupported"}>
            {exportSummary(info.mode)}
          </p>
        </>
      ) : null}

      {modePlan ? (
        <>
          <ModePixelPreview plan={modePlan} />
          <ReportLines report={modePlan.report} hint="结构" />
          <ReportNotes report={modePlan.report} />
        </>
      ) : null}

      {/* ---------------------------------------------------------- 颜色表 */}
      {info && info.mode === "indexed" && tableDraft ? (
        <section className="photo-editor__advanced-group" aria-label="颜色表" data-color-table="true">
          <span className="photo-editor__options-title">颜色表</span>
          <p className="photo-editor__option-hint">{tableDraft.colors.length} 个条目 · 索引保持，像素颜色随表变化</p>
          <label>
            预设
            {/* 事件值必须在状态更新函数外取出：React 在派发结束后会清空 `currentTarget`。 */}
            <select value={tableDraft.preset} disabled={readOnly} onChange={(event) => {
              const preset = event.currentTarget.value;
              // 预设会整表替换（例如 web 是 216 条），旧透明索引可能超出新表长度而被内核拒绝；
              // 切到预设时清掉它，切回自定义再由用户重新指定。
              setTableDraft((current) => current ? { ...current, preset, transparent: preset === "custom" ? current.transparent : null, index: 0 } : current);
            }}>
              {COLOR_TABLE_PRESETS.map((id) => <option key={id} value={id}>{TABLE_LABELS[id] ?? id}</option>)}
            </select>
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 2, maxHeight: 128, overflowY: "auto" }} data-color-swatches="true">
            {tableDraft.colors.map((color, index) => (
              <button
                key={index}
                type="button"
                title={`索引 ${index}：${color}`}
                data-color-index={index}
                data-color-value={color}
                data-color-selected={index === tableDraft.index ? "true" : undefined}
                onClick={() => setTableDraft((current) => current ? { ...current, index } : current)}
                style={{
                  width: 20,
                  height: 20,
                  padding: 0,
                  background: color,
                  border: index === tableDraft.index ? "2px solid #fff" : "1px solid #000",
                  outline: index === tableDraft.transparent ? "2px dashed #8ab4f8" : undefined,
                  cursor: readOnly ? "default" : "pointer"
                }}
              />
            ))}
          </div>
          <label>
            索引 {tableDraft.index}
            <input
              type="color"
              value={tableDraft.colors[tableDraft.index] ?? "#000000"}
              disabled={readOnly || tableDraft.preset !== "custom"}
              onChange={(event) => setTableColor(tableDraft.index, event.currentTarget.value)}
            />
          </label>
          <label>
            透明索引
            <input
              type="number"
              min={0}
              max={tableDraft.colors.length - 1}
              value={tableDraft.transparent ?? -1}
              disabled={readOnly || tableDraft.preset !== "custom"}
              onChange={(event) => {
                // 清空输入框时 `Number("") === 0`，直接取值会把「没有透明索引」悄悄改成索引 0，
                // 于是原本不透明的 0 号色变成了透明孔。空串必须显式映射回 null。
                const raw = event.currentTarget.value;
                const value = raw === "" ? Number.NaN : Number(raw);
                setTableDraft((current) => current ? { ...current, preset: "custom", transparent: Number.isInteger(value) && value >= 0 ? value : null } : current);
              }}
            />
          </label>
          <Button size="sm" disabled={readOnly || busy} onClick={previewTable}>预览颜色表</Button>
          <Button size="sm" disabled={readOnly || busy || !tablePlan || !tablePlan.changed} onClick={applyTable}>确认颜色表</Button>
          <Button size="sm" tone="ghost" disabled={!tablePlan} onClick={() => { setTablePlan(null); setMessage(null); }}>取消</Button>
          {tablePlan ? (
            <>
              <ReportLines report={tablePlan.report} hint="条目" />
              <ReportNotes report={tablePlan.report} />
            </>
          ) : null}
        </section>
      ) : null}

      {/* ---------------------------------------------------------- 陷印与工具矩阵 */}
      {info ? (
        <section className="photo-editor__advanced-group" aria-label="陷印" data-trap={info.trap.available ? "available" : "closed"}>
          <span className="photo-editor__options-title">陷印</span>
          <Button size="sm" disabled tone="ghost">{info.trap.available ? "陷印…" : "陷印不可用"}</Button>
          <p className="photo-editor__option-hint">{info.trap.reason}</p>
        </section>
      ) : null}

      {info ? (
        <section className="photo-editor__advanced-group" aria-label="工具支持" data-mode-tools={info.mode ?? "unsupported"}>
          <span className="photo-editor__options-title">当前模式下的工具</span>
          {/* 范围外颜色模型（CMYK／Lab）本域不判定：实测那些文档上绘制与文字都能提交，
              把它们列成「建议保持关闭」是假的，列成「全部可用」又替别的域越权承诺。 */}
          {info.mode === null
            ? <p className="photo-editor__option-hint" data-mode-tools-gate="out-of-scope">
                {info.rawMode} 不在本次模式范围，本域不判定工具支持；工具是否可用由各域自身决定。
              </p>
            : unsupported.length === 0
              ? <p className="photo-editor__option-hint">全部工具可用。</p>
              : <p className="photo-editor__option-hint" data-mode-tools-closed="enforced">当前模式不可用：{unsupported.map((tool) => TOOL_LABELS[tool] ?? tool).join("、")}（内核会拒绝，转换模式后再用）</p>}
          {/* 矩阵现在与内核一致：拒绝由 `features::modes::gate` 在唯一命令门之后执行，
              笔迹/文字/滤镜草稿入口也各有一道，因此这里陈述的是既成事实而不是建议。
              逐项一致性由两端共读 `gate-fixtures.json` 的测试锁定。 */}
          {unsupported.length > 0
            ? <p className="photo-editor__option-hint" data-mode-tools-gate="enforced">这些限制由内核强制：命令与草稿入口都会拒绝，并说明原因。</p>
            : null}
        </section>
      ) : null}

      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error" data-mode-message="error">{message}</p> : null}
    </section>
  );
}
