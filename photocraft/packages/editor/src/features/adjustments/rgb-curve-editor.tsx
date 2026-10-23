import {useEffect,useRef,useState,type PointerEvent} from "react";
import {Button} from "../../ui/Button.js";
import {Popover} from "../../ui/Popover.js";

export type CurvePoint = [number, number];
export function validCurve(points: readonly CurvePoint[]): boolean {
  return points.length>=2 && points.length<=16 && points.every(([x,y],index)=>
    Number.isFinite(x) && Number.isFinite(y) && x>=0 && x<=255 && y>=0 && y<=255 && (index===0 || x>points[index-1]![0]));
}
const copy=(points:CurvePoint[])=>points.map(([x,y])=>[x,y] as CurvePoint);

/** RGB 总曲线；图形读取内核样条采样，控制点只管理输入。 */
export function RgbCurveEditor({points,onChange,readonly,onApply,editing,samples=[],onEnd=()=>true,disabledBySession=false,cancelRevision=0}: {
  points:CurvePoint[];onChange:(points:CurvePoint[])=>void;readonly:boolean;onApply:()=>void;editing:boolean;
  samples?:number[];onEnd?:(commit:boolean)=>boolean;disabledBySession?:boolean;
  cancelRevision?:number;
}) {
  const [open,setOpen]=useState(false);
  const [selected,setSelected]=useState(0);
  const current=useRef(points);current.current=points;
  const original=useRef<CurvePoint[]|null>(null);
  const drag=useRef<{id:number;index:number;start:CurvePoint;moved:boolean}|null>(null);
  const blocked=readonly || disabledBySession;
  const valid=validCurve(points);
  useEffect(()=>{drag.current=null;original.current=null;},[cancelRevision]);
  const start=()=>{original.current??=copy(current.current);};
  const change=(next:CurvePoint[])=>{start();current.current=next;onChange(next);};
  const finish=(commit:boolean)=>{
    if (commit && !validCurve(current.current)) return false;
    if (!onEnd(commit)) return false;
    if (!commit && !editing && original.current) {current.current=original.current;onChange(original.current);}
    original.current=null;drag.current=null;return true;
  };
  useEffect(()=>{
    if (!blocked) return;
    drag.current=null;original.current=null;setOpen(false);
  },[blocked]);
  const position=(event:PointerEvent<SVGSVGElement>):CurvePoint=>{
    const rect=event.currentTarget.getBoundingClientRect();
    return [Math.round(Math.max(0,Math.min(255,(event.clientX-rect.left)/rect.width*255))),
      Math.round(Math.max(0,Math.min(255,255-(event.clientY-rect.top)/rect.height*255)))];
  };
  const move=(index:number,[x,y]:CurvePoint)=>{
    const all=current.current;
    const lower=index===0?0:Math.min(all[index]![0],all[index-1]![0]+1);
    const upper=index===all.length-1?255:Math.max(all[index]![0],all[index+1]![0]-1);
    x=Math.max(lower,Math.min(upper,x));
    if (x===all[index]?.[0] && y===all[index]?.[1]) return;
    change(all.map((point,i)=>i===index?[x,y]:point));
  };
  const remove=()=>{
    if (blocked || selected<=0 || selected>=current.current.length-1) return;
    change(current.current.filter((_,i)=>i!==selected));setSelected(selected-1);finish(true);
  };
  const add=()=>{
    const all=current.current;let gap=0;
    for (let i=1;i<all.length-1;i++) if (all[i+1]![0]-all[i]![0]>all[gap+1]![0]-all[gap]![0]) gap=i;
    const left=all[gap]!,right=all[gap+1]!;
    change([...all.slice(0,gap+1),[Math.round((left[0]+right[0])/2),Math.round((left[1]+right[1])/2)],...all.slice(gap+1)]);
    setSelected(gap+1);finish(true);
  };
  return <Popover open={open} dismissOnEscape={false} onOpenChange={(next)=>{if (next || finish(true)) setOpen(next);}}
    trigger={<Button size="sm" tone="ghost" disabled={blocked}>RGB 曲线</Button>}>
    <div className="photo-editor-curve" onKeyDown={(event)=>{
      if (event.nativeEvent.isComposing || event.keyCode===229) return;
      if (event.key==="Escape") {event.preventDefault();event.stopPropagation();finish(false);return;}
      if (event.key==="Enter") {event.preventDefault();event.stopPropagation();finish(true);return;}
      if ((event.key==="Delete" || event.key==="Backspace") && !(event.target instanceof HTMLInputElement)) {
        event.preventDefault();event.stopPropagation();remove();
      }
    }}>
      <span className="photo-editor__options-title">RGB 总曲线</span>
      <svg viewBox="0 0 255 255" width="192" height="192" tabIndex={0} data-curve-graph
        onPointerDown={(event)=>{
          if (blocked || !valid || event.button!==0) return;
          event.preventDefault();event.currentTarget.focus();start();
          const at=position(event);let index=-1,best=14;
          current.current.forEach(([x,y],i)=>{const distance=Math.hypot(x-at[0],y-at[1]);if (distance<best) {best=distance;index=i;}});
          if (index<0) {
            if (current.current.length>=16 || current.current.some(([x])=>Math.abs(x-at[0])<1)) return;
            index=current.current.findIndex(([x])=>x>at[0]);if (index<0) index=current.current.length;
            change([...current.current.slice(0,index),at,...current.current.slice(index)]);
          }
          setSelected(index);drag.current={id:event.pointerId,index,start:at,moved:false};event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event)=>{
          if (blocked || drag.current?.id!==event.pointerId) return;
          const at=position(event);
          if (Math.hypot(at[0]-drag.current.start[0],at[1]-drag.current.start[1])>1) drag.current.moved=true;
          if (drag.current.moved) move(drag.current.index,at);
        }}
        onPointerUp={(event)=>{
          if (drag.current?.id!==event.pointerId) return;
          const at=position(event);
          if (drag.current.moved || Math.hypot(at[0]-drag.current.start[0],at[1]-drag.current.start[1])>2) move(drag.current.index,at);
          finish(true);drag.current=null;
          if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={()=>{if (drag.current) finish(false);}}
        onLostPointerCapture={()=>{if (drag.current) finish(false);}}>
        <path d="M0 255L255 0 M0 128H255 M128 0V255" className="photo-editor-curve__grid" />
        {valid && samples.length===256 ? <polyline points={samples.map((y,x)=>`${x},${255-y}`).join(" ")} /> : null}
        {points.map(([x,y],i)=>Number.isFinite(x) && Number.isFinite(y) ? <circle key={i} cx={x} cy={255-y} r={selected===i?5:3} data-selected={selected===i} /> : null)}
      </svg>
      <span className="photo-editor__option-hint">点击添加或选择点，拖动调整；Delete 删除中间点，Esc 撤回当前操作。</span>
      <div className="photo-editor-curve__points">
        {points.map((point,index)=><div key={index} data-selected={selected===index}>
          {(["输入","输出"] as const).map((label,axis)=><label key={label}>{label}<input type="number" min={0} max={255}
            value={Number.isFinite(point[axis])?point[axis]:""} disabled={blocked}
            onFocus={()=>{start();setSelected(index);}}
            onChange={(event)=>change(current.current.map((p,i)=>i===index?p.map((n,a)=>a===axis?event.currentTarget.valueAsNumber:n) as CurvePoint:p))}
            onBlur={()=>finish(true)} /></label>)}
          <Button size="sm" tone="ghost" disabled={blocked || index===0 || index===points.length-1} onClick={()=>{
            change(current.current.filter((_,i)=>i!==index));setSelected(Math.max(0,index-1));finish(true);
          }}>移除</Button>
        </div>)}
      </div>
      {!valid ? <p className="photo-editor__message">输入值须从小到大且不重复，输入与输出均为 0–255。</p> : null}
      <div className="photo-editor__options-group">
        <Button size="sm" tone="ghost" disabled={blocked || !valid || points.length>=16 || !points.some((p,i)=>i>0 && p[0]-points[i-1]![0]>1)} onClick={add}>添加点</Button>
        <Button size="sm" tone="ghost" disabled={blocked} onClick={()=>{change([[0,0],[255,255]]);setSelected(0);finish(true);}}>重置</Button>
        {editing ? <Button size="sm" disabled={blocked || !valid} onClick={()=>{if (finish(true)) setOpen(false);}}>完成</Button>
          : <Button size="sm" disabled={blocked || !valid} onClick={()=>{if (finish(true)) {onApply();setOpen(false);}}}>新建曲线层</Button>}
      </div>
    </div>
  </Popover>;
}
