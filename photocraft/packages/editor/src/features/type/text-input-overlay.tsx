import { useLayoutEffect, useRef } from "react";
import type { TextEditing } from "../../use-text-editing.js";
import type { TextPoint, TextNavigation } from "../../text-geometry.js";

/** textarea 只处理真实文字输入；图片、光标及选择继续使用原生布局。 */
export function TextInputOverlay({editing,origin,zoom,disabled,onEnd}: {
  editing: TextEditing; origin: {x:number;y:number}; zoom: number; disabled: boolean; onEnd: (commit:boolean)=>void;
}) {
  const input=useRef<HTMLTextAreaElement>(null);
  const drag=useRef<{pointer:number;anchor:number} | null>(null);
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
  return <div className="photo-editor-text" data-text-editing="true"
    onPointerDown={(event)=>{
      event.stopPropagation();
      if (disabled || editing.composing || event.button!==0 || drag.current) return;
      const anchor=editing.hit(point(event),event.shiftKey);
      if (anchor===null) return;
      event.preventDefault();drag.current={pointer:event.pointerId,anchor};event.currentTarget.setPointerCapture(event.pointerId);
      input.current?.focus({preventScroll:true});
    }}
    onPointerMove={(event)=>{if (drag.current?.pointer===event.pointerId) editing.hit(point(event),true,drag.current.anchor);}}
    onPointerUp={(event)=>{
      if (drag.current?.pointer!==event.pointerId) return;
      editing.hit(point(event),true,drag.current.anchor);drag.current=null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={()=>{drag.current=null;}} onLostPointerCapture={()=>{drag.current=null;}}>
    <textarea ref={input} data-text-input="true" value={editing.style.text} disabled={disabled} wrap="off" spellCheck={false}
      style={{left:start[0],top:Math.min(start[1],end[1]),height:Math.max(1,Math.abs(end[1]-start[1]))}}
      onChange={(event)=>editing.update({text:event.currentTarget.value},{start:event.currentTarget.selectionStart,end:event.currentTarget.selectionEnd,direction:event.currentTarget.selectionDirection})}
      onSelect={(event)=>{if (!editing.composing && !event.nativeEvent.defaultPrevented) editing.select({start:event.currentTarget.selectionStart,end:event.currentTarget.selectionEnd,direction:event.currentTarget.selectionDirection});}}
      onCompositionStart={()=>editing.compositionStart()} onCompositionEnd={()=>editing.compositionEnd()}
      onKeyDown={(event)=>{
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode===229 || editing.composing) return;
        if (event.key==="Escape") {event.preventDefault();onEnd(false);return;}
        if (event.key==="Enter" && (event.ctrlKey || event.metaKey)) {event.preventDefault();onEnd(true);return;}
        if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase()==="s" || event.key.toLowerCase()==="t")) {event.preventDefault();return;}
        const move:TextNavigation|undefined=event.key==="ArrowUp"?"linePrev":event.key==="ArrowDown"?"lineNext"
          :event.key==="Home"?"lineStart":event.key==="End"?"lineEnd"
          :event.altKey && event.key==="ArrowLeft"?"wordPrev":event.altKey && event.key==="ArrowRight"?"wordNext":undefined;
        if (move) {event.preventDefault();editing.navigate(move,event.shiftKey);}
      }} onKeyUp={(event)=>event.stopPropagation()} />
    <svg className="photo-editor-text__geometry">
      {editing.geometry?.frame ? <polygon className="photo-editor-text__frame" points={editing.geometry.frame.map((p)=>local(p).join(",")).join(" ")} /> : null}
      {editing.geometry?.selection.map((quad,index)=><polygon key={index} points={quad.map((p)=>local(p).join(",")).join(" ")} />)}
      {caret && editing.selection.start===editing.selection.end ? <line x1={caret[0][0]} y1={caret[0][1]} x2={caret[1][0]} y2={caret[1][1]} /> : null}
    </svg>
  </div>;
}
