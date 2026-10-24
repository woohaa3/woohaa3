/**
 * 新建文档对话框（I064）。
 *
 * 只编排固定引擎已提供的命令：`document.presets.list|get|save|delete` 管理命名预设，
 * `document.recent.list|add` 提供最近设置，`file.new` 是唯一建文档的写入口。
 *
 * 单位只影响显示与输入换算；提交给 `file.new` 的 `width`/`height` 永远是像素，
 * `resolution` 永远是 ppi，与上游 `DocumentSettings` 一致。
 */
import {useEffect,useMemo,useRef,useState} from "react";
import type {EditorDialogPort,EditorDialogRendererProps} from "./ports.js";
import type{EditorWorkspaceController} from "./editor-workspace.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";
import {ArithmeticInput} from "./arithmetic-input.js";

const DIALOG="image-editor.new-document";

/** 显示单位与像素的换算；ppi 固定为 72，故 1in = 72px。 */
export const DOCUMENT_UNITS=[["px","像素",1],["in","英寸",72],["cm","厘米",72/2.54],["mm","毫米",7.2],["pt","点",1],["pica","派卡",12]] as const;
export type DocumentUnit=typeof DOCUMENT_UNITS[number][0];

export type NewDocumentSettings={
  width:number;height:number;resolution:number;
  mode:"rgb"|"gray"|"grayscale"|"cmyk"|"lab";
  depth:8|16|32;
  background:"white"|"black"|"transparent"|"backgroundColor"|string;
  unit:DocumentUnit;
};

export const DEFAULT_NEW_DOCUMENT:NewDocumentSettings={
  width:1920,height:1080,resolution:72,mode:"rgb",depth:8,background:"white",unit:"px"
};

/** 严格的设置解码：字段缺失或越界返回 null，不用猜测值建文档。 */
export function decodeDocumentSettings(value:unknown):NewDocumentSettings|null {
  if(!value||typeof value!=="object")return null;
  const raw=value as Record<string,unknown>;
  const count=(key:string)=>typeof raw[key]==="number"&&Number.isFinite(raw[key])?raw[key] as number:null;
  const width=count("width"),height=count("height"),resolution=count("resolution");
  if(width===null||height===null||resolution===null)return null;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||width>300_000||height<1||height>300_000||resolution<1||resolution>30_000)return null;
  const mode=raw.mode;
  if(!(mode==="rgb"||mode==="gray"||mode==="grayscale"||mode==="cmyk"||mode==="lab"))return null;
  const depth=raw.depth;
  if(!(depth===8||depth===16||depth===32))return null;
  const background=raw.background;
  if(typeof background!=="string"||!background)return null;
  if(!(background==="white"||background==="black"||background==="transparent"||background==="backgroundColor"||/^#[0-9a-f]{6}$/i.test(background)))return null;
  const unit=raw.unit;
  if(typeof unit!=="string"||!DOCUMENT_UNITS.some(([id])=>id===unit))return null;
  return {width,height,resolution,mode,depth,background,unit:unit as DocumentUnit};
}

/** 从像素换算到显示单位（保留两位小数）。 */
export function pixelsToUnit(px:number,unit:DocumentUnit):number {
  const factor=DOCUMENT_UNITS.find(([id])=>id===unit)?.[2]??1;
  return Math.round((px/factor)*100)/100;
}
/** 从显示单位换算回整数像素。 */
export function unitToPixels(value:number,unit:DocumentUnit):number {
  const factor=DOCUMENT_UNITS.find(([id])=>id===unit)?.[2]??1;
  return Math.round(value*factor);
}

/** `file.new` 的命令参数：只提交已核验的字段。 */
export function newDocumentParams(settings:NewDocumentSettings):Record<string,unknown> {
  return {width:settings.width,height:settings.height,resolution:settings.resolution,
    mode:settings.mode,depth:settings.depth,background:settings.background};
}

const MAX_NAME=255;
export function normalizeDocumentPresetName(value:string):string|null {
  const name=value.trim();
  return name&&name.length<=MAX_NAME?name:null;
}

function NewDocumentDialog({instance,requestClose,initial,presets,recent,apply,save,remove}:EditorDialogRendererProps & {
  initial:NewDocumentSettings;
  presets:readonly string[];
  recent:readonly NewDocumentSettings[];
  apply:(settings:NewDocumentSettings)=>string|null;
  save?:(name:string,settings:NewDocumentSettings)=>string|null;
  remove?:(name:string)=>string|null;
}) {
  const [value,setValue]=useState(initial);
  const [name,setName]=useState("");
  const [chosen,setChosen]=useState("");
  const [error,setError]=useState<string|null>(null);
  const [localPresets,setLocalPresets]=useState<readonly string[]>(presets);
  const update=(patch:Partial<NewDocumentSettings>)=>setValue(current=>({...current,...patch}));
  const valid=value.width>=1&&value.height>=1&&value.resolution>=1;
  const presetOptions=useMemo(()=>[{id:"",label:"自定义"},...localPresets.map(id=>({id,label:id})),...recent.map((setting,index)=>({id:`recent-${index}`,label:`最近 ${index+1}：${setting.width}×${setting.height}`}))],[localPresets,recent]);
  return <DialogContent size="sm" instanceId={instance.instanceId} ariaLabel="新建文档"><form onSubmit={event=>{event.preventDefault();if(!valid){setError("宽高与分辨率必须大于零");return;}const failure=apply(value);if(failure)setError(failure);else requestClose();}}>
    <DialogHeader onClose={requestClose}><DialogTitle>新建文档</DialogTitle></DialogHeader><DialogBody>
      <label>预设<select value={chosen} onChange={event=>{
        const id=event.currentTarget.value;setChosen(id);
        if(!id)return;
        if(id.startsWith("recent-")){const index=Number(id.slice(7));const setting=recent[index];if(setting)setValue(setting);return;}
        const preset=presets.find(item=>item===id);if(preset)setValue(current=>({...current,name:preset}));
      }}>{presetOptions.map(option=><option key={option.id||"none"} value={option.id}>{option.label}</option>)}</select></label>
      <label>宽度<ArithmeticInput invalidate min={1} max={300000} step="any" value={String(pixelsToUnit(value.width,value.unit))}
        onChange={event=>{const next=Number(event.currentTarget.value);if(Number.isFinite(next)&&next>0)update({width:unitToPixels(next,value.unit)});}}/></label>
      <label>高度<ArithmeticInput invalidate min={1} max={300000} step="any" value={String(pixelsToUnit(value.height,value.unit))}
        onChange={event=>{const next=Number(event.currentTarget.value);if(Number.isFinite(next)&&next>0)update({height:unitToPixels(next,value.unit)});}}/></label>
      <label>单位<select value={value.unit} onChange={event=>update({unit:event.currentTarget.value as DocumentUnit})}>{DOCUMENT_UNITS.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
      <label>分辨率（ppi）<ArithmeticInput invalidate min={1} max={30000} step="any" value={String(value.resolution)}
        onChange={event=>{const next=Number(event.currentTarget.value);if(Number.isFinite(next)&&next>0)update({resolution:next});}}/></label>
      <label>颜色模式<select value={value.mode} onChange={event=>update({mode:event.currentTarget.value as NewDocumentSettings["mode"]})}>
        <option value="rgb">RGB</option><option value="gray">灰度</option><option value="cmyk">CMYK</option><option value="lab">Lab</option></select></label>
      <label>位深<select value={String(value.depth)} onChange={event=>update({depth:Number(event.currentTarget.value) as NewDocumentSettings["depth"]})}>
        <option value="8">8 位</option><option value="16">16 位</option><option value="32">32 位</option></select></label>
      <label>背景<select value={value.background} onChange={event=>update({background:event.currentTarget.value})}>
        <option value="white">白色</option><option value="black">黑色</option><option value="transparent">透明</option><option value="backgroundColor">背景色</option></select></label>
      <label>预设名称<input type="text" value={name} maxLength={MAX_NAME} onChange={event=>setName(event.currentTarget.value)}/></label>
      <div className="photo-editor__new-document-actions">
        <Button type="button" size="sm" disabled={!save||!normalizeDocumentPresetName(name)} onClick={()=>{
          if(!save)return;const preset=normalizeDocumentPresetName(name);if(!preset){setError("请输入预设名称");return;}
          const failure=save(preset,value);if(failure){setError(failure);return;}
          setLocalPresets(current=>current.includes(preset)?current:[...current,preset]);setError(null);
        }}>存储预设</Button>
        <Button type="button" size="sm" disabled={!remove||!localPresets.length} onClick={()=>{
          if(!remove)return;const target=localPresets[localPresets.length-1];if(!target)return;
          const failure=remove(target);if(failure){setError(failure);return;}
          setLocalPresets(current=>current.filter(item=>item!==target));setError(null);
        }}>删除预设</Button>
      </div>
      <p>尺寸按 {value.unit} 显示，提交时换算为像素；新建不受当前文档影响。</p>
      {error?<p className="dlg__error">{error}</p>:null}
    </DialogBody><DialogFooter><Button type="button" onClick={requestClose}>取消</Button><Button type="submit" tone="primary" disabled={!valid}>创建</Button></DialogFooter>
  </form></DialogContent>;
}

/** 读取命名预设与最近设置；失败返回空表，不阻塞手动输入。 */
export function readNewDocumentOptions(controller:EditorWorkspaceController):{presets:string[];recent:NewDocumentSettings[]} {
  const presets:string[]=[];
  const listed=controller.documentPresets();
  if(listed.ok){try{
    const value=listed.value as {presets?:unknown};
    if(Array.isArray(value.presets))for(const entry of value.presets){
      const name=entry&&typeof entry==="object"?(entry as Record<string,unknown>).name:undefined;
      if(typeof name==="string"&&name)presets.push(name);
    }
  }catch{/* 预设表损坏时退回手动输入 */}}
  const recent:NewDocumentSettings[]=[];
  const listedRecent=controller.recentDocuments();
  if(listedRecent.ok){try{
    const value=listedRecent.value as {recent?:unknown};
    if(Array.isArray(value.recent))for(const entry of value.recent){
      const settings=decodeDocumentSettings(entry);if(settings)recent.push(settings);
    }
  }catch{/* 同上 */}}
  return {presets,recent};
}

export function useNewDocumentDialog(dialogs:EditorDialogPort|undefined,controller:EditorWorkspaceController,blocked:()=>boolean) {
  const latest=useRef({blocked});latest.current={blocked};
  const instance=useRef<string|null>(null),request=useRef<{owner:string}|null>(null),opening=useRef(false);
  const owner=()=>JSON.stringify([controller.dialogOwner(),controller.snapshot().view.sessionActiveIndex]);
  useEffect(()=>{
    if(!dialogs)return;
    const unregister=dialogs.registerDialog(DIALOG,{definition:{singleton:true,size:"sm",editingOwner:()=>opening.current&&!latest.current.blocked()?controller.dialogOwner():null,validatePayload:p=>p==null?{ok:true,payload:null}:{ok:false,error:"无效的新建文档请求"}},renderer:props=>{
      const captured=request.current;if(!captured)return null;
      const {presets,recent}=readNewDocumentOptions(controller);
      const guard=()=>latest.current.blocked()||request.current!==captured||captured.owner!==owner()||instance.current!==props.instance.instanceId||dialogs.top()?.instanceId!==props.instance.instanceId;
      return <NewDocumentDialog {...props} initial={DEFAULT_NEW_DOCUMENT} presets={presets} recent={recent}
        apply={settings=>{
          if(guard())return "编辑器状态已变化，请关闭后重试";
          const command=controller.snapshot().commands.get("file.new");
          if(!command?.allowed||!command.enabled)return command?.disabledReason??"当前无法新建文档";
          const params=newDocumentParams(settings);
          const result=controller.dispatch("file.new",params);
          if(!result.ok)return result.message;
          // 记录最近设置，失败不影响已创建的文档。
          controller.addRecentDocument({unit:settings.unit,resolutionUnit:"in",...params});
          return null;
        }}
        save={controller.documentPresetSave?(name,settings)=>{
          if(guard())return "编辑器状态已变化，请关闭后重试";
          const result=controller.documentPresetSave(name,{...newDocumentParams(settings),unit:settings.unit,resolutionUnit:"in"});
          return result.ok?null:result.message;
        }:undefined}
        remove={controller.documentPresetDelete?(name)=>{
          if(guard())return "编辑器状态已变化，请关闭后重试";
          const result=controller.documentPresetDelete(name);
          return result.ok?null:result.message;
        }:undefined}/>;
    }});
    return()=>{if(instance.current)dialogs.close(instance.current);instance.current=null;request.current=null;unregister();};
  },[dialogs,controller]);
  useEffect(()=>{if(latest.current.blocked()&&instance.current){dialogs?.close(instance.current);instance.current=null;request.current=null;}},[dialogs]);
  return {available:!!dialogs,open:()=>{
    if(!dialogs||latest.current.blocked()||dialogs.isModalActive())return false;
    const command=controller.snapshot().commands.get("file.new");
    if(!command?.allowed||!command.enabled)return false;
    request.current={owner:owner()};opening.current=true;
    try{const result=dialogs.open({dialogId:DIALOG});if(!result.ok){request.current=null;return false;}instance.current=result.instance.instanceId;return true;}finally{opening.current=false;}
  }};
}
