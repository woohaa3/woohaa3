import {TEXT_ANTIALIAS,type TextAntialias} from "./text-antialias.js";
import type {FontPreviewSize,FontSampleReader} from "./font-menu-sample.js";
import {PaintNumberField} from "./paint-number-field.js";
import {ArithmeticInput} from "./arithmetic-input.js";
import {FontFamilyPicker} from "./font-family-picker.js";
import {normalizeBrushAngle} from "./brush-resize.js";
import {PaintModeField} from "./paint-mode-field.js";
import { AdjustmentRange } from "./adjustment-range.js";
import { RgbCurveEditor, type CurvePoint } from "./rgb-curve-editor.js";
import { Button } from "./ui/Button.js";
import type { PhotoEditorTool } from "./photo-editor-shortcuts.js";
import { buildFeather, clampBrushSize, isHexColor, type BrushSettings, type SelectionMode } from "./photo-editor-tools.js";
import {SelectionModifyControls} from "./selection-modify-controls.js";

const SELECTION_MODES: readonly { id: SelectionMode; label: string }[] = [
  { id: "replace", label: "替换" }, { id: "add", label: "增加" },
  { id: "subtract", label: "减去" }, { id: "intersect", label: "相交" }
];

type AdjustmentState = { brightness: number; contrast: number; hue: number; saturation: number; lightness: number };
export type PhotoEditorProperty = "text" | "mask" | "adjustment";

/** 工具参数面板：选区、蒙版、画笔、文字与调整层。 */
export function ToolOptionsPanel({
  readonly, surface,resolutionDpi=72,zoomScrubby=true,onZoomScrubby,
  tool, property,
  selection, marqueeConstraint,onMarqueeConstraint,
  onSelectionMode,
  onFeather,
  brush,
  onBrush,
  text,
  onText,onPreviewFont,
  fontNamesInEnglish=true,recentFontLimit=10,fontPreview="medium",readFontSample,
  textActive, textComposing, textEscapeCommits=true, editingText, onEditText, onConfirmText, onCancelText,
  runCommand,
  layerParam,
  hasSelection,
  hasMask, canApplyMask, maskProperties,
  adjustment,
  onAdjustment,
  editingAdjustment, curvePoints, onCurvePoints, curveSamples, adjustmentActive, onEndAdjustment, adjustmentCancelRevision
}: {
  zoomScrubby?:boolean;onZoomScrubby?:(next:boolean)=>void;
  fontNamesInEnglish?:boolean;recentFontLimit?:number;fontPreview?:FontPreviewSize;readFontSample?:FontSampleReader;
  resolutionDpi?:number;
  surface?:"tools"|"properties";
  readonly: boolean;
  tool: PhotoEditorTool;
  property?: PhotoEditorProperty | null;
  selection: { mode: SelectionMode; ellipse: boolean; feather: number };
  marqueeConstraint?:{mode:"normal"|"ratio"|"size";width:string;height:string};
  onMarqueeConstraint?:(patch:Partial<{mode:"normal"|"ratio"|"size";width:string;height:string}>)=>void;
  onSelectionMode: (mode: SelectionMode) => void;
  onFeather: (value: number) => void;
  brush: BrushSettings;
  onBrush: (patch: Partial<BrushSettings>) => void;
  text: { orientation?:"horizontal"|"vertical"; antialias?:TextAntialias; text: string; size: number; color: string; font: "Noto Sans SC" | "Inter"; bold: boolean; align: "left" | "center" | "right" };
  onPreviewFont?:(font:"Noto Sans SC"|"Inter"|null)=>void;
  onText: (patch: Partial<{ orientation?:"horizontal"|"vertical"; antialias?:TextAntialias; text: string; size: number; color: string; font: "Noto Sans SC" | "Inter"; bold: boolean; align: "left" | "center" | "right" }>) => void;
  textActive: boolean;
  textEscapeCommits?:boolean;
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
  maskProperties?:{disabled:boolean;active:boolean;values:{density:string;feather:string};update:(property:"density"|"feather",value:string)=>void;finish:(commit:boolean)=>boolean};
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
  const painting = tool === "brush" || tool==="pencil" || tool === "eraser";
  const pencil=tool==="pencil" || tool==="eraser" && brush.eraserMode!==undefined && brush.eraserMode!=="brush",block=tool==="eraser" && brush.eraserMode==="block";
  return (
    <div className="photo-editor__options" aria-label="工具选项" data-tool={tool}>
      {surface!=="properties" && tool==="zoom"?<label><input type="checkbox" checked={zoomScrubby} disabled={readonly} onChange={event=>onZoomScrubby?.(event.currentTarget.checked)}/>左右拖动连续缩放</label>:null}
      {surface!=="properties" ? <section className="photo-editor__options-group" aria-label="选区" hidden={tool !== "marquee" && tool !== "lasso"}>
        <span className="photo-editor__options-title">选区</span>
        <label>
          运算
          <select value={selection.mode} disabled={readonly} onChange={(event) => onSelectionMode(event.currentTarget.value as SelectionMode)}>
            {SELECTION_MODES.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.label}
              </option>
            ))}
          </select>
        </label>
        {tool==="marquee" && marqueeConstraint?<>
          <label>样式<select value={marqueeConstraint.mode} disabled={readonly} onChange={event=>onMarqueeConstraint?.({mode:event.currentTarget.value as "normal"|"ratio"|"size"})}><option value="normal">正常</option><option value="ratio">固定比例</option><option value="size">固定大小</option></select></label>
          {marqueeConstraint.mode!=="normal"?<>
            {(["width","height"] as const).map((key,index)=><label key={key}>{index?"高":"宽"}<ArithmeticInput invalidate units={marqueeConstraint.mode==="ratio"?undefined:{unit:"px",dpi:resolutionDpi}} min={1} max={16384} step={marqueeConstraint.mode==="size"?1:"any"} disabled={readonly} value={marqueeConstraint[key]} onChange={event=>onMarqueeConstraint?.({[key]:event.currentTarget.value})}/></label>)}
            <Button size="sm" tone="ghost" title="交换选框宽高" disabled={readonly} onClick={()=>onMarqueeConstraint?.({width:marqueeConstraint.height,height:marqueeConstraint.width})}>交换</Button>
          </>:null}
        </>:null}
        <label>
          羽化
          <ArithmeticInput

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
        {hasSelection?<SelectionModifyControls disabled={readonly} onRun={runCommand} resolutionDpi={resolutionDpi}/>:null}
        <Button size="sm" tone="ghost" disabled={readonly} onClick={()=>runCommand("select.saveSelection",{channel:"new",name:`Alpha ${Date.now().toString(36)}`})}>存储选区</Button>
        <Button size="sm" tone="ghost" disabled={readonly} onClick={()=>runCommand("select.loadSelection",{channel:"transparency"})}>载入图层透明度</Button>
        <Button size="sm" tone="ghost" disabled={readonly} onClick={()=>runCommand("select.colorRange",undefined)}>颜色范围…</Button>
      </section> : null}

      {surface!=="tools" ? <section className="photo-editor__options-group" aria-label="蒙版" hidden={property !== "mask"}>
        <span className="photo-editor__options-title">蒙版</span>
        {maskProperties && hasMask ? <div onKeyDown={event=>{
          if(event.nativeEvent.isComposing || event.keyCode===229) return;
          if(event.key==="Enter" || event.key==="Escape") {event.preventDefault();event.stopPropagation();maskProperties.finish(event.key==="Enter");}
        }}>
          {(["density","feather"] as const).map(key=><div key={key}>
            <label>{key==="density"?"密度 (%)":"羽化 (px)"}<ArithmeticInput invalidate units={{unit:key==="density"?"%":"px",dpi:resolutionDpi}} min={0} max={key==="density"?100:1000} step={0.1} disabled={maskProperties.disabled}
              value={maskProperties.values[key]} onChange={event=>maskProperties.update(key,event.currentTarget.value)} onBlur={()=>maskProperties.finish(true)}/></label>
            <AdjustmentRange label={key==="density"?"蒙版密度":"蒙版羽化"} min={0} max={key==="density"?100:1000} value={Number(maskProperties.values[key])||0} disabled={maskProperties.disabled}
              onChange={value=>maskProperties.update(key,String(value))} onEnd={maskProperties.finish}/>
          </div>)}
          {maskProperties.active?<><Button size="sm" onPointerDown={event=>event.preventDefault()} onClick={()=>maskProperties.finish(true)}>确认</Button><Button size="sm" tone="ghost" onPointerDown={event=>event.preventDefault()} onClick={()=>maskProperties.finish(false)}>取消</Button></>:null}
        </div>:null}
        <Button size="sm" tone="ghost" disabled={readonly || !hasMask} onClick={() => runCommand("layer.layerMask.enabled", layerParam)}>
          启用/停用
        </Button>
        <Button size="sm" tone="ghost" disabled={readonly || !hasMask || !canApplyMask} onClick={() => runCommand("layer.layerMask.apply", layerParam)}>应用蒙版</Button>
        <Button size="sm" tone="ghost" disabled={readonly || !hasMask} onClick={() => runCommand("layer.layerMask.delete", layerParam)}>
          删除
        </Button>
      </section> : null}

      {surface!=="properties" ? <section className="photo-editor__options-group" aria-label="画笔" hidden={!painting}>
        <span className="photo-editor__options-title" title="Shift 点击连接直线；Alt/Option 临时取色；数字调整不透明度，Shift+数字调整流量；X 交换颜色，D 复位">画笔{painting ? `（${tool === "eraser" ? "橡皮" : tool==="pencil" ? "铅笔" : "画笔"}）` : ""}</span>
        {tool==="brush" || tool==="pencil" ? <PaintModeField key={tool} value={brush.mode??"Normal"} disabled={readonly || block} onChange={mode=>onBrush({mode})}/>:null}
        {tool==="pencil"?<label><input type="checkbox" disabled={readonly || block} checked={brush.autoErase??false} onChange={event=>onBrush({autoErase:event.currentTarget.checked})}/>自动擦除</label>:null}
        {tool==="eraser"?<label>橡皮模式<select disabled={readonly} value={brush.eraserMode??"brush"} onChange={event=>onBrush({eraserMode:event.currentTarget.value as "brush"|"pencil"|"block"})}><option value="brush">画笔</option><option value="pencil">铅笔</option><option value="block">块状</option></select></label>:null}
        <PaintNumberField label="笔尖角度（°）" value={brush.angle??0} min={-180} max={180} units={{unit:"°"}} inputScrub disabled={readonly || block} onChange={angle=>onBrush({angle:normalizeBrushAngle(angle)})}/>
        <PaintNumberField label="尺寸" value={brush.size} min={1} max={512} units={{unit:"px",dpi:resolutionDpi}} inputScrub disabled={readonly || block} onChange={size=>onBrush({size:clampBrushSize(size)})}/>
        <PaintNumberField label="硬度" value={brush.hardness*100} min={0} max={100} units={{unit:"%"}} disabled={readonly || pencil} onChange={value=>onBrush({hardness:value/100})}>
          <input type="range" min={0} max={100} value={Math.round(brush.hardness*100)} disabled={readonly || pencil} onChange={event=>onBrush({hardness:Number(event.currentTarget.value)/100})}/>
        </PaintNumberField>
        <PaintNumberField label="不透明度" value={brush.opacity*100} min={0} max={100} units={{unit:"%"}} disabled={readonly || block} onChange={value=>onBrush({opacity:value/100})}>
          <input type="range" min={0} max={100} value={Math.round(brush.opacity*100)} disabled={readonly || block} onChange={event=>onBrush({opacity:Number(event.currentTarget.value)/100})}/>
        </PaintNumberField>
        <PaintNumberField label="流量" value={brush.flow*100} min={0} max={100} units={{unit:"%"}} disabled={readonly || pencil} onChange={value=>onBrush({flow:value/100})}>
          <input type="range" min={0} max={100} value={Math.round(brush.flow*100)} disabled={readonly || pencil} onChange={event=>onBrush({flow:Number(event.currentTarget.value)/100})}/>
        </PaintNumberField>
        <PaintNumberField label="平滑" value={brush.smoothing*100} min={0} max={100} units={{unit:"%"}} disabled={readonly || block} onChange={value=>onBrush({smoothing:value/100})}>
          <input type="range" min={0} max={100} value={Math.round(brush.smoothing*100)} disabled={readonly || block} onChange={event=>onBrush({smoothing:Number(event.currentTarget.value)/100})}/>
        </PaintNumberField>
        <label>
          颜色
          <input
            type="color"
            value={isHexColor(brush.color) ? brush.color : "#000000"}
            disabled={readonly || block}
            onChange={(event) => onBrush({ color: event.currentTarget.value })}
          />
        </label>
        <label>
          目标
          <select
            value={brush.target}
            disabled={readonly || block}
            onChange={(event) => onBrush({ target: event.currentTarget.value as BrushSettings["target"] })}
          >
            <option value="pixels">像素层</option>
            <option value="mask">蒙版</option>
          </select>
        </label>
      </section> : null}

      {surface!=="tools" ? <section className="photo-editor__options-group" aria-label="文字" hidden={property !== "text"}>
        <span className="photo-editor__options-title">文字</span>
        <span className="photo-editor__option-hint">{textActive ? `Enter 换行，Ctrl/Cmd+Enter 确认，Esc ${textEscapeCommits?"确认":"取消"}。` : "点击图片输入文字，拖动创建段落框。"}</span>
        <label>方向<select value={text.orientation??"horizontal"} disabled={readonly || textComposing} onChange={event=>onText({orientation:event.currentTarget.value as "horizontal"|"vertical"})}><option value="horizontal">横排</option><option value="vertical">竖排</option></select></label>
        <label>抗锯齿<select value={text.antialias??"smooth"} disabled={readonly || textComposing} onChange={event=>onText({antialias:event.currentTarget.value as TextAntialias})}>{TEXT_ANTIALIAS.map(mode=><option key={mode.id} value={mode.id}>{mode.label}</option>)}</select></label>
        <label>字体<FontFamilyPicker fontPreview={fontPreview} readSample={readFontSample} english={fontNamesInEnglish} recentLimit={recentFontLimit} value={text.font} disabled={readonly} onChange={font=>onText({font})} onPreview={onPreviewFont}/></label>
        <label><input type="checkbox" checked={text.bold} disabled={readonly} onChange={(event) => onText({ bold: event.currentTarget.checked })} />粗体</label>
        <label>
          字号
          <ArithmeticInput

            min={1}
            max={1000}
            invalidate units={{unit:"pt"}} value={text.size}
            disabled={readonly}
            onChange={(event) => onText({ size: event.currentTarget.value.trim()===""?NaN:Math.max(1, Number(event.currentTarget.value)) })}
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
          onApply={() => onEndAdjustment?.(true)} editing
          samples={curveSamples} onEnd={onEndAdjustment} cancelRevision={adjustmentCancelRevision} /> : null}
        {["brightnessContrast","hueSaturation","curves"].includes(editingAdjustment??"")?<Button size="sm" tone="ghost" disabled={readonly}
          onPointerDown={event=>event.preventDefault()} onClick={()=>{
            if(readonly)return;
            if(editingAdjustment==="curves")onCurvePoints([[0,0],[255,255]]);
            else onAdjustment(editingAdjustment==="brightnessContrast"?{brightness:0,contrast:0}:{hue:0,saturation:0,lightness:0});
            onEndAdjustment?.(true);
          }}>恢复调整默认值</Button>:null}
        {adjustmentActive ? <>
          <Button size="sm" disabled={readonly} onClick={()=>onEndAdjustment?.(true)}>确认调整</Button>
          <Button size="sm" tone="ghost" onPointerDown={(event)=>{event.preventDefault();onEndAdjustment?.(false);}} onClick={()=>onEndAdjustment?.(false)}>取消调整</Button>
        </> : null}
      </section> : null}
    </div>
  );
}
