import { AdjustmentRange } from "./adjustment-range.js";
import { RgbCurveEditor, type CurvePoint } from "./rgb-curve-editor.js";
import { BrushPresetPicker } from "./brush-panels.js";
import type { BrushLibraryController } from "./brush-library-state.js";
import { Button } from "./ui/Button.js";
import { IconButton } from "./ui/Button.js";
import { Combine, CopyMinus, CopyPlus, Square } from "lucide-react";
import type { PhotoEditorTool } from "./photo-editor-shortcuts.js";
import { buildFeather, clampBrushSize, isHexColor, type BrushSettings, type SelectionMode } from "./photo-editor-tools.js";

const SELECTION_MODES: readonly { id: SelectionMode; label: string }[] = [
  { id: "replace", label: "替换" }, { id: "add", label: "增加" },
  { id: "subtract", label: "减去" }, { id: "intersect", label: "相交" }
];
const SELECTION_MODE_ICONS = { replace: Square, add: CopyPlus, subtract: CopyMinus, intersect: Combine } as const;

export function SelectionModeButtons({ value, disabled, intersect = true, onChange }: {
  value: SelectionMode;
  disabled: boolean;
  intersect?: boolean;
  onChange: (mode: SelectionMode) => void;
}) {
  return <div className="photo-editor__selection-modes" aria-label="选区运算">
    {SELECTION_MODES.filter(mode => intersect || mode.id !== "intersect").map(mode => {
      const Icon = SELECTION_MODE_ICONS[mode.id];
      return <IconButton key={mode.id} size="sm" label={mode.label} title={mode.label}
        pressed={value === mode.id} disabled={disabled} onClick={() => onChange(mode.id)}><Icon size={15} /></IconButton>;
    })}
  </div>;
}

type AdjustmentState = { brightness: number; contrast: number; hue: number; saturation: number; lightness: number };
export type PhotoEditorProperty = "text" | "mask" | "adjustment";

/** 工具参数面板：选区、蒙版、画笔、文字与调整层。 */
export function ToolOptionsPanel({
  readonly, surface,
  tool, property,
  selection,
  onSelectionMode,
  onFeather,
  brush,
  onBrush,
  text,
  onText,
  textActive, textComposing, editingText, onEditText, onConfirmText, onCancelText,
  runCommand,
  layerParam,
  hasSelection,
  hasMask, canApplyMask,
  adjustment,
  onAdjustment,
  editingAdjustment, curvePoints, onCurvePoints, curveSamples, adjustmentActive, onEndAdjustment, adjustmentCancelRevision,
  brushLibrary, onBrushPreset
}: {
  surface?:"tools"|"properties";
  readonly: boolean;
  tool: PhotoEditorTool;
  property?: PhotoEditorProperty | null;
  selection: { mode: SelectionMode; ellipse: boolean; feather: number };
  onSelectionMode: (mode: SelectionMode) => void;
  onFeather: (value: number) => void;
  brush: BrushSettings;
  onBrush: (patch: Partial<BrushSettings>) => void;
  /** 笔刷库控制器（提供时渲染预设选择器与笔刷设置面板）。 */
  brushLibrary?: BrushLibraryController;
  /** 选中预设后把它的设置应用到工具（界面状态，不写文档）。 */
  onBrushPreset?: (name: string) => void;
  text: { text: string; size: number; color: string; font: "Noto Sans SC" | "Inter"; bold: boolean; align: "left" | "center" | "right" };
  onText: (patch: Partial<{ text: string; size: number; color: string; font: "Noto Sans SC" | "Inter"; bold: boolean; align: "left" | "center" | "right" }>) => void;
  textActive: boolean;
  textComposing: boolean;
  editingText: boolean;
  onEditText: () => void;
  onConfirmText: () => void;
  onCancelText: () => void;
  runCommand: (id: string, params?: unknown) => void;
  layerParam: { layer?: number };
  hasSelection: boolean;
  hasMask: boolean;
  canApplyMask: boolean;
  adjustment: AdjustmentState;
  onAdjustment: (patch: Partial<AdjustmentState>) => void;
  editingAdjustment: string | null;
  adjustmentActive?: boolean;
  adjustmentCancelRevision?:number;
  onEndAdjustment?: (commit:boolean)=>boolean;
  curveSamples?: number[];
  curvePoints: CurvePoint[];
  onCurvePoints: (points: CurvePoint[]) => void;
}) {
  const painting = tool === "brush" || tool === "eraser";
  return (
    <div className="photo-editor__options" aria-label="工具选项" data-tool={tool}>
      {surface!=="properties" ? <section className="photo-editor__options-group" aria-label="选区" hidden={tool !== "marquee" && tool !== "lasso"}>
        <span className="photo-editor__options-title">选区</span>
        <SelectionModeButtons value={selection.mode} disabled={readonly} onChange={onSelectionMode} />
        <label>
          羽化
          <input
            type="number"
            min={0}
            max={100}
            value={selection.feather}
            disabled={readonly}
            onChange={(event) => onFeather(Number(event.currentTarget.value))}
          />
        </label>
        <Button size="sm" tone="ghost" disabled={readonly} onClick={() => runCommand("select.all")}>
          全选
        </Button>
        <Button size="sm" tone="ghost" disabled={readonly || !hasSelection} onClick={() => runCommand("select.inverse")}>
          反选
        </Button>
        <Button size="sm" tone="ghost" disabled={readonly || !hasSelection} onClick={() => runCommand("select.deselect")}>
          取消选择
        </Button>
        <Button
          size="sm"
          tone="ghost"
          disabled={readonly || !hasSelection}
          onClick={() => runCommand("select.modify.feather", buildFeather(selection.feather))}
        >
          应用到当前选区
        </Button>
      </section> : null}

      {surface!=="tools" ? <section className="photo-editor__options-group" aria-label="蒙版" hidden={property !== "mask"}>
        <span className="photo-editor__options-title">蒙版</span>
        <Button size="sm" tone="ghost" disabled={readonly || !hasMask} onClick={() => runCommand("layer.layerMask.enabled", layerParam)}>
          启用/停用
        </Button>
        <Button size="sm" tone="ghost" disabled={readonly || !hasMask || !canApplyMask} onClick={() => runCommand("layer.layerMask.apply", layerParam)}>应用蒙版</Button>
        <Button size="sm" tone="ghost" disabled={readonly || !hasMask} onClick={() => runCommand("layer.layerMask.delete", layerParam)}>
          删除
        </Button>
      </section> : null}

      {surface!=="properties" ? <section className="photo-editor__options-group" aria-label="画笔" hidden={!painting}>
        <span className="photo-editor__options-title" title="Shift 点击连接直线；Alt/Option 临时取色；数字调整不透明度，Shift+数字调整流量；X 交换颜色，D 复位">画笔{painting ? `（${tool === "eraser" ? "橡皮" : "画笔"}）` : ""}</span>
        {brushLibrary ? (
          <BrushPresetPicker
            controller={brushLibrary}
            brush={brush}
            disabled={readonly}
            onPick={(name) => onBrushPreset?.(name)}
            onBrush={(patch) => onBrush(patch as Partial<BrushSettings>)}
          />
        ) : null}
        <label>
          尺寸
          <input
            type="number"
            min={1}
            max={512}
            value={brush.size}
            disabled={readonly}
            onChange={(event) => onBrush({ size: clampBrushSize(Number(event.currentTarget.value)) })}
          />
        </label>
        <label>
          硬度
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(brush.hardness * 100)}
            disabled={readonly}
            onChange={(event) => onBrush({ hardness: Number(event.currentTarget.value) / 100 })}
          />
        </label>
        <label>
          不透明度
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(brush.opacity * 100)}
            disabled={readonly}
            onChange={(event) => onBrush({ opacity: Number(event.currentTarget.value) / 100 })}
          />
          <output>{Math.round(brush.opacity*100)}%</output>
        </label>
        <label>
          流量
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(brush.flow * 100)}
            disabled={readonly}
            onChange={(event) => onBrush({ flow: Number(event.currentTarget.value) / 100 })}
          />
          <output>{Math.round(brush.flow*100)}%</output>
        </label>
        <label>
          平滑
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(brush.smoothing * 100)}
            disabled={readonly}
            onChange={(event) => onBrush({ smoothing: Number(event.currentTarget.value) / 100 })}
          />
        </label>
        <label>
          颜色
          <input
            type="color"
            value={isHexColor(brush.color) ? brush.color : "#000000"}
            disabled={readonly}
            onChange={(event) => onBrush({ color: event.currentTarget.value })}
          />
        </label>
        <label>
          目标
          <select
            value={brush.target}
            disabled={readonly}
            onChange={(event) => onBrush({ target: event.currentTarget.value as BrushSettings["target"] })}
          >
            <option value="pixels">像素层</option>
            <option value="mask">蒙版</option>
          </select>
        </label>
      </section> : null}

      {surface!=="tools" ? <section className="photo-editor__options-group" aria-label="文字" hidden={property !== "text"}>
        <span className="photo-editor__options-title">文字</span>
        <span className="photo-editor__option-hint">{textActive ? "Enter 换行，Ctrl/Cmd+Enter 确认，Esc 取消。" : "点击图片输入文字，拖动创建段落框。"}</span>
        <label>字体<select value={text.font} disabled={readonly} onChange={(event) => onText({ font: event.currentTarget.value as "Noto Sans SC" | "Inter" })}>
          <option value="Noto Sans SC">思源黑体</option><option value="Inter">Inter</option>
        </select></label>
        <label><input type="checkbox" checked={text.bold} disabled={readonly} onChange={(event) => onText({ bold: event.currentTarget.checked })} />粗体</label>
        <label>
          字号
          <input
            type="number"
            min={1}
            max={1000}
            value={text.size}
            disabled={readonly}
            onChange={(event) => onText({ size: Math.max(1, Number(event.currentTarget.value)) })}
          />
        </label>
        <label>
          颜色
          <input
            type="color"
            value={isHexColor(text.color) ? text.color : "#000000"}
            disabled={readonly}
            onChange={(event) => onText({ color: event.currentTarget.value })}
          />
        </label>
        <label>
          对齐
          <select
            value={text.align}
            disabled={readonly}
            onChange={(event) => onText({ align: event.currentTarget.value as "left" | "center" | "right" })}
          >
            <option value="left">左</option>
            <option value="center">中</option>
            <option value="right">右</option>
          </select>
        </label>
        {textActive ? <>
          <Button size="sm" disabled={readonly || textComposing} onClick={onConfirmText}>确认文字</Button>
          <Button size="sm" tone="ghost" disabled={readonly} onClick={onCancelText}>取消文字</Button>
        </> : editingText ? <Button size="sm" tone="ghost" disabled={readonly} onClick={onEditText}>编辑所选文字</Button> : null}
      </section> : null}

      {surface!=="tools" ? <section className="photo-editor__options-group" aria-label="调整层" hidden={property !== "adjustment"}>
        <span className="photo-editor__options-title">调整层</span>
        {([{key:"brightness",label:"亮度",min:-150,max:150,kind:"brightnessContrast"},
          {key:"contrast",label:"对比度",min:-50,max:100,kind:"brightnessContrast"},
          {key:"hue",label:"色相",min:-180,max:180,kind:"hueSaturation"},
          {key:"saturation",label:"饱和度",min:-100,max:100,kind:"hueSaturation"},
          {key:"lightness",label:"明度",min:-100,max:100,kind:"hueSaturation"}] as const).filter(entry=>entry.kind===editingAdjustment).map((entry)=><AdjustmentRange key={entry.key}
            cancelRevision={adjustmentCancelRevision} label={entry.label} value={adjustment[entry.key]} min={entry.min} max={entry.max}
            disabled={readonly || Boolean(adjustmentActive && editingAdjustment!==entry.kind)}
            onChange={(value)=>onAdjustment({[entry.key]:value})} onEnd={onEndAdjustment ?? (()=>true)} />)}
        {editingAdjustment === "curves" ? <RgbCurveEditor points={curvePoints} onChange={onCurvePoints} readonly={readonly}
          onApply={() => onEndAdjustment?.(true)} editing inline
          samples={curveSamples} onEnd={onEndAdjustment} cancelRevision={adjustmentCancelRevision} /> : null}
        {adjustmentActive ? <>
          <Button size="sm" disabled={readonly} onClick={()=>onEndAdjustment?.(true)}>确认调整</Button>
          <Button size="sm" tone="ghost" onPointerDown={(event)=>{event.preventDefault();onEndAdjustment?.(false);}} onClick={()=>onEndAdjustment?.(false)}>取消调整</Button>
        </> : null}
      </section> : null}
    </div>
  );
}
