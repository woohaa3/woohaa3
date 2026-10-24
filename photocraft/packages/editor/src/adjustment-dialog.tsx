import {useEffect,useRef,useState} from "react";
import type {EditorDialogPort,EditorDialogRendererProps} from "./ports.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";
import {ArithmeticInput} from "./arithmetic-input.js";

/**
 * 直接图像调整（Image › Adjustments）。
 *
 * 只编排固定引擎已有的 `image.adjustments.*` 命令；参数边界取自引擎注册表，不在这里复制
 * 像素算法。调整层仍限于三个已版本化的类型，因此这些入口是破坏性调整，不产生新工程字段。
 */
export type AdjustmentKind =
  | "levels" | "exposure" | "vibrance" | "colorBalance" | "blackWhite" | "photoFilter"
  | "channelMixer" | "invert" | "posterize" | "threshold" | "gradientMap" | "selectiveColor"
  | "desaturate" | "equalize";

export type AdjustmentRequest = { kind: AdjustmentKind; label: string };
const ID = "image-editor.adjustment";

type Field =
  | { type: "number"; key: string; label: string; min: number; max: number; step?: number; value: number }
  | { type: "boolean"; key: string; label: string; value: boolean }
  | { type: "choice"; key: string; label: string; options: readonly (readonly [string, string])[]; value: string }
  | { type: "triple"; key: string; label: string; min: number; max: number; labels: readonly [string, string, string]; value: [number, number, number] }
  | { type: "quad"; key: string; label: string; min: number; max: number; value: [number, number, number, number] }
  | { type: "color"; key: string; label: string; value: string }
  | { type: "stops"; key: string; label: string; value: [string, string] };

const FILTERS = [["warming85", "加温滤镜 85"], ["warmingLBA", "加温滤镜 LBA"], ["warming81", "加温滤镜 81"], ["cooling80", "冷却滤镜 80"], ["coolingLBB", "冷却滤镜 LBB"], ["cooling82", "冷却滤镜 82"], ["red", "红"], ["orange", "橙"], ["yellow", "黄"], ["green", "绿"], ["cyan", "青"], ["blue", "蓝"], ["violet", "紫"], ["magenta", "洋红"], ["sepia", "棕褐"], ["deepRed", "深红"], ["deepBlue", "深蓝"], ["deepEmerald", "深绿"], ["deepYellow", "深黄"], ["underwater", "水下"]] as const;
const SELECTIVE_RANGES = [["reds", "红色"], ["yellows", "黄色"], ["greens", "绿色"], ["cyans", "青色"], ["blues", "蓝色"], ["magentas", "洋红"], ["whites", "白色"], ["neutrals", "中性色"], ["blacks", "黑色"]] as const;

/** 每种调整的公开字段；数值边界与固定引擎一致。 */
export function adjustmentFields(kind: AdjustmentKind): readonly Field[] {
  const n = (key: string, label: string, min: number, max: number, value: number, step = 1): Field => ({ type: "number", key, label, min, max, value, step });
  switch (kind) {
    case "levels": return [n("inBlack", "输入黑场", 0, 253, 0), n("gamma", "灰度系数", 0.01, 9.99, 1, 0.01), n("inWhite", "输入白场", 2, 255, 255), n("outBlack", "输出黑场", 0, 255, 0), n("outWhite", "输出白场", 0, 255, 255)];
    case "exposure": return [n("exposure", "曝光度", -20, 20, 0, 0.01), n("offset", "位移", -0.5, 0.5, 0, 0.001), n("gamma", "灰度系数校正", 0.01, 9.99, 1, 0.01)];
    case "vibrance": return [n("vibrance", "自然饱和度", -100, 100, 0), n("saturation", "饱和度", -100, 100, 0)];
    case "colorBalance": return [
      { type: "triple", key: "shadows", label: "阴影", min: -100, max: 100, labels: ["青色–红色", "洋红–绿色", "黄色–蓝色"], value: [0, 0, 0] },
      { type: "triple", key: "midtones", label: "中间调", min: -100, max: 100, labels: ["青色–红色", "洋红–绿色", "黄色–蓝色"], value: [0, 0, 0] },
      { type: "triple", key: "highlights", label: "高光", min: -100, max: 100, labels: ["青色–红色", "洋红–绿色", "黄色–蓝色"], value: [0, 0, 0] },
      { type: "boolean", key: "preserveLuminosity", label: "保留明度", value: true }
    ];
    case "blackWhite": return [
      n("reds", "红色", -200, 300, 40), n("yellows", "黄色", -200, 300, 60), n("greens", "绿色", -200, 300, 40),
      n("cyans", "青色", -200, 300, 60), n("blues", "蓝色", -200, 300, 20), n("magentas", "洋红", -200, 300, 80),
      { type: "boolean", key: "tint", label: "色调", value: false }, { type: "color", key: "tintColor", label: "色调颜色", value: "#ffffff" }
    ];
    case "photoFilter": return [
      { type: "choice", key: "filter", label: "滤镜", options: FILTERS, value: "warming85" },
      { type: "color", key: "color", label: "颜色", value: "#ec8a00" },
      n("density", "浓度（%）", 0, 100, 25), { type: "boolean", key: "preserveLuminosity", label: "保留明度", value: true }
    ];
    case "channelMixer": return [
      { type: "quad", key: "red", label: "红色输出", min: -200, max: 200, value: [100, 0, 0, 0] },
      { type: "quad", key: "green", label: "绿色输出", min: -200, max: 200, value: [0, 100, 0, 0] },
      { type: "quad", key: "blue", label: "蓝色输出", min: -200, max: 200, value: [0, 0, 100, 0] },
      { type: "boolean", key: "monochrome", label: "单色", value: false },
      { type: "quad", key: "gray", label: "灰色输出", min: -200, max: 200, value: [40, 40, 20, 0] }
    ];
    case "invert": case "desaturate": case "equalize": return [];
    case "posterize": return [n("levels", "色阶", 2, 255, 4)];
    case "threshold": return [n("level", "阈值色阶", 1, 255, 128)];
    case "gradientMap": return [{ type: "stops", key: "stops", label: "渐变（黑→白）", value: ["#000000", "#ffffff"] }, { type: "boolean", key: "reverse", label: "反向", value: false }, { type: "boolean", key: "dither", label: "仿色", value: false }];
    case "selectiveColor": return [
      { type: "choice", key: "method", label: "方法", options: [["relative", "相对"], ["absolute", "绝对"]], value: "relative" },
      { type: "choice", key: "colors", label: "颜色", options: SELECTIVE_RANGES, value: "reds" },
      n("cyan", "青色（%）", -100, 100, 0), n("magenta", "洋红（%）", -100, 100, 0),
      n("yellow", "黄色（%）", -100, 100, 0), n("black", "黑色（%）", -100, 100, 0)
    ];
  }
}

type Values = Record<string, number | boolean | string | [number, number, number] | [number, number, number, number] | [string, string]>;

function initialValues(kind: AdjustmentKind): Values {
  const out: Values = {};
  for (const field of adjustmentFields(kind)) out[field.key] = field.value;
  return out;
}

/** 只保留引擎声明的字段；数值按注册表边界夹紧，越界输入先使表单无效。 */
export function buildAdjustmentParams(kind: AdjustmentKind, values: Values): Record<string, unknown> | null {
  const fields = adjustmentFields(kind);
  if (!fields.length) return {};
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (field.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < field.min || value > field.max) return null;
      out[field.key] = value;
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean") return null;
      out[field.key] = value;
    } else if (field.type === "choice") {
      if (typeof value !== "string" || !field.options.some(([id]) => id === value)) return null;
      out[field.key] = value;
    } else if (field.type === "color") {
      if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) return null;
      out[field.key] = value;
    } else if (field.type === "triple") {
      if (!Array.isArray(value) || value.length !== 3 || !value.every(item => typeof item === "number" && Number.isFinite(item) && item >= field.min && item <= field.max)) return null;
      out[field.key] = value;
    } else if (field.type === "quad") {
      if (!Array.isArray(value) || value.length !== 4 || !value.every(item => typeof item === "number" && Number.isFinite(item) && item >= field.min && item <= field.max)) return null;
      out[field.key] = value;
    } else {
      if (!Array.isArray(value) || value.length !== 2 || !value.every(item => typeof item === "string" && /^#[0-9a-f]{6}$/i.test(item))) return null;
      out["stops"] = [[0, (value as [string, string])[0]], [1, (value as [string, string])[1]]];
    }
  }
  return out;
}

function FieldEditor({ field, value, onChange }: { field: Field; value: Values[string]; onChange: (next: Values[string]) => void }) {
  const number = (_key: string, label: string, current: unknown, min: number, max: number, step = 1) => (
    <label key={label}>{label}<ArithmeticInput invalidate min={min} max={max} step={step} value={String(current ?? "")} onChange={event => onChange(Number(event.currentTarget.value))}/></label>
  );
  if (field.type === "number") return number(field.key, field.label, value, field.min, field.max, field.step ?? 1);
  if (field.type === "boolean") return <label><input type="checkbox" checked={value === true} onChange={event => onChange(event.currentTarget.checked)}/>{field.label}</label>;
  if (field.type === "choice") return <label>{field.label}<select value={String(value)} onChange={event => onChange(event.currentTarget.value)}>{field.options.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>;
  if (field.type === "color") return <label>{field.label}<input type="color" value={String(value)} onChange={event => onChange(event.currentTarget.value)}/></label>;
  if (field.type === "stops") { const stops = value as [string, string]; return <><label>渐变起点<input type="color" value={stops[0]} onChange={event => onChange([event.currentTarget.value, stops[1]])}/></label><label>渐变终点<input type="color" value={stops[1]} onChange={event => onChange([stops[0], event.currentTarget.value])}/></label></>; }
  const tuple = value as number[];
  const labels = field.type === "triple" ? field.labels : ["红", "绿", "蓝", "常数"];
  return <fieldset><legend>{field.label}</legend>{labels.map((label, index) => number(field.key, label, tuple[index], field.min, field.max) as React.ReactElement)}</fieldset>;
}

function AdjustmentDialog({ instance, requestClose, request, apply }: EditorDialogRendererProps & { request: AdjustmentRequest; apply: (params: Record<string, unknown>) => string | null }) {
  const fields = adjustmentFields(request.kind);
  const [values, setValues] = useState<Values>(() => initialValues(request.kind));
  const [error, setError] = useState<string | null>(null);
  const params = buildAdjustmentParams(request.kind, values);
  return <DialogContent size="md" instanceId={instance.instanceId} ariaLabel={request.label}><form onSubmit={event => { event.preventDefault(); if (!params) { setError("请输入有效参数"); return; } const failure = apply(params); if (failure) setError(failure); else requestClose(); }}>
    <DialogHeader onClose={requestClose}><DialogTitle>{request.label}</DialogTitle></DialogHeader><DialogBody>
      <p>直接调整当前像素层（有选区时只作用于选区），确认后记为一步历史。</p>
      {fields.map(field => <FieldEditor key={field.key} field={field} value={values[field.key]!} onChange={next => setValues(current => ({ ...current, [field.key]: next }))}/>)}
      {!fields.length ? <p>该调整没有参数，确认后直接应用。</p> : null}
      {error ? <p className="dlg__error">{error}</p> : null}
    </DialogBody><DialogFooter><Button type="button" onClick={requestClose}>取消</Button><Button type="submit" tone="primary" disabled={!params}>{fields.length ? "应用" : "确定"}</Button></DialogFooter>
  </form></DialogContent>;
}

const LABELS: Record<AdjustmentKind, string> = {
  levels: "色阶", exposure: "曝光度", vibrance: "自然饱和度", colorBalance: "色彩平衡", blackWhite: "黑白",
  photoFilter: "照片滤镜", channelMixer: "通道混合器", invert: "反相", posterize: "色调分离", threshold: "阈值",
  gradientMap: "渐变映射", selectiveColor: "可选颜色", desaturate: "去色", equalize: "色调均化"
};
export function adjustmentLabel(kind: AdjustmentKind): string { return LABELS[kind]; }

export function useAdjustmentDialog(dialogs: EditorDialogPort | undefined, controller: EditorWorkspaceController, blocked: boolean, refresh: () => void, report: (message: string | null) => void) {
  const latest = useRef({ blocked, refresh, report }); latest.current = { blocked, refresh, report };
  const instance = useRef<string | null>(null), request = useRef<{ owner: string; request: AdjustmentRequest } | null>(null), opening = useRef(false);
  const owner = () => JSON.stringify([controller.dialogOwner(), controller.snapshot().view.document?.documentKey, controller.snapshot().view.document?.revision]);
  useEffect(() => {
    if (!dialogs) return;
    const unregister = dialogs.registerDialog(ID, { definition: { singleton: true, size: "md", editingOwner: () => opening.current && !latest.current.blocked ? controller.dialogOwner() : null, validatePayload: p => p == null ? { ok: true, payload: null } : { ok: false, error: "无效的调整请求" } }, renderer: props => {
      const captured = request.current; if (!captured) return null;
      return <AdjustmentDialog {...props} request={captured.request} apply={params => {
        const command = controller.snapshot().commands.get(`image.adjustments.${captured.request.kind}`);
        if (latest.current.blocked || request.current !== captured || captured.owner !== owner() || instance.current !== props.instance.instanceId || dialogs.top()?.instanceId !== props.instance.instanceId) return "文档已更换，请关闭后重试";
        if (!command?.allowed || !command.enabled) return command?.disabledReason ?? "当前无法调整";
        const result = controller.dispatch(`image.adjustments.${captured.request.kind}`, params); if (!result.ok) return result.message;
        latest.current.refresh(); return null;
      }} />;
    } });
    return () => { if (instance.current) dialogs.close(instance.current); instance.current = null; request.current = null; unregister(); };
  }, [dialogs, controller]);
  useEffect(() => { if (blocked && instance.current) { dialogs?.close(instance.current); instance.current = null; request.current = null; } }, [blocked, dialogs]);
  return {
    open: (kind: AdjustmentKind) => {
      const command = controller.snapshot().commands.get(`image.adjustments.${kind}`);
      if (!dialogs || latest.current.blocked || !controller.dialogOwner() || !command?.allowed || !command.enabled || dialogs.isModalActive()) { latest.current.report(command?.disabledReason ?? "请先结束当前操作"); return false; }
      request.current = { owner: owner(), request: { kind, label: LABELS[kind] } }; opening.current = true;
      try { const result = dialogs.open({ dialogId: ID }); if (!result.ok) { request.current = null; latest.current.report(result.error); return false; } instance.current = result.instance.instanceId; return true; } finally { opening.current = false; }
    }
  };
}
