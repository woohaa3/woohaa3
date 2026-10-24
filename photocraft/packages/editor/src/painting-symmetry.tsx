import {useCallback,useEffect,useRef,useState} from "react";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import {Button} from "./ui/Button.js";
export type SymmetryMode="vertical"|"horizontal"|"dual"|"diagonal";
export type SymmetryPreset={mode:SymmetryMode;center:[number,number];rotation:number};
export type PaintingSymmetry={mode:SymmetryMode|"path";center?:[number,number];rotation?:number;source?:string;segments:number[][][]};
export function decodePaintingSymmetry(input:unknown):PaintingSymmetry|null {
 if(!input || typeof input!=="object")return null;
 const v=input as Record<string,unknown>;
 if(!["vertical","horizontal","dual","diagonal","path"].includes(String(v.mode)))return null;
 const segments=Array.isArray(v.segments)?v.segments.filter((s):s is number[][]=>Array.isArray(s)&&s.length===2&&s.every(p=>Array.isArray(p)&&p.length===2&&p.every(n=>typeof n==="number"&&Number.isFinite(n)&&Math.abs(n)<=1e6))).slice(0,1024):[];
 if(v.mode==="path")return typeof v.source==="string"?{mode:"path",source:v.source,segments}:null;
 if(!Array.isArray(v.center)||v.center.length!==2||!v.center.every(n=>typeof n==="number"&&Number.isFinite(n)&&Math.abs(n)<=1e6)||typeof v.rotation!=="number"||!Number.isFinite(v.rotation))return null;
 return {mode:v.mode as SymmetryMode,center:v.center as [number,number],rotation:v.rotation,segments};
}
export function symmetryDirections(p:SymmetryPreset):[number,number][] {
 const a=((p.mode==="horizontal"?0:p.mode==="diagonal"?45:90)+p.rotation)*Math.PI/180;
 const d:[number,number]=[Math.cos(a),Math.sin(a)];return p.mode==="dual"?[d,[-d[1],d[0]]]:[d];
}
export function rotateSymmetry(p:SymmetryPreset,x:number,y:number,snap:boolean):SymmetryPreset {
 const initial=p.mode==="horizontal"?0:p.mode==="diagonal"?45:90;
 const angle=Math.atan2(y-p.center[1],x-p.center[0])*180/Math.PI-initial;
 return {...p,rotation:snap?Math.round(angle/15)*15:angle};
}
export function usePaintingSymmetry(controller:EditorWorkspaceController,current:PaintingSymmetry|null,paths:string[],owner:string,disabled:boolean,hasGesture:()=>boolean,message:(text:string|null)=>void) {
 const [draft,setDraft]=useState<SymmetryPreset|null>(null);
 const latest=useRef(draft);latest.current=draft;
 const cancel=useCallback(()=>{latest.current=null;setDraft(null);},[]);
 const source=JSON.stringify(current);
 useEffect(()=>{cancel();},[owner,source,disabled,cancel]);
 const invoke=(id:string,params:unknown)=>{
  const command=controller.snapshot().commands.get(id);
  if(disabled || hasGesture() || !command?.allowed || !command.enabled)return false;
  const result=controller.dispatch(id,params);message(result.ok?null:result.message);return result.ok;
 };
 const finish=(commit:boolean)=>{
  const value=latest.current;if(!value)return;
  if(!commit || invoke("paint.setSymmetry",value))cancel();
 };
 const begin=()=>{if(!disabled&&!hasGesture()&&current&&current.mode!=="path"&&current.center){const value={mode:current.mode,center:[...current.center] as [number,number],rotation:current.rotation??0};latest.current=value;setDraft(value);}};
 const value=draft??current;
 const available=controller.snapshot().commands.get("paint.setSymmetry")?.allowed===true;
 const controls=!available?null:draft?<><span>变换绘画对称</span><Button size="sm" onClick={()=>finish(true)}>确认对称变换</Button><Button size="sm" tone="ghost" onClick={()=>finish(false)}>取消对称变换</Button></>:<>
  <label>绘画对称<select disabled={disabled} value={!current?"off":current.mode==="path"?`path:${current.source}`:current.mode} onChange={event=>{const mode=event.currentTarget.value;if(mode==="off")invoke("paint.symmetryDisable",{});else if(mode.startsWith("path:"))invoke("paint.symmetryFromPath",{name:mode.slice(5)});else invoke("paint.setSymmetry",{mode});}}>
   <option value="off">关闭</option><option value="vertical">垂直</option><option value="horizontal">水平</option><option value="dual">双轴</option><option value="diagonal">对角轴</option>{paths.map(path=><option key={path} value={`path:${path}`}>路径：{path==="work"?"工作路径":path==="layer"?"当前图层":path}</option>)}
  </select></label><Button size="sm" disabled={disabled||!current||current.mode==="path"} onClick={begin}>变换对称</Button>
 </>;
 const update=(next:SymmetryPreset)=>{latest.current=next;setDraft(next);};
 return {active:!!draft,cancel,finish,controls,overlay:(origin:{x:number;y:number},zoom:number,width:number,height:number)=>value?<SymmetryOverlay value={value} draft={draft} origin={origin} zoom={zoom} width={width} height={height} onChange={update}/>:null};
}
function SymmetryOverlay({value,draft,origin,zoom,width,height,onChange}:{value:PaintingSymmetry|SymmetryPreset;draft:SymmetryPreset|null;origin:{x:number;y:number};zoom:number;width:number;height:number;onChange:(p:SymmetryPreset)=>void}) {
 const drag=useRef<{id:number;kind:"center"|"rotate";x:number;y:number;base:SymmetryPreset}|null>(null);
 useEffect(()=>{if(!draft)drag.current=null;},[draft]);
 const preset=value.mode!=="path"&&value.center?{mode:value.mode,center:value.center,rotation:value.rotation??0}:null;
 const extent=Math.hypot(width,height)*2+(preset?Math.hypot(...preset.center):0)+1;
 const lines=preset?symmetryDirections(preset).map(([dx,dy])=>[[preset.center[0]-dx*extent,preset.center[1]-dy*extent],[preset.center[0]+dx*extent,preset.center[1]+dy*extent]]):"segments" in value?value.segments:[];
 const center=preset?{x:origin.x+preset.center[0]*zoom,y:origin.y+preset.center[1]*zoom}:null;
 const direction=preset?symmetryDirections(preset)[0]:[0,1];
 const handle=center?{x:center.x+direction[0]*64,y:center.y+direction[1]*64}:null;
 const move=(x:number,y:number,shift:boolean)=>{
  const d=drag.current;if(!d)return;
  if(d.kind==="center")onChange({...d.base,center:[Math.max(-1e6,Math.min(1e6,d.base.center[0]+(x-d.x)/zoom)),Math.max(-1e6,Math.min(1e6,d.base.center[1]+(y-d.y)/zoom))]});
  else onChange(rotateSymmetry(d.base,d.base.center[0]+(x-d.x)/zoom,d.base.center[1]+(y-d.y)/zoom,shift));
 };
 return <svg className="photo-editor-canvas__symmetry" data-symmetry-editing={draft?"true":undefined} onPointerMove={event=>{if(drag.current?.id!==event.pointerId)return;event.preventDefault();event.stopPropagation();move(event.clientX,event.clientY,event.shiftKey);}} onPointerUp={event=>{if(drag.current?.id!==event.pointerId)return;event.preventDefault();event.stopPropagation();move(event.clientX,event.clientY,event.shiftKey);drag.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}} onPointerCancel={event=>{if(drag.current?.id!==event.pointerId)return;onChange(drag.current.base);drag.current=null;event.stopPropagation();}} onLostPointerCapture={()=>{drag.current=null;}}>
  {lines.map((s,i)=><line key={i} x1={origin.x+s[0][0]*zoom} y1={origin.y+s[0][1]*zoom} x2={origin.x+s[1][0]*zoom} y2={origin.y+s[1][1]*zoom}/>)}
  {draft&&center&&handle?(["center","rotate"] as const).map(kind=><circle key={kind} data-symmetry-handle={kind} cx={kind==="center"?center.x:handle.x} cy={kind==="center"?center.y:handle.y} r={7} onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();event.stopPropagation();const svg=event.currentTarget.ownerSVGElement!;const rect=svg.getBoundingClientRect();drag.current={id:event.pointerId,kind,x:kind==="center"?event.clientX:rect.left+center.x,y:kind==="center"?event.clientY:rect.top+center.y,base:{...draft,center:[...draft.center]}};svg.setPointerCapture(event.pointerId);}}/>):null}
 </svg>;
}
