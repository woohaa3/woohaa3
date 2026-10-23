import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../ui/Button.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import { supports, isRecord } from "../shared/panels.js";
import { decodeViewAids, decodeMeasurementLog, decodeViewSnapshot, type MeasurementLog, type ProbeReading, type SamplerReadout, type ViewAids, type ViewSnapshot } from "./decode.js";
import { activePlacement, cancelPlacement, requestPlacement, subscribePlacement } from "./placement.js";
import { activeHover, subscribeHover } from "./hover.js";

/**
 * 视图导航、参考线与分析辅助面板（U70–U73）。
 *
 * 只渲染内核给出的数据：面板不持有参考线/计数/注释的第二份状态，输入框只保存「待提交参数」。
 * 每次成功写入后重新取快照，因此撤销、重开工程和外部改动都会立即反映到这里。
 *
 * 全部子面板共用一个高级面板入口（`viewAids`）。新增独立 section id 需要同步共享 CSS 的
 * `data-feature` 门，而那是跨域文件；本域用内部页签避免并发改动。
 */

type PanelProps = {
  controller: EditorWorkspaceController;
  readonly: boolean;
  revision: number;
  onChanged?: () => void;
};

const UNITS: readonly (readonly [string, string])[] = [
  ["px", "像素"], ["in", "英寸"], ["cm", "厘米"], ["mm", "毫米"], ["pt", "点"], ["pc", "派卡"], ["%", "百分比"],
];

const SNAP_TARGETS: readonly (readonly ["document" | "guides" | "grid" | "layers" | "selection", string])[] = [
  ["document", "文档"], ["guides", "参考线"], ["grid", "网格"], ["layers", "图层"], ["selection", "选区"],
];

/** 视图辅助会话状态（标尺/网格/吸附/单位/旋转/多视图）。 */
function useViewAids(controller: EditorWorkspaceController, revision: number) {
  const [aids, setAids] = useState<ViewAids | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    if (!supports(controller, "viewAids")) return;
    const result = controller.viewAids();
    if (!result.ok) { setError(result.message); return; }
    const decoded = decodeViewAids(result.value);
    if (!decoded) { setError("内核返回的视图辅助状态无效"); return; }
    setError(null);
    setAids(decoded);
  }, [controller]);
  useEffect(() => { reload(); }, [reload, revision]);
  const update = useCallback((patch: Record<string, unknown>) => {
    if (!supports(controller, "setViewAids")) return "当前宿主不支持视图辅助";
    const result = controller.setViewAids(patch);
    if (!result.ok) return result.message;
    const decoded = decodeViewAids(result.value);
    if (decoded) { setAids(decoded); setError(null); } else reload();
    return null;
  }, [controller, reload]);
  return { aids, error, reload, update };
}

/**
 * 「正在等待一次画布落点」的提示与取消（U73）。
 *
 * 请求是一次性的：这里只负责让用户看见它，并在想放弃时清掉——否则用户点了面板按钮后又改变
 * 主意，下一次画布点击会意外加点。没有请求时不渲染任何东西。
 */
function PlacementHint() {
  const [request, setRequest] = useState(() => activePlacement());
  useEffect(() => subscribePlacement(() => setRequest(activePlacement())), []);
  if (!request) return null;
  return (
    <div data-placement-hint="true">
      <Hint text={`${request.label}（或点取消）`} />
      <Button size="sm" tone="ghost" onClick={() => cancelPlacement()}>取消放置</Button>
    </div>
  );
}

/** 视图快照（参考线/原点/取样/测量/计数/注释）。 */
function useSnapshot(controller: EditorWorkspaceController, revision: number) {
  const [snapshot, setSnapshot] = useState<ViewSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    const views = (controller.features as { views?: { viewSnapshot?: () => { ok: boolean } } } | undefined)?.views;
    if (typeof views?.viewSnapshot !== "function") { setSnapshot(null); return; }
    const result = controller.features.views.viewSnapshot();
    if (!result.ok) {
      // 没有文档时快照不可用是正常状态，不当成错误提示。
      setSnapshot(null);
      setError(result.code === "no-document" || result.code === "command-failed" ? null : result.message);
      return;
    }
    const decoded = decodeViewSnapshot(result.value);
    if (!decoded) { setError("内核返回的视图快照无效"); return; }
    setError(null);
    setSnapshot(decoded);
  }, [controller]);
  useEffect(() => { reload(); }, [reload, revision]);
  return { snapshot, error, reload };
}

/**
 * 列表样式：本域不新增共享 `photo-editor.css` 规则（那是外壳文件），只在域内给内联样式，
 * 保持紧凑面板里没有项目符号和默认外边距。
 */
const LIST_STYLE = { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 } as const;
const ROW_STYLE = { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } as const;

/**
 * 连续输入的历史合并键（内核 `coalesce` 参数）。
 *
 * 逐键写回是必要的（每次都要看到真实结果），但一步历史才是用户预期：同一个键连续提交时内核只记
 * 一步，和 Photoshop 拖动滑杆/连续打字一样。换条目或换字段就换键，不会把两次独立编辑并成一步。
 */
function coalesceKey(scope: string, ...parts: (string | number)[]): string {
  return [scope, ...parts].join(":");
}

/**
 * 逐键提交但合并历史的数值输入。
 *
 * 输入框自己保存草稿：清空重打时不会把 `0` 写进文档；失焦/回车才提交一次，因此「打到一半」不会
 * 变成一条中间态历史。父级传入的值变化（撤销、外部改动）会重新同步草稿。
 */
function CoalescedNumber({
  value, disabled, label, min, max, onCommit,
}: {
  value: number;
  disabled: boolean;
  label: string;
  min?: number;
  max?: number;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) { setDraft(String(value)); return; }
    const bounded = Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, parsed));
    setDraft(String(bounded));
    if (bounded !== value) onCommit(bounded);
  };
  return (
    <input
      type="number" aria-label={label} value={draft} disabled={disabled} min={min} max={max}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={(event) => commit(event.currentTarget.value)}
      onKeyDown={(event) => { if (event.key === "Enter") commit(event.currentTarget.value); }}
    />
  );
}

/**
 * 参考线的当前颜色（`#rrggbb`）。
 *
 * 内核只为**显式设过色**的线保存颜色（`guides.colors`），其余沿用偏好里的参考线颜色；这里对
 * 未设色的线退回中性灰，避免把「没设过色」显示成一个具体的文档颜色。
 */
function guideColorHex(
  snapshot: ViewSnapshot | null,
  vertical: boolean,
  position: number,
): string {
  const entry = snapshot?.guides.colors.find((color) => color.vertical === vertical && color.position === position);
  if (!entry) return "#5b9bf3";
  const [red, green, blue] = entry.rgb;
  return `#${[red, green, blue].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

function Message({ text }: { text: string | null }) {
  return text ? <p className="photo-editor__brush-note photo-editor__brush-note--error" role="alert">{text}</p> : null;
}

function Hint({ text }: { text: string }) {
  return <span className="photo-editor__option-hint">{text}</span>;
}

/**
 * 本域写入口是否可用。
 *
 * 统一写入口 `viewCommand` 只挂在本域会话（`controller.features.views`）上，不扩充共享
 * facade；精简宿主或测试替身缺少它时不渲染可写控件，而不是在点击时抛错。
 */
function canWrite(controller: EditorWorkspaceController): boolean {
  const views = controller.features?.views as { viewCommand?: unknown } | undefined;
  return typeof views?.viewCommand === "function";
}

/** 只读列表入口（取样点/测量日志/注释列表）。 */
function canRead(controller: EditorWorkspaceController): boolean {
  const views = controller.features?.views as { viewRead?: unknown } | undefined;
  return typeof views?.viewRead === "function";
}

/** 参考线布局入口（U71）；旧运行时/精简宿主没有它时不渲染该页。 */
function canLayout(controller: EditorWorkspaceController): boolean {
  const views = controller.features?.views as { guideLayoutCommand?: unknown } | undefined;
  return typeof views?.guideLayoutCommand === "function";
}

/**
 * 给写入参数补上目标文档身份（「来源失效不误写目标」）。
 *
 * 界面持有的快照可能来自上一份文档：切标签/换工程后，失焦提交仍带着旧文档的索引。
 * 快照里有 `document.id` 就原样回传，内核会在目标不匹配时拒绝；快照尚未加载完（或旧运行时
 * 不返回身份）时不编造一个 id，交给内核按「未参与守卫」处理。
 */
function withTarget(params: unknown, snapshot: ViewSnapshot | null): unknown {
  const id = snapshot?.document?.id;
  if (typeof id !== "number") return params;
  if (!isRecord(params)) return params;
  return { ...params, targetDocument: id };
}

/** 视图辅助开关 + 单位/网格细分/吸附目标/智能参考线（U71）。 */
function ViewAidsSection({ controller, readonly, revision, onChanged }: PanelProps) {
  const { aids, error, update } = useViewAids(controller, revision);
  const [message, setMessage] = useState<string | null>(null);
  if (!supports(controller, "viewAids", "setViewAids")) return null;
  const apply = (patch: Record<string, unknown>) => {
    setMessage(update(patch));
    onChanged?.();
  };
  return (
    <section className="photo-editor__advanced-group" aria-label="视图辅助" data-view-aids="true">
      <span className="photo-editor__options-title">视图辅助</span>
      <label><input type="checkbox" checked={aids?.rulers === true} disabled={readonly} onChange={(event) => apply({ rulers: event.currentTarget.checked })} />标尺</label>
      <label><input type="checkbox" checked={aids?.grid === true} disabled={readonly} onChange={(event) => apply({ grid: event.currentTarget.checked })} />网格</label>
      <label><input type="checkbox" checked={aids?.guides !== false} disabled={readonly} onChange={(event) => apply({ guides: event.currentTarget.checked })} />参考线</label>
      <label><input type="checkbox" checked={aids?.lockGuides === true} disabled={readonly} onChange={(event) => apply({ lockGuides: event.currentTarget.checked })} />锁定参考线</label>
      <label><input type="checkbox" checked={aids?.smartGuides !== false} disabled={readonly} onChange={(event) => apply({ smartGuides: event.currentTarget.checked })} />智能参考线</label>
      <label>
        单位
        <select value={aids?.units ?? "px"} disabled={readonly} onChange={(event) => apply({ units: event.currentTarget.value })}>
          {UNITS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label>
      <label>
        网格细分
        <input type="number" min={1} max={32} value={aids?.gridSubdivisions ?? 1} disabled={readonly}
          onChange={(event) => apply({ gridSubdivisions: Number(event.currentTarget.value) })} />
      </label>
      <label>
        网格间距
        <input type="number" min={1} max={4096} value={aids?.gridStep?.[0] ?? 18} disabled={readonly}
          onChange={(event) => {
            const value = Number(event.currentTarget.value);
            apply({ gridStep: [value, value] });
          }} />
      </label>
      {SNAP_TARGETS.map(([key, label]) => (
        <label key={key}><input type="checkbox" checked={aids?.snap?.[key] === true} disabled={readonly}
          onChange={(event) => apply({ snap: { [key]: event.currentTarget.checked } })} />{label}吸附</label>
      ))}
      <label><input type="checkbox" checked={aids?.suspend === true} disabled={readonly} onChange={(event) => apply({ suspend: event.currentTarget.checked })} />临时关闭吸附</label>
      <Message text={message ?? error} />
      <Hint text="视图辅助属于本机会话状态：不写入工程，也不进入撤销历史。" />
    </section>
  );
}

/** 参考线单条编辑 + 标尺原点（U70）。 */
function GuideSection({ controller, readonly, revision, onChanged }: PanelProps) {
  const { snapshot, error, reload } = useSnapshot(controller, revision);
  const [orientation, setOrientation] = useState<"vertical" | "horizontal">("vertical");
  const [position, setPosition] = useState(0);
  const [percent, setPercent] = useState(false);
  const [origin, setOrigin] = useState<[number, number]>([0, 0]);
  const [message, setMessage] = useState<string | null>(null);
  if (!supports(controller, "guideCommand")) return null;
  const run = (id: string, params: unknown) => {
    const result = controller.guideCommand(id, withTarget(params, snapshot));
    setMessage(result.ok ? null : result.message);
    if (result.ok) { reload(); onChanged?.(); }
  };
  const guides = orientation === "vertical" ? snapshot?.guides.vertical ?? [] : snapshot?.guides.horizontal ?? [];
  const locked = snapshot?.guides.locked === true;
  return (
    <section className="photo-editor__advanced-group" aria-label="参考线与标尺" data-guide-editor="true">
      <span className="photo-editor__options-title">参考线与标尺</span>
      <label>方向<select value={orientation} disabled={readonly} onChange={(event) => setOrientation(event.currentTarget.value as "vertical" | "horizontal")}>
        <option value="vertical">垂直</option><option value="horizontal">水平</option>
      </select></label>
      <label><input type="checkbox" checked={percent} disabled={readonly} onChange={(event) => setPercent(event.currentTarget.checked)} />按百分比</label>
      <label>新参考线位置
        <input type="number" value={position} disabled={readonly} onChange={(event) => setPosition(Number(event.currentTarget.value))} />
        {percent ? "%" : snapshot?.units ?? "px"}
      </label>
      <Button size="sm" disabled={readonly || locked} onClick={() => run("view.newGuide", { orientation, position: percent ? `${position}%` : position })}>添加参考线</Button>
      <ul className="photo-editor__view-guide-list" style={LIST_STYLE} data-guide-list={orientation}>
        {guides.length === 0 ? <li><Hint text="没有参考线" /></li> : guides.map((entry, index) => (
          <li key={`${orientation}-${index}`} style={ROW_STYLE}>
            <span>{orientation === "vertical" ? "V" : "H"}{index + 1}</span>
            <CoalescedNumber label={`${orientation} 参考线 ${index + 1}`} value={entry} disabled={readonly || locked}
              onCommit={(position) => run("view.moveGuide", {
                orientation, index, position,
                // 连续微调同一条线只记一步历史；换条目就换键。
                coalesce: coalesceKey("view.moveGuide", orientation, index),
              })} />
            {/* 换向走 view.editGuide：位置按旧方向解释，服务端按文档尺寸换算到新方向。 */}
            <Button size="sm" tone="ghost" disabled={readonly || locked}
              onClick={() => run("view.editGuide", {
                orientation, index,
                newOrientation: orientation === "vertical" ? "horizontal" : "vertical",
                position: entry,
              })}>{orientation === "vertical" ? "改水平" : "改垂直"}</Button>
            {/* 单条改色也走 view.editGuide：内核只存显式设过色的线，未设色的沿用偏好色。 */}
            <input type="color" aria-label={`${orientation} 参考线 ${index + 1} 颜色`}
              data-guide-color={`${orientation}-${index}`}
              value={guideColorHex(snapshot, orientation === "vertical", entry)} disabled={readonly || locked}
              onChange={(event) => run("view.editGuide", {
                orientation, index, color: event.currentTarget.value,
                coalesce: coalesceKey("view.editGuide", orientation, index, "color"),
              })} />
            <Button size="sm" tone="ghost" disabled={readonly || locked}
              onClick={() => run("view.deleteGuide", { orientation, index })}>删除</Button>
          </li>
        ))}
      </ul>
      <Button size="sm" tone="ghost" disabled={readonly || locked} onClick={() => run("view.clearGuides", {})}>清除参考线</Button>
      {locked ? <Hint text="参考线已锁定：请在「视图辅助」里解锁后再编辑。" /> : null}
      <span className="photo-editor__options-title">标尺原点</span>
      <label>X<input type="number" value={origin[0]} disabled={readonly} onChange={(event) => setOrigin([Number(event.currentTarget.value), origin[1]])} /></label>
      <label>Y<input type="number" value={origin[1]} disabled={readonly} onChange={(event) => setOrigin([origin[0], Number(event.currentTarget.value)])} /></label>
      <Hint text={`当前原点 ${snapshot?.rulerOrigin.join(", ") ?? "—"}`} />
      <Button size="sm" disabled={readonly} onClick={() => run("view.setRulerOrigin", { x: origin[0], y: origin[1] })}>设置原点</Button>
      <Button size="sm" tone="ghost" disabled={readonly} onClick={() => { setOrigin([0, 0]); run("view.resetRulerOrigin", {}); }}>原点归零</Button>
      <Message text={message ?? error} />
    </section>
  );
}

/** New Guide Layout 与从形状建线（U71）。 */
function GuideLayoutSection({ controller, readonly, revision, onChanged }: PanelProps) {
  const { snapshot, reload } = useSnapshot(controller, revision);
  const [form, setForm] = useState({ columns: 2, rows: 2, gutter: 10, rowGutter: 10, width: 0, height: 0, margin: 0, clearExisting: false, centerColumns: false });
  const [message, setMessage] = useState<string | null>(null);
  const run = (id: string, params: unknown) => {
    if (!canLayout(controller)) { setMessage("当前宿主不支持参考线布局命令"); return; }
    const result = controller.features.views.guideLayoutCommand(id, withTarget(params, snapshot));
    setMessage(result.ok ? null : result.message);
    if (result.ok) { reload(); onChanged?.(); }
  };
  // 旧运行时/精简宿主没有布局端口：整页不渲染，避免只能看不能改的假入口。
  if (!canLayout(controller)) return null;
  const margin = [form.margin, form.margin, form.margin, form.margin];
  return (
    <section className="photo-editor__advanced-group" aria-label="参考线布局" data-guide-layout="true">
      <span className="photo-editor__options-title">参考线布局</span>
      <label>列<input type="number" min={0} max={1000} value={form.columns} disabled={readonly} onChange={(event) => setForm({ ...form, columns: Number(event.currentTarget.value) })} /></label>
      <label>行<input type="number" min={0} max={1000} value={form.rows} disabled={readonly} onChange={(event) => setForm({ ...form, rows: Number(event.currentTarget.value) })} /></label>
      <label>列宽<input type="number" min={0} value={form.width} disabled={readonly} onChange={(event) => setForm({ ...form, width: Number(event.currentTarget.value) })} /></label>
      <label>行高<input type="number" min={0} value={form.height} disabled={readonly} onChange={(event) => setForm({ ...form, height: Number(event.currentTarget.value) })} /></label>
      <label>列间距<input type="number" min={0} value={form.gutter} disabled={readonly} onChange={(event) => setForm({ ...form, gutter: Number(event.currentTarget.value) })} /></label>
      <label>行间距<input type="number" min={0} value={form.rowGutter} disabled={readonly} onChange={(event) => setForm({ ...form, rowGutter: Number(event.currentTarget.value) })} /></label>
      <label>边距<input type="number" min={0} value={form.margin} disabled={readonly} onChange={(event) => setForm({ ...form, margin: Number(event.currentTarget.value) })} /></label>
      <label><input type="checkbox" checked={form.clearExisting} disabled={readonly} onChange={(event) => setForm({ ...form, clearExisting: event.currentTarget.checked })} />先清除参考线</label>
      <label><input type="checkbox" checked={form.centerColumns} disabled={readonly} onChange={(event) => setForm({ ...form, centerColumns: event.currentTarget.checked })} />列居中</label>
      <Button size="sm" disabled={readonly} onClick={() => run("view.newGuideLayout", {
        columns: Math.max(0, Math.trunc(form.columns)),
        rows: Math.max(0, Math.trunc(form.rows)),
        width: Math.max(0, form.width),
        height: Math.max(0, form.height),
        gutter: Math.max(0, form.gutter),
        rowGutter: Math.max(0, form.rowGutter),
        margin,
        clearExisting: form.clearExisting,
        centerColumns: form.centerColumns,
      })}>生成参考线</Button>
      <Button size="sm" tone="ghost" disabled={readonly} onClick={() => run("view.newGuidesFromShape", {})}>从形状建线</Button>
      <Button size="sm" tone="ghost" disabled={readonly} onClick={() => run("view.clearCanvasGuides", {})}>清除画布参考线</Button>
      <Hint text={`当前 ${snapshot?.guides.vertical.length ?? 0} 条垂直 / ${snapshot?.guides.horizontal.length ?? 0} 条水平参考线`} />
      <Message text={message} />
    </section>
  );
}

/** 旋转视图、Navigator 与同文档多视图（U72）。 */
function ViewNavigationSection({ controller, readonly, revision, onChanged }: PanelProps) {
  const { aids, error, update } = useViewAids(controller, revision);
  const { snapshot } = useSnapshot(controller, revision);
  const [degrees, setDegrees] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  if (!supports(controller, "viewAids", "setViewAids")) return null;
  const apply = (patch: Record<string, unknown>) => { setMessage(update(patch)); onChanged?.(); };
  const views = aids?.views ?? [];
  // 每个视图各自的取景值来自内核（活动视图），界面不自己维护一份缩放比例。
  const activeView = views.find((view) => view.active) ?? views[0];
  const zoomPercent = Math.round((activeView?.zoom ?? 1) * 100);
  const offset = activeView?.offset ?? [0, 0];
  return (
    <section className="photo-editor__advanced-group" aria-label="视图导航" data-view-navigation="true">
      <span className="photo-editor__options-title">旋转与导航</span>
      <label>旋转角度
        <input type="number" step={0.1} min={-360} max={360} value={degrees} disabled={readonly} onChange={(event) => setDegrees(Number(event.currentTarget.value))} />
      </label>
      <Button size="sm" disabled={readonly} onClick={() => apply({ rotation: degrees })}>应用旋转</Button>
      <Button size="sm" tone="ghost" disabled={readonly} onClick={() => { setDegrees(0); apply({ rotation: "reset" }); }}>复位视图</Button>
      <Hint text={`当前旋转 ${snapshot?.rotation ?? aids?.rotation ?? 0}°；旋转只改视图，图像像素不动。`} />
      <span className="photo-editor__options-title">多视图取景（只读）</span>
      <div data-view-zoom="true">
        <Hint text={`活动视图 ${zoomPercent}% · 平移 ${offset[0]}, ${offset[1]}`} />
      </div>
      <label><input type="checkbox" checked={aids?.sideBySide === true} disabled={readonly || views.length < 2}
        onChange={(event) => apply({ sideBySide: event.currentTarget.checked })} data-view-side-by-side="true" />并排显示两个视图</label>
      <Hint text={views.length < 2
        ? "并排至少需要两个视图：先点下面的「新建视图」。"
        : aids?.sideBySide
          ? "画布区现在是两个真实画布：同一份内容与撤销历史，各自取景；点一下非活动窗格即可切换输入归属。"
          : "勾选后画布区并排渲染两个视图；活动视图用状态栏/手势的取景，另一个视图记住自己的取景。"} />
      <Hint text="这里的缩放/平移是活动视图的取景记录（画布手势与状态栏直接改它）；非活动视图的取景在并排时各自保留，因此本页只读，避免出现点了不动的按钮。" />
      <label><input type="checkbox" checked={aids?.navigator === true} disabled={readonly} onChange={(event) => apply({ navigator: event.currentTarget.checked })} />显示 Navigator</label>
      {aids?.navigator ? <NavigatorMap snapshot={snapshot} /> : null}
      <span className="photo-editor__options-title">同文档多视图</span>
      <ul className="photo-editor__view-frame-list" style={LIST_STYLE} data-view-frames="true">
        {views.map((frame) => (
          <li key={frame.id} data-active={frame.active} style={ROW_STYLE}>
            <span>{frame.label}</span>
            <Hint text={`${Math.round(frame.zoom * 100)}% · ${frame.rotation}°`} />
            <Button size="sm" tone={frame.active ? "primary" : "ghost"} disabled={readonly || frame.active}
              onClick={() => apply({ viewAction: "activate", viewId: frame.id })}>切换</Button>
            <Button size="sm" tone="ghost" disabled={readonly || views.length <= 1}
              onClick={() => apply({ viewAction: "close", viewId: frame.id })}>关闭</Button>
          </li>
        ))}
      </ul>
      <Button size="sm" disabled={readonly || views.length >= (aids?.maxViews ?? 4)} onClick={() => apply({ viewAction: "new" })}>新建视图</Button>
      <Hint text="多视图共用同一份内容与撤销历史；取景（缩放/平移/旋转）各自独立，只有活动视图接收输入。" />
      <Hint text="并排渲染的已知边界：两块画布的取景（缩放/平移）各自独立且都真实生效；旋转只作用于叠加层与几何反算，像素本身仍由宿主按 origin/zoom 呈现（画布不接收旋转角度）。" />
      <Message text={message ?? error} />
    </section>
  );
}

/**
 * Navigator 缩略图：只画文档框、可视区左上角的位置，以及（可选）可视区框，不读像素。
 *
 * 可视区**大小**取决于画布容器尺寸，那是共享画布的状态，本域拿不到。因此只有在调用方传入
 * `viewport`（容器像素尺寸）时才画取景框；否则只画一个角标，避免画一个「看起来整幅都可见」
 * 的假框。
 */
function NavigatorMap({ snapshot, viewport }: { snapshot: ViewSnapshot | null; viewport?: { width: number; height: number } }) {
  if (!snapshot) return null;
  const [width, height] = snapshot.documentSize;
  const [ox, oy] = snapshot.transform.offset;
  const zoom = snapshot.transform.zoom;
  // 客户坐标 (0,0) 对应的源坐标，就是可视区的左上角。
  const left = -ox / zoom;
  const top = -oy / zoom;
  return (
    <div className="photo-editor__navigator" data-navigator="true">
      <svg viewBox={`0 0 ${Math.max(1, width)} ${Math.max(1, height)}`} role="presentation">
        <rect x={0} y={0} width={width} height={height} fill="var(--app-web-subtle)" stroke="var(--app-web-border-strong)" />
        {viewport ? (
          <rect x={left} y={top} width={viewport.width / zoom} height={viewport.height / zoom}
            fill="none" stroke="var(--app-interaction-accent)" strokeDasharray="4 2" data-navigator-frame="true" />
        ) : null}
        <circle cx={left} cy={top} r={Math.max(1, Math.min(width, height) / 40)}
          fill="var(--app-interaction-accent)" data-navigator-origin="true" />
      </svg>
      <Hint text={`${Math.round(zoom * 100)}% · ${snapshot.rotation}°${
        viewport ? "" : ` · 可视区左上角 (${Math.round(left)}, ${Math.round(top)})`
      }`} />
    </div>
  );
}

const UNIT_LABELS: Record<string, string> = { px: "像素", in: "英寸", cm: "厘米", mm: "毫米", pt: "点", pc: "派卡", "%": "百分比" };

/** Info、颜色取样器、标尺测量与测量日志（U73）。 */
function AnalysisSection({ controller, readonly, revision, onChanged }: PanelProps) {
  const { snapshot, error, reload } = useSnapshot(controller, revision);
  const [scale, setScale] = useState({ pixelLength: 1, logicalLength: 1, units: "pixels" });
  const [ruler, setRuler] = useState({ start: [0, 0] as [number, number], end: [0, 0] as [number, number] });
  // 画布取标尺的两个端点：第一次点选只记起点，第二次才提交测量（避免一次点击提交半条线）。
  const [rulerArmed, setRulerArmed] = useState(false);
  const [sample, setSample] = useState<[number, number]>([0, 0]);
  const [csv, setCsv] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  // 光标读数由应用在内核里取（`viewPointer("probe")`）后发布到这里；面板只显示，不自己换算。
  const [hover, setHover] = useState<ProbeReading | null>(() => activeHover());
  useEffect(() => subscribeHover(() => setHover(activeHover())), []);
  const writable = !readonly && canWrite(controller);
  const views = controller.features?.views as (EditorWorkspaceController["features"]["views"] | undefined);
  const run = (id: string, params: unknown) => {
    if (!views || typeof views.viewCommand !== "function") { setMessage("当前宿主不支持视图/分析命令"); return; }
    const result = views.viewCommand(id, withTarget(params, snapshot));
    setMessage(result.ok ? null : result.message);
    if (result.ok) { reload(); onChanged?.(); }
  };
  // 只读命令也带目标文档：切标签后旧界面不该显示新文档的读数。
  const samplerResult = useMemo(
    () => canRead(controller) ? views!.viewRead("view.colorSamplers.list", withTarget({}, snapshot)) : null,
    [controller, views, revision, snapshot?.document?.id],
  );
  const logResult = useMemo(
    () => canRead(controller) ? views!.viewRead("measurementLog.list", withTarget({}, snapshot)) : null,
    [controller, views, revision, snapshot?.document?.id],
  );
  const log: MeasurementLog | null = logResult?.ok ? decodeMeasurementLog(logResult.value) : null;
  const readouts: SamplerReadout[] = useMemo(() => {
    if (!samplerResult?.ok || !isRecord(samplerResult.value) || !Array.isArray(samplerResult.value.samplers)) return [];
    return samplerResult.value.samplers.filter((entry): entry is SamplerReadout =>
      isRecord(entry) && Array.isArray(entry.rgb) && Array.isArray(entry.position));
  }, [samplerResult]);
  // 画布宽度按当前单位显示：换算一律问内核（`formatLengthJson`），面板不自己算单位。
  const widthInUnits = useMemo(() => {
    const size = snapshot?.documentSize;
    const unit = snapshot?.units;
    if (!views || typeof views.formatLength !== "function" || !size || !unit) return null;
    const result = views.formatLength(size[0], unit);
    return result.ok ? result.value.text : null;
  }, [views, snapshot?.documentSize, snapshot?.units]);
  const scaleState = snapshot?.measurement.scale;
  const scalePixel = scaleState?.pixelLength;
  const scaleLogical = scaleState?.logicalLength;
  const scaleUnits = scaleState?.units;
  useEffect(() => {
    if (scalePixel === undefined || scaleLogical === undefined || scaleUnits === undefined) return;
    setScale({ pixelLength: scalePixel, logicalLength: scaleLogical, units: scaleUnits });
  }, [scalePixel, scaleLogical, scaleUnits]);
  return (
    <section className="photo-editor__advanced-group" aria-label="信息与分析" data-analysis="true">
      <span className="photo-editor__options-title">Info</span>
      {snapshot ? (
        <dl className="photo-editor__analysis-readout" data-analysis-readout="true">
          <dt>画布</dt><dd>{snapshot.documentSize[0]} × {snapshot.documentSize[1]} px</dd>
          <dt>单位</dt><dd>{UNIT_LABELS[snapshot.units] ?? snapshot.units}{widthInUnits ? `（宽 ${widthInUnits}）` : ""}</dd>
          <dt>比例</dt><dd>{snapshot.measurement.scale.describe}</dd>
          <dt>取样点</dt><dd>{snapshot.samplers.length} / 10</dd>
          <dt>计数</dt><dd>{snapshot.measurement.count.total}</dd>
          <dt>注释</dt><dd>{snapshot.notes.length}</dd>
          <dt>测量记录</dt><dd>{snapshot.measurement.logRows}</dd>
        </dl>
      ) : <Hint text="打开文档后显示读数" />}

      {/* 跟随光标的源像素读数（U73）：位置与 RGB/CMYK 都是内核读出的同一像素。 */}
      <span className="photo-editor__options-title">光标读数</span>
      <dl className="photo-editor__analysis-readout" data-info-hover="true">
        <dt>源坐标</dt>
        <dd>{hover?.reading ? `${Math.round(hover.reading.pixel[0])}, ${Math.round(hover.reading.pixel[1])} px` : "—"}</dd>
        <dt>RGB</dt>
        <dd>{hover?.reading ? hover.reading.rgb.join(", ") : "—"}</dd>
        <dt>CMYK</dt>
        <dd>{hover?.reading ? hover.reading.cmyk.map((channel) => Math.round(channel)).join("/") : "—"}</dd>
        <dt>色样</dt>
        <dd><span style={{
          display: "inline-block", width: 14, height: 14, verticalAlign: "middle",
          border: "1px solid var(--app-web-border, #888)",
          // 色样只是读数的可视化，数值以上面三行为准。
          background: hover?.reading ? `rgb(${hover.reading.rgb.join(",")})` : "transparent",
        }} /></dd>
      </dl>
      <Hint text="读数跟随光标：位置与颜色都由内核按当前缩放/平移反算，画布外显示「—」。视图旋转只作用于叠加层与几何，像素平面不旋转，因此读数按像素平面取——它始终是你眼睛看到的那个像素。" />

      <span className="photo-editor__options-title">颜色取样器</span>
      <ul className="photo-editor__sampler-list" style={LIST_STYLE} data-sampler-list="true">
        {readouts.length === 0 ? <li><Hint text="没有取样点" /></li> : readouts.map((entry) => (
          <li key={entry.index} style={ROW_STYLE}>
            <span>#{entry.number}</span>
            <span>({Math.round(entry.position[0])}, {Math.round(entry.position[1])})</span>
            <span>{Array.isArray(entry.rgb) ? entry.rgb.join(", ") : "—"}</span>
            {/* CMYK 由内核按同一源像素换算；面板不自己算，避免与测量/导出不一致。 */}
            <span data-sampler-cmyk={entry.index}>
              {Array.isArray(entry.cmyk) ? entry.cmyk.map((channel) => Math.round(channel)).join("/") : "—"}
            </span>
            <Button size="sm" tone="ghost" disabled={!writable}
              onClick={() => run("view.colorSamplers.move", { index: entry.index, x: sample[0], y: sample[1] })}>移到草稿点</Button>
            <Button size="sm" tone="ghost" disabled={!writable} onClick={() => run("view.colorSamplers.delete", { index: entry.index })}>删除</Button>
          </li>
        ))}
      </ul>
      <label>取样 X<input type="number" value={sample[0]} disabled={!writable} onChange={(event) => setSample([Number(event.currentTarget.value), sample[1]])} /></label>
      <label>取样 Y<input type="number" value={sample[1]} disabled={!writable} onChange={(event) => setSample([sample[0], Number(event.currentTarget.value)])} /></label>
      <Button size="sm" disabled={!writable} onClick={() => run("view.colorSamplers.add", { x: sample[0], y: sample[1] })}>添加取样点</Button>
      <Button size="sm" tone="ghost" disabled={!writable} onClick={() => requestPlacement({
        label: "点击画布放置取样点",
        place: (point) => { run("view.colorSamplers.add", { x: point[0], y: point[1] }); setSample([point[0], point[1]]); },
      })} data-sampler-place="true">在画布上放置取样点</Button>
      <PlacementHint />
      <Button size="sm" tone="ghost" disabled={!writable} onClick={() => run("view.colorSamplers.clear", {})}>清除取样点</Button>
      <Hint text="取样点读出真实源像素；它们随工程保存（存在文档元数据的本域命名空间键里），重开后恢复，不进入像素与内容指纹。" />
      <Hint text="数值框用于精确输入；按「在画布上放置取样点」可以直接在画布上点选位置。" />

      <span className="photo-editor__options-title">测量比例与标尺</span>
      <label>像素长度<input type="number" min={0.0001} step={0.5} value={scale.pixelLength} disabled={readonly} onChange={(event) => setScale({ ...scale, pixelLength: Number(event.currentTarget.value) })} /></label>
      <label>逻辑长度<input type="number" min={0.0001} step={0.5} value={scale.logicalLength} disabled={readonly} onChange={(event) => setScale({ ...scale, logicalLength: Number(event.currentTarget.value) })} /></label>
      <label>单位<input value={scale.units} disabled={readonly} onChange={(event) => setScale({ ...scale, units: event.currentTarget.value })} /></label>
      <Button size="sm" disabled={!writable} onClick={() => run("image.analysis.setMeasurementScale", { preset: "custom", ...scale })}>应用比例</Button>
      <label>起点<input type="number" value={ruler.start[0]} disabled={!writable} onChange={(event) => setRuler({ ...ruler, start: [Number(event.currentTarget.value), ruler.start[1]] })} />
        <input type="number" value={ruler.start[1]} disabled={!writable} onChange={(event) => setRuler({ ...ruler, start: [ruler.start[0], Number(event.currentTarget.value)] })} /></label>
      <label>终点<input type="number" value={ruler.end[0]} disabled={!writable} onChange={(event) => setRuler({ ...ruler, end: [Number(event.currentTarget.value), ruler.end[1]] })} />
        <input type="number" value={ruler.end[1]} disabled={!writable} onChange={(event) => setRuler({ ...ruler, end: [ruler.end[0], Number(event.currentTarget.value)] })} /></label>
      <Button size="sm" disabled={!writable} onClick={() => run("image.analysis.rulerTool", { start: ruler.start, end: ruler.end })}>测量</Button>
      {/* 标尺需要两个端点：画布上依次点两次，第一次设起点、第二次设终点并立即测量。 */}
      <Button size="sm" tone="ghost" disabled={!writable} onClick={() => {
        requestPlacement({
          label: rulerArmed ? "点击画布设置标尺终点" : "点击画布设置标尺起点",
          place: (point) => {
            if (!rulerArmed) {
              // 第一次只记起点（不写文档、不造历史），第二次才真的测量。
              setRuler({ start: [point[0], point[1]], end: [0, 0] });
              setRulerArmed(true);
              return;
            }
            run("image.analysis.rulerTool", { start: ruler.start, end: [point[0], point[1]] });
            setRuler({ start: ruler.start, end: [point[0], point[1]] });
            setRulerArmed(false);
          },
        });
      }} data-ruler-place="true">{rulerArmed ? "在画布上取标尺终点" : "在画布上取标尺起点"}</Button>
      <PlacementHint />
      {rulerArmed ? <Hint text="起点已记下：再按一次「在画布上取标尺终点」并点击画布，才会真正测量。" /> : null}
      <Button size="sm" tone="ghost" disabled={!writable} onClick={() => run("image.analysis.straightenLayer", {})}>按标尺拉直</Button>
      {snapshot?.measurement.ruler ? (
        <Hint text={`长度 ${snapshot.measurement.ruler.info.length} ${snapshot.measurement.ruler.info.units} · 角度 ${snapshot.measurement.ruler.info.angle}°`} />
      ) : <Hint text="尚无标尺线" />}
      <Button size="sm" tone="ghost" disabled={!writable} onClick={() => run("image.analysis.recordMeasurements", { source: "ruler" })}>记录测量</Button>
      <ul className="photo-editor__measurement-log" style={LIST_STYLE} data-measurement-log="true">
        {(log?.rows ?? []).slice(0, 5).map((row) => (
          <li key={row.id} style={ROW_STYLE}>
            {Object.entries(row.values).slice(0, 4).map(([key, cell]) => <span key={key}>{key}: {String(cell)}</span>)}
            <Button size="sm" tone="ghost" disabled={!writable} onClick={() => run("measurementLog.delete", { rows: [row.id] })}>删除</Button>
          </li>
        ))}
      </ul>
      <Button size="sm" tone="ghost" disabled={!writable || (log?.rows.length ?? 0) === 0}
        onClick={() => run("measurementLog.delete", { all: true })}>清除测量日志</Button>
      <Button size="sm" tone="ghost" onClick={() => {
        // 不传 path 时内核只回 CSV 文本：写文件是宿主的 io 端口，本域不自己落盘。
        const result = canRead(controller) ? views!.viewRead("measurementLog.export", withTarget({}, snapshot)) : null;
        if (!result || !result.ok) { setMessage(result && !result.ok ? result.message : "当前宿主不支持导出测量"); return; }
        setMessage(null);
        setCsv(isRecord(result.value) && typeof result.value.csv === "string" ? result.value.csv : "");
      }}>导出测量 CSV</Button>
      {csv ? <textarea readOnly value={csv} rows={4} data-measurement-csv="true" aria-label="测量 CSV" /> : null}
      <Message text={message ?? error} />
    </section>
  );
}

/** Count 分组与标记（U73）。 */
function CountSection({ controller, readonly, revision, onChanged }: PanelProps) {
  const { snapshot, error, reload } = useSnapshot(controller, revision);
  const [groupName, setGroupName] = useState("");
  const [marker, setMarker] = useState<[number, number]>([0, 0]);
  const [markerSize, setMarkerSize] = useState(1);
  const [message, setMessage] = useState<string | null>(null);
  const writable = !readonly && canWrite(controller);
  const run = (id: string, params: unknown) => {
    const result = controller.features.views.viewCommand(id, withTarget(params, snapshot));
    setMessage(result.ok ? null : result.message);
    if (result.ok) { reload(); onChanged?.(); }
  };
  const count = snapshot?.measurement.count;
  // 标记的增删移动都按「当前分组」；没有分组时上游会拒绝，这里直接不提供假入口。
  const activeGroup = count && count.groups.length > 0 ? count.groups[Math.min(count.activeGroup, count.groups.length - 1)] : null;
  // 缺少本域写入口：不渲染一整个只能看的分组面板，避免假入口（只读文档仍显示，但控件禁用）。
  if (!canWrite(controller)) return null;
  return (
    <section className="photo-editor__advanced-group" aria-label="计数" data-count="true">
      <span className="photo-editor__options-title">计数（{count?.total ?? 0}）</span>
      <ul className="photo-editor__count-groups" style={LIST_STYLE} data-count-groups="true">
        {count?.groups.map((group, index) => (
          <li key={`${group.name}-${index}`} data-active={index === count.activeGroup} style={ROW_STYLE}>
            <span>{group.name}</span>
            <span>{group.count}</span>
            <label><input type="checkbox" checked={group.visible} disabled={!writable}
              onChange={(event) => run("count.setGroup", { group: index, visible: event.currentTarget.checked })} />显示</label>
            <label>标记尺寸
              <CoalescedNumber label={`${group.name} 标记尺寸`} min={1} max={10} value={group.markerSize} disabled={!writable}
                onCommit={(markerSize) => run("count.setGroup", {
                  group: index, markerSize,
                  coalesce: coalesceKey("count.setGroup", index, "markerSize"),
                })} />
            </label>
            <Button size="sm" tone={index === count.activeGroup ? "primary" : "ghost"} disabled={!writable}
              onClick={() => run("count.setGroup", { group: index, active: true })}>设为当前</Button>
            <Button size="sm" tone="ghost" disabled={!writable} onClick={() => run("count.deleteGroup", { group: index })}>删组</Button>
          </li>
        ))}
      </ul>
      <label>新组名<input value={groupName} disabled={!writable} onChange={(event) => setGroupName(event.currentTarget.value)} placeholder="例如 瑕疵" /></label>
      <Button size="sm" disabled={!writable} onClick={() => { run("count.newGroup", groupName ? { name: groupName } : {}); setGroupName(""); }}>新建分组</Button>
      {activeGroup ? (
        <>
          <span className="photo-editor__options-title">当前分组标记（{activeGroup.count}）</span>
          <ul className="photo-editor__count-marks" style={LIST_STYLE} data-count-marks={activeGroup.name}>
            {activeGroup.points.slice(0, 12).map((point, index) => (
              <li key={index} style={ROW_STYLE}>
                <span>#{index + 1}</span>
                <span>({Math.round(point[0])}, {Math.round(point[1])})</span>
                <Button size="sm" tone="ghost" disabled={!writable}
                  onClick={() => run("count.move", { index, to: [marker[0], marker[1]] })}>移到草稿点</Button>
                <Button size="sm" tone="ghost" disabled={!writable}
                  onClick={() => run("count.remove", { index })}>删除</Button>
              </li>
            ))}
          </ul>
          {activeGroup.points.length > 12 ? <Hint text={`只列出前 12 个标记（共 ${activeGroup.points.length} 个）`} /> : null}
        </>
      ) : <Hint text="还没有计数分组：先新建分组再添加标记。" />}
      <label>标记尺寸<input type="number" min={1} max={10} value={markerSize} disabled={!writable} onChange={(event) => setMarkerSize(Number(event.currentTarget.value))} /></label>
      <label>标记 X<input type="number" value={marker[0]} disabled={!writable} onChange={(event) => setMarker([Number(event.currentTarget.value), marker[1]])} /></label>
      <label>标记 Y<input type="number" value={marker[1]} disabled={!writable} onChange={(event) => setMarker([marker[0], Number(event.currentTarget.value)])} /></label>
      <Button size="sm" disabled={!writable} onClick={() => run("count.add", { x: marker[0], y: marker[1] })}>添加标记</Button>
      <Button size="sm" tone="ghost" disabled={!writable} onClick={() => requestPlacement({
        label: "点击画布放置计数标记",
        place: (point) => { run("count.add", { x: point[0], y: point[1] }); setMarker([point[0], point[1]]); },
      })}>在画布上放置</Button>
      <PlacementHint />
      <Button size="sm" tone="ghost" disabled={!writable} onClick={() => run("count.clear", { group: "all" })}>清除全部标记</Button>
      <Hint text="计数分组属于文档数据：随工程保存、可撤销，但标记不改变像素。" />
      <Message text={message ?? error} />
    </section>
  );
}

/** 单条注释的作者/文本字段：本地草稿 + 失焦提交，连续输入只记一步历史。 */
function NoteField({ note, field, writable, run }: {
  note: { index: number; author: string; text: string };
  field: "author" | "text";
  writable: boolean;
  run: (id: string, params: unknown) => void;
}) {
  const stored = note[field];
  const [draft, setDraft] = useState(stored);
  useEffect(() => { setDraft(stored); }, [stored]);
  const commit = () => {
    if (draft === stored) return;
    run("notes.set", {
      index: note.index, [field]: draft,
      coalesce: coalesceKey("notes.set", note.index, field),
    });
  };
  const shared = {
    value: draft, disabled: !writable, "aria-label": field === "author" ? "作者" : "注释文本",
    onChange: (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => setDraft(event.currentTarget.value),
    onBlur: commit,
  };
  return field === "author"
    ? <input {...shared} />
    : <textarea {...shared} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) commit(); }} />;
}

/** 单条注释的位置：本地草稿 + 失焦提交，拖动连续改位置也只记一步历史。 */
function NotePosition({ note, writable, run }: {
  note: { index: number; position: [number, number] };
  writable: boolean;
  run: (id: string, params: unknown) => void;
}) {
  const stored: [number, number] = [note.position[0], note.position[1]];
  const [draft, setDraft] = useState<[number, number]>(stored);
  useEffect(() => { setDraft([note.position[0], note.position[1]]); }, [note.position[0], note.position[1]]);
  const commit = () => {
    if (draft[0] === stored[0] && draft[1] === stored[1]) return;
    run("notes.set", {
      index: note.index, x: draft[0], y: draft[1],
      coalesce: coalesceKey("notes.set", note.index, "position"),
    });
  };
  const field = (axis: 0 | 1, label: string) => (
    <label>{label}
      <input type="number" value={draft[axis]} disabled={!writable}
        onChange={(event) => setDraft(axis === 0 ? [Number(event.currentTarget.value), draft[1]] : [draft[0], Number(event.currentTarget.value)])}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") commit(); }} />
    </label>
  );
  return <>{field(0, "X")}{field(1, "Y")}</>;
}

/** Note 注释（U73）。 */
function NotesSection({ controller, readonly, revision, onChanged }: PanelProps) {
  const { snapshot, error, reload } = useSnapshot(controller, revision);
  const [draft, setDraft] = useState({ x: 0, y: 0, author: "", text: "" });
  const [message, setMessage] = useState<string | null>(null);
  const writable = !readonly && canWrite(controller);
  const run = (id: string, params: unknown) => {
    const result = controller.features.views.viewCommand(id, withTarget(params, snapshot));
    setMessage(result.ok ? null : result.message);
    if (result.ok) { reload(); onChanged?.(); }
  };
  if (!canWrite(controller)) return null;
  return (
    <section className="photo-editor__advanced-group" aria-label="注释" data-notes="true">
      <span className="photo-editor__options-title">注释（{snapshot?.notes.length ?? 0}）</span>
      <ul className="photo-editor__note-list" style={LIST_STYLE} data-note-list="true">
        {(snapshot?.notes ?? []).map((note) => (
          <li key={note.index} style={ROW_STYLE}>
            <NoteField note={note} field="author" writable={writable} run={run} />
            <NoteField note={note} field="text" writable={writable} run={run} />
            <NotePosition note={note} writable={writable} run={run} />
            <Hint text={`${note.open ? "展开" : "收起"}`} />
            <Button size="sm" tone="ghost" disabled={!writable}
              onClick={() => run("notes.set", { index: note.index, open: !note.open })}>{note.open ? "收起" : "展开"}</Button>
            <Button size="sm" tone="ghost" disabled={!writable} onClick={() => run("notes.delete", { index: note.index })}>删除</Button>
          </li>
        ))}
      </ul>
      <label>位置 X<input type="number" value={draft.x} disabled={!writable} onChange={(event) => setDraft({ ...draft, x: Number(event.currentTarget.value) })} /></label>
      <label>位置 Y<input type="number" value={draft.y} disabled={!writable} onChange={(event) => setDraft({ ...draft, y: Number(event.currentTarget.value) })} /></label>
      <label>作者<input value={draft.author} disabled={!writable} onChange={(event) => setDraft({ ...draft, author: event.currentTarget.value })} /></label>
      <label>文本<textarea value={draft.text} disabled={!writable} onChange={(event) => setDraft({ ...draft, text: event.currentTarget.value })} /></label>
      <Button size="sm" disabled={!writable} onClick={() => { run("notes.add", draft); setDraft({ ...draft, text: "" }); }}>添加注释</Button>
      <Button size="sm" tone="ghost" disabled={!writable} onClick={() => requestPlacement({
        label: "点击画布放置注释",
        place: (point) => { run("notes.add", { ...draft, x: point[0], y: point[1] }); setDraft({ ...draft, text: "" }); },
      })}>在画布上放置</Button>
      <PlacementHint />
      <Hint text="注释位置可直接在列表里改（失焦提交），也可以按「在画布上放置」在画布上点选落位。" />
      <Hint text="注释属于文档数据（随工程与 PSD 保存）；文本修改产生一步历史，不影响像素。" />
      <Message text={message ?? error} />
    </section>
  );
}

const TABS = [
  { id: "aids", label: "辅助" },
  { id: "guides", label: "参考线" },
  { id: "layout", label: "布局" },
  { id: "navigation", label: "导航" },
  { id: "analysis", label: "Info" },
  { id: "count", label: "计数" },
  { id: "notes", label: "注释" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/**
 * 本域唯一的高级面板入口（菜单「视图 → 视图导航、参考线与分析…」）。
 *
 * 全部子面板只读内核数据；页签只是显示分组，不改变数据归属。
 */
export function ViewWorkspacePanel({ controller, readonly, revision, onChanged }: PanelProps) {
  const [tab, setTab] = useState<TabId>("aids");
  return (
    <div data-view-workspace="true">
      <div className="photo-editor__panel-tabs" role="tablist" aria-label="视图与分析">
        {TABS.map((entry) => (
          <Button key={entry.id} size="sm" tone="ghost" aria-pressed={tab === entry.id}
            onClick={() => setTab(entry.id)}>{entry.label}</Button>
        ))}
      </div>
      {tab === "aids" ? <ViewAidsSection controller={controller} readonly={readonly} revision={revision} onChanged={onChanged} /> : null}
      {tab === "guides" ? <GuideSection controller={controller} readonly={readonly} revision={revision} onChanged={onChanged} /> : null}
      {tab === "layout" ? <GuideLayoutSection controller={controller} readonly={readonly} revision={revision} onChanged={onChanged} /> : null}
      {tab === "navigation" ? <ViewNavigationSection controller={controller} readonly={readonly} revision={revision} onChanged={onChanged} /> : null}
      {tab === "analysis" ? <AnalysisSection controller={controller} readonly={readonly} revision={revision} onChanged={onChanged} /> : null}
      {tab === "count" ? <CountSection controller={controller} readonly={readonly} revision={revision} onChanged={onChanged} /> : null}
      {tab === "notes" ? <NotesSection controller={controller} readonly={readonly} revision={revision} onChanged={onChanged} /> : null}
    </div>
  );
}

/**
 * 兼容导出：共享 facade `editor-tool-panels.tsx` 仍按旧名 `ViewAidsPanel` 转发。
 *
 * 旧名只给「视图辅助」一小块；保留它让已有宿主/测试不改导入，同时新界面用
 * [`ViewWorkspacePanel`] 获得全部 U70–U73 子面板。
 */
export function ViewAidsPanel({ controller, readonly, revision, onChanged }: PanelProps) {
  return <ViewAidsSection controller={controller} readonly={readonly} revision={revision} onChanged={onChanged} />;
}
