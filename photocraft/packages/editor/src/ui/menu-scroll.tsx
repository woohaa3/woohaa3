import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from "react";
import {ChevronDownIcon} from "./icons.js";

/** Long menus retain ordinary wheel scrolling and add bounded hover scroll controls. */
export function MenuScroll({children}:{children:ReactNode}) {
  const surface=useRef<HTMLDivElement>(null),viewport=useRef<HTMLDivElement>(null);
  const [edges,setEdges]=useState({up:false,down:false});
  const motion=useRef<{frame:number|null;direction:number;time:number|null;generation:number}>({frame:null,direction:0,time:null,generation:0});
  const measure=()=>{
    const node=viewport.current;if(!node)return;
    const up=node.scrollTop>0,down=node.scrollHeight-node.clientHeight-node.scrollTop>1;
    setEdges(previous=>previous.up===up && previous.down===down?previous:{up,down});
  };
  const stop=()=>{const state=motion.current;state.generation++;if(state.frame!==null)cancelAnimationFrame(state.frame);state.frame=null;state.direction=0;state.time=null;};
  const scroll=(distance:number)=>{
    const node=viewport.current;if(!node)return false;
    const before=node.scrollTop;node.scrollTop=Math.max(0,Math.min(Math.max(0,node.scrollHeight-node.clientHeight),before+distance));measure();return node.scrollTop!==before;
  };
  const start=(direction:number)=>{
    stop();const state=motion.current,generation=state.generation;state.direction=direction;
    const step=(time:number)=>{
      if(generation!==state.generation || !state.direction)return;
      state.frame=null;const elapsed=state.time===null?16:Math.max(0,Math.min(32,time-state.time));state.time=time;
      if(!scroll(direction*240*elapsed/1000)){stop();return;}state.frame=requestAnimationFrame(step);
    };
    state.frame=requestAnimationFrame(step);
  };
  useLayoutEffect(measure,[children]);
  useEffect(()=>{
    const node=viewport.current;if(!node)return;
    const resize=typeof ResizeObserver==="undefined"?null:new ResizeObserver(measure);resize?.observe(node);
    const mutation=new MutationObserver(measure);mutation.observe(node,{childList:true,subtree:true,characterData:true});
    const hide=()=>{if(document.hidden)stop();};
    const wheel=(event:WheelEvent)=>{
      if(!(event.target instanceof Element) || !event.target.closest("[data-menu-scroll]"))return;
      event.preventDefault();event.stopPropagation();stop();scroll(event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?node.clientHeight:1));
    };
    const root=surface.current;root?.addEventListener("wheel",wheel,{passive:false});
    window.addEventListener("resize",measure);window.addEventListener("blur",stop);document.addEventListener("visibilitychange",hide);
    return()=>{stop();root?.removeEventListener("wheel",wheel);resize?.disconnect();mutation.disconnect();window.removeEventListener("resize",measure);window.removeEventListener("blur",stop);document.removeEventListener("visibilitychange",hide);};
  },[]);
  return <div ref={surface} className="ui-menu-scroll">
    <div ref={viewport} className="ui-menu-scroll__viewport" onScroll={measure}>{children}</div>
    {([[-1,"up",edges.up],[1,"down",edges.down]] as const).map(([direction,name,visible])=>visible?<div key={name} className="ui-menu-scroll__arrow" data-menu-scroll={name}
      onPointerEnter={()=>start(direction)} onPointerLeave={stop} onPointerCancel={stop}
      onPointerDown={event=>event.preventDefault()}>
      <ChevronDownIcon size={12} style={direction<0?{transform:"rotate(180deg)"}:undefined}/>
    </div>:null)}
  </div>;
}
