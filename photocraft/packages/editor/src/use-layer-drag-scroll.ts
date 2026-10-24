import {useCallback,useEffect,useRef,type RefObject} from "react";
/** HTML 拖放事件没有持续 pointermove；帧循环在边缘保持滚动，视口外限速继续，结算立即停止。 */
export function useLayerDragScroll(viewport:RefObject<HTMLElement>,disabled:boolean) {
  const frame=useRef<number|null>(null),pointer=useRef<number|null>(null),last=useRef<number|null>(null);
  const stop=useCallback(()=>{
    if(frame.current!==null) cancelAnimationFrame(frame.current);
    frame.current=null;pointer.current=null;last.current=null;
  },[]);
  const move=useCallback((y:number)=>{
    if(disabled) {stop();return;}
    pointer.current=y;
    if(frame.current!==null) return;
    const tick=(time:number)=>{
      frame.current=null;
      const element=viewport.current,y=pointer.current;
      if(!element || y===null) return;
      const rect=element.getBoundingClientRect(),edge=Math.min(48,rect.height/3);
      if(edge<=0) return;
      const distance=y<rect.top+edge ? y-rect.top-edge : y>rect.bottom-edge ? y-rect.bottom+edge : 0;
      const velocity=Math.max(-1,Math.min(1,distance/edge))*600;
      const elapsed=last.current===null ? 16 : Math.max(0,Math.min(32,time-last.current));last.current=time;
      if(velocity===0) {last.current=null;return;}
      element.scrollTop+=velocity*elapsed/1000;
      frame.current=requestAnimationFrame(tick);
    };
    frame.current=requestAnimationFrame(tick);
  },[disabled,stop,viewport]);
  useEffect(()=>{if(disabled) stop();},[disabled,stop]);
  useEffect(()=>{
    const track=(event:DragEvent)=>{if(pointer.current!==null) move(event.clientY);};
    document.addEventListener("dragover",track);
    const key=(event:KeyboardEvent)=>{if(event.key==="Escape") stop();};
    window.addEventListener("blur",stop);window.addEventListener("dragend",stop);window.addEventListener("drop",stop);window.addEventListener("keydown",key);
    return ()=>{stop();document.removeEventListener("dragover",track);window.removeEventListener("blur",stop);window.removeEventListener("dragend",stop);window.removeEventListener("drop",stop);window.removeEventListener("keydown",key);};
  },[stop,move]);
  return {move,stop};
}
