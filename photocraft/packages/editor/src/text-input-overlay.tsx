import {smartQuotedInput} from "./smart-quotes.js";
import { useLayoutEffect, useRef, useState } from "react";
import type { TextEditing } from "./use-text-editing.js";
import { textFrameContains, type TextPoint, type TextNavigation } from "./text-geometry.js";
import {resolveFontSizeStep,resolveTextFormatShortcut,type TextFormatCommand} from "./text-format-shortcuts.js";
import {boxHandleAt,boxHandlePoints,resizeTextBox,type BoxHandle} from "./text-box-resize.js";
import {isEditorMac} from "./photo-editor-shortcuts.js";

/** 文字输入覆盖层：只处理真实文字输入与原生框手柄，排版仍由内核拥有。 */
export function TextInputOverlay({editing,origin,zoom,disabled,onEnd,escapeCommits=true,smartQuotes=true,preciseCursor=false,onFormat}: {
  preciseCursor?:boolean;escapeCommits?:boolean;smartQuotes?:boolean; onFormat?:(command:TextFormatCommand)=>void; editing: TextEditing; origin: {x:number;y:number}; zoom: number; disabled: boolean; onEnd: (commit:boolean)=>void;
}) {
  const vertical=editing.style.orientation==="vertical";
  const input=useRef<HTMLTextAreaElement>(null);
  const clicks=useRef<{time:number;point:TextPoint;count:number}|null>(null);
  const drag=useRef<{pointer:number;anchor:number;point:TextPoint;moved:boolean} | null>(null);
  // 段落框缩放手势：按下时冻结框与变换，整个拖动从这份快照重算（Alt 中心因此固定）。
  const boxDrag=useRef<{pointer:number;handle:BoxHandle;snapshot:NonNullable<TextEditing["paragraphBox"]>}|null>(null);
  const [handle,setHandle]=useState<BoxHandle|null>(null);
  const paragraph=editing.paragraphBox;
  /** 手柄在文档坐标里的位置；仅在存在段落框与变换时出现。 */
  const handles=paragraph?boxHandlePoints(paragraph.rect,paragraph.transform):null;
  const pointerFree=()=>!drag.current && !boxDrag.current;
  useLayoutEffect(() => {
    const element=input.current;
    if (!element || disabled || editing.composing) return;
    element.focus({preventScroll:true});
    element.setSelectionRange(editing.selection.start,editing.selection.end,editing.selection.direction);
  },[editing.selection,editing.composing,disabled]);
  const local=([x,y]:TextPoint):TextPoint=>[origin.x+x*zoom,origin.y+y*zoom];
  const caret=editing.geometry?.caret.map(local);
  const start=caret?.[0] ?? [origin.x,origin.y];
  const end=caret?.[1] ?? start;
  const point=(event: {clientX:number;clientY:number;currentTarget:HTMLElement}):TextPoint => {
    const rect=event.currentTarget.getBoundingClientRect();
    return [(event.clientX-rect.left-origin.x)/zoom,(event.clientY-rect.top-origin.y)/zoom];
  };
  return <div style={{cursor:preciseCursor?"crosshair":undefined}} className="photo-editor-text" data-text-editing="true"
    onPointerDown={(event)=>{
      event.stopPropagation();
      if (disabled || editing.composing || event.button!==0 || drag.current || boxDrag.current) return;
      const hit=point(event);
      // 段落框手柄优先于框外提交：命中后拖动改草稿框，不结束输入。
      const grabbed=paragraph?boxHandleAt(paragraph.rect,paragraph.transform,hit,zoom):null;
      if(grabbed!==null && paragraph){
        event.preventDefault();boxDrag.current={pointer:event.pointerId,handle:grabbed,snapshot:paragraph};setHandle(grabbed);
        event.currentTarget.setPointerCapture(event.pointerId);input.current?.focus({preventScroll:true});return;
      }
      if(textFrameContains(editing.geometry?.frame,hit)===false) {event.preventDefault();onEnd(true);return;}
      const previous=clicks.current;
      const count=!event.shiftKey && previous && event.timeStamp-previous.time<500 && Math.hypot(hit[0]-previous.point[0],hit[1]-previous.point[1])*zoom<4 ? previous.count%5+1:1;
      clicks.current={time:event.timeStamp,point:hit,count};
      const unit=count===2?"word":count===3?"line":count===4?"paragraph":count===5?"all":undefined;
      const anchor=editing.hit(hit,event.shiftKey,undefined,unit);
      if (anchor===null) return;
      event.preventDefault();drag.current={pointer:event.pointerId,anchor,point:hit,moved:false};event.currentTarget.setPointerCapture(event.pointerId);
      input.current?.focus({preventScroll:true});
    }}
    onPointerMove={(event)=>{
      const dragState=boxDrag.current;
      if(dragState?.pointer===event.pointerId){
        editing.resizeBox(resizeTextBox({handle:dragState.handle,rect:dragState.snapshot.rect,transform:dragState.snapshot.transform,point:point(event),alt:event.altKey}));return;
      }
      if (paragraph && !disabled && !editing.composing && pointerFree()) setHandle(boxHandleAt(paragraph.rect,paragraph.transform,point(event),zoom));
      if (drag.current?.pointer===event.pointerId) {const hit=point(event);if(Math.hypot(hit[0]-drag.current.point[0],hit[1]-drag.current.point[1])*zoom>=3) drag.current.moved=true;if(drag.current.moved) editing.hit(hit,true,drag.current.anchor);}}}
    onPointerUp={(event)=>{
      const dragState=boxDrag.current;
      if(dragState?.pointer===event.pointerId){
        editing.resizeBox(resizeTextBox({handle:dragState.handle,rect:dragState.snapshot.rect,transform:dragState.snapshot.transform,point:point(event),alt:event.altKey}));
        boxDrag.current=null;setHandle(null);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        return;
      }
      if (drag.current?.pointer!==event.pointerId) return;
      if(drag.current.moved) editing.hit(point(event),true,drag.current.anchor);drag.current=null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={()=>{drag.current=null;boxDrag.current=null;setHandle(null);}} onLostPointerCapture={()=>{drag.current=null;boxDrag.current=null;setHandle(null);}} onPointerLeave={()=>{if(!boxDrag.current)setHandle(null);}}>
    <textarea ref={input} data-text-input="true" value={editing.style.text} disabled={disabled} wrap="off" spellCheck={false}
      style={{left:vertical?Math.min(start[0],end[0]):start[0],top:Math.min(start[1],end[1]),height:Math.max(1,Math.abs(end[1]-start[1])),width:vertical?Math.max(1,Math.abs(end[0]-start[0])):undefined,writingMode:vertical?"vertical-rl":undefined}}
      onChange={(event)=>{
        const element=event.currentTarget,native=event.nativeEvent as InputEvent;
        const text=smartQuotedInput(editing.style.text,element.value,element.selectionStart,native.inputType,native.data,smartQuotes,editing.composing || native.isComposing);
        editing.update({text},{start:element.selectionStart,end:element.selectionEnd,direction:element.selectionDirection});
      }}
      onSelect={(event)=>{if (!editing.composing && !event.nativeEvent.defaultPrevented) editing.select({start:event.currentTarget.selectionStart,end:event.currentTarget.selectionEnd,direction:event.currentTarget.selectionDirection});}}
      onCompositionStart={()=>editing.compositionStart()} onCompositionEnd={()=>editing.compositionEnd()}
      onKeyDown={(event)=>{
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode===229 || editing.composing) return;
        if(event.key==="Tab" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
          event.preventDefault();
          const {start,end}=editing.selection;
          editing.update({text:editing.style.text.slice(0,start)+"\t"+editing.style.text.slice(end)},{start:start+1,end:start+1,direction:"none"});return;
        }
        if (event.key==="Escape") {event.preventDefault();onEnd(escapeCommits);return;}
        if (event.key==="Enter" && (event.ctrlKey || event.metaKey)) {event.preventDefault();onEnd(true);return;}
        const size=resolveFontSizeStep(event.nativeEvent,isEditorMac());
        if(size!==null){event.preventDefault();const next=Math.min(1296,Math.max(0.1,Math.round((editing.style.size+size)*100)/100));editing.update({size:next});return;}
        const format=resolveTextFormatShortcut(event.nativeEvent,isEditorMac());
        if(format && onFormat){event.preventDefault();onFormat(format);return;}
        if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase()==="s" || event.key.toLowerCase()==="t")) {event.preventDefault();return;}
        const move:TextNavigation|undefined=vertical && event.key==="ArrowUp"?(event.altKey?"wordPrev":"charPrev"):vertical && event.key==="ArrowDown"?(event.altKey?"wordNext":"charNext")
          :vertical && event.key==="ArrowLeft"?"lineNext":vertical && event.key==="ArrowRight"?"linePrev":event.key==="ArrowUp"?"linePrev":event.key==="ArrowDown"?"lineNext"
          :event.key==="Home"?"lineStart":event.key==="End"?"lineEnd"
          :event.altKey && event.key==="ArrowLeft"?"wordPrev":event.altKey && event.key==="ArrowRight"?"wordNext":undefined;
        if (move) {event.preventDefault();editing.navigate(move,event.shiftKey);}
      }} onKeyUp={(event)=>event.stopPropagation()} />
    <svg className="photo-editor-text__geometry">
      {editing.geometry?.frame ? <polygon className="photo-editor-text__frame" points={editing.geometry.frame.map((p)=>local(p).join(",")).join(" ")} /> : null}
      {editing.geometry?.selection.map((quad,index)=><polygon key={index} points={quad.map((p)=>local(p).join(",")).join(" ")} />)}
      {editing.composing && editing.preeditGeometry?.map((quad,index)=>{const a=local(quad[3]),b=local(quad[2]);return <line key={`preedit-${index}`} data-text-preedit="true" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]}/>;})}
      {caret && editing.selection.start===editing.selection.end ? <line x1={caret[0][0]} y1={caret[0][1]} x2={caret[1][0]} y2={caret[1][1]} /> : null}
    </svg>
    {handles?<div className="photo-editor-text__handles" data-text-box-handles="true">{handles.map((position,index)=>{const [x,y]=local([position[0],position[1]]);
      return <span key={index} data-text-box-handle={index} data-active={handle===index?"true":undefined} style={{left:x,top:y}}/>;})}</div>:null}
  </div>;
}
