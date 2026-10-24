/**
 * 画笔预设面板（I058/I132/I136）。
 *
 * 预设本身由固定引擎持有（`brush.presets.*`、`brush.defineFromSelection`）；本模块只负责
 * 列出、命名、应用、更新与删除，并把「从选区定义画笔」的命名表单接到同一命令。
 *
 * 预设属于会话状态：不改工程内容、修订或历史。真正绘画仍走 `paint.stroke`/`paint.pencil`。
 */
import {useCallback,useEffect,useState} from "react";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import {Button} from "./ui/Button.js";

export type BrushPresetRow = {name:string;builtin:boolean;size:number;hardness:number;tip:string};

/** 严格解码原生 `brush.presets.list`：字段缺失或越界视为无效，不猜测。 */
export function decodeBrushPresets(value:unknown):BrushPresetRow[] {
  const invalid=()=>{throw new Error("画笔预设响应无效");};
  if(!value||typeof value!=="object")return invalid();
  const presets=(value as {presets?:unknown}).presets;
  if(!Array.isArray(presets))return invalid();
  return presets.map(entry=>{
    if(!entry||typeof entry!=="object")return invalid();
    const row=entry as Record<string,unknown>;
    if(typeof row.name!=="string"||!row.name)return invalid();
    if(typeof row.builtin!=="boolean")return invalid();
    if(typeof row.size!=="number"||!Number.isFinite(row.size)||row.size<1||row.size>5000)return invalid();
    if(typeof row.hardness!=="number"||!Number.isFinite(row.hardness))return invalid();
    if(typeof row.tip!=="string")return invalid();
    return {name:row.name,builtin:row.builtin,size:Math.round(row.size),hardness:row.hardness,tip:row.tip};
  });
}

/** 预设名称的本地规范化：去首尾空白、限制长度、拒绝纯空白。 */
export function normalizePresetName(value:string):string|null {
  const name=value.trim();
  if(!name||name.length>128)return null;
  return name;
}

export type BrushPresetPanelProps = {
  controller:EditorWorkspaceController;
  /** 面板可见时才读取预设，关闭时不发命令。 */
  visible:boolean;
  disabled:boolean;
  /** 当前文档标识：切换文档后重新读取。 */
  documentKey:string;
  /** 「从选区定义画笔」要求选区与像素目标都由命令门禁判定。 */
  canDefineFromSelection:boolean;
  defineBlockedReason?:string;
};

export function BrushPresetPanel({controller,visible,disabled,documentKey,canDefineFromSelection,defineBlockedReason}:BrushPresetPanelProps) {
  const [presets,setPresets]=useState<BrushPresetRow[]>([]);
  const [name,setName]=useState("");
  const [error,setError]=useState<string|null>(null);
  const refresh=useCallback(()=>{
    if(!visible)return;
    const result=controller.brushPresets();
    if(!result.ok){setError(result.message);return;}
    try{setPresets(decodeBrushPresets(result.value));setError(null);}catch(caught){setError(caught instanceof Error?caught.message:"画笔预设响应无效");}
  },[controller,visible]);
  useEffect(()=>{refresh();},[refresh,documentKey]);
  const run=(action:()=>{ok:boolean;message?:string},after?:()=>void)=>{
    if(disabled)return false;
    const result=action();
    if(!result.ok){setError(result.message??"画笔预设操作失败");return false;}
    setError(null);after?.();refresh();return true;
  };
  const save=()=>{
    const normalized=normalizePresetName(name);
    if(!normalized){setError("请输入预设名称（最多 128 个字符）");return;}
    if(run(()=>controller.saveBrushPreset(normalized)))setName("");
  };
  const define=()=>{
    const normalized=normalizePresetName(name);
    if(!normalized){setError("请输入画笔名称（最多 128 个字符）");return;}
    if(!canDefineFromSelection){setError(defineBlockedReason??"请先建立非空像素选区");return;}
    if(run(()=>controller.defineBrushFromSelection(normalized)))setName("");
  };
  if(!visible)return null;
  return <section className="photo-editor__panel-section" aria-label="画笔预设" data-brush-presets="true">
    <div className="photo-editor__panel-title">画笔预设</div>
    <label>名称<input type="text" value={name} maxLength={128} disabled={disabled}
      onChange={event=>setName(event.currentTarget.value)}/></label>
    <div className="photo-editor__brush-preset-actions">
      <Button size="sm" disabled={disabled||!name.trim()} onClick={save}>存储当前画笔</Button>
      <Button size="sm" disabled={disabled||!name.trim()||!canDefineFromSelection}
        title={canDefineFromSelection?undefined:defineBlockedReason}
        onClick={define}>从选区定义…</Button>
    </div>
    {error?<p className="photo-editor__panel-error">{error}</p>:null}
    {presets.length?<ul className="photo-editor__brush-presets" role="list">
      {presets.map(preset=><li key={preset.name} data-brush-preset={preset.name} data-builtin={preset.builtin?"true":undefined}>
        <span>{preset.name}</span>
        <small>{preset.size}px · {Math.round(preset.hardness*100)}% · {preset.tip==="sampled"?"采样笔尖":"圆笔尖"}</small>
        <Button size="sm" disabled={disabled} onClick={()=>run(()=>controller.setBrushPreset(preset.name))}>应用</Button>
        {preset.builtin?null:<>
          <Button size="sm" disabled={disabled} onClick={()=>run(()=>controller.updateBrushPreset(preset.name))}>更新</Button>
          <Button size="sm" disabled={disabled} onClick={()=>run(()=>controller.deleteBrushPreset(preset.name))}>删除</Button>
        </>}
      </li>)}
    </ul>:<p className="photo-editor__panel-hint">还没有自定义画笔；保存当前画笔或从选区定义一个。</p>}
  </section>;
}
