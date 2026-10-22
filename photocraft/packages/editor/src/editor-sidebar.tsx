import {useEffect,useRef,type ReactNode,type PointerEvent,type CSSProperties} from "react";
import {Button} from "./ui/Button.js";
import {DEFAULT_PANEL_LAYOUT,type EditorPanelLayout} from "./editor-panel-layout.js";
import type {EditorDisplayControls} from "./editor-display.js";

type Drag={kind:"width"|"position"|"split"|"size";x:number;y:number;base:EditorPanelLayout;pointer:number;target:HTMLElement;span:number};
/** 面板只改变显示偏好；公共 FocusWorkspace 继续持有内容矩形。 */
export function EditorSidebar({display,disabled,canChange,layers,history,properties}:{display:EditorDisplayControls;disabled:boolean;canChange?:()=>boolean;layers:ReactNode;history:ReactNode;properties:ReactNode}) {
  const layout=display.state.panelLayout??DEFAULT_PANEL_LAYOUT;
  const drag=useRef<Drag|null>(null);
  const stack=useRef<HTMLDivElement>(null);
  const update=display.updatePanels;
  const finish=(cancel=false)=>{
    const current=drag.current;drag.current=null;
    if(!current) return;
    if(current.target.hasPointerCapture?.(current.pointer)) current.target.releasePointerCapture(current.pointer);
    if(cancel) update?.(current.base);
  };
  useEffect(()=>{if(disabled || !display.state.sidebarVisible) finish(true);},[disabled,display.state.sidebarVisible]);
  useEffect(()=>{
    const blur=()=>finish(true);window.addEventListener("blur",blur);
    return ()=>{window.removeEventListener("blur",blur);const current=drag.current;drag.current=null;if(current?.target.hasPointerCapture?.(current.pointer)) current.target.releasePointerCapture(current.pointer);};
  },[update]);
  const start=(kind:Drag["kind"],event:PointerEvent<HTMLElement>)=>{
    if(disabled || canChange?.()===false || !update || event.button!==0 || (kind==="position" && (event.target as Element).closest("button"))) return;
    event.preventDefault();event.stopPropagation();
    drag.current={kind,x:event.clientX,y:event.clientY,base:layout,pointer:event.pointerId,target:event.currentTarget,span:stack.current?.getBoundingClientRect().height??0};
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const move=(event:PointerEvent<HTMLElement>)=>{
    const current=drag.current;if(!current || current.pointer!==event.pointerId) return;
    if(disabled || canChange?.()===false) {finish(true);return;}
    event.preventDefault();event.stopPropagation();const dx=event.clientX-current.x,dy=event.clientY-current.y;
    if(current.kind==="width") update?.({width:current.base.width+(current.base.floating?dx:-dx)});
    if(current.kind==="position") update?.({x:current.base.x+dx,y:current.base.y+dy});
    if(current.kind==="split" && current.span>0) update?.({split:current.base.split+dy/current.span});
    if(current.kind==="size") update?.({width:current.base.width+dx,height:current.base.height+dy});
  };
  const handlers={onPointerMove:move,onPointerUp:(event:PointerEvent<HTMLElement>)=>{if(drag.current?.pointer===event.pointerId) {move(event);finish();}},onPointerCancel:()=>finish(true),onLostPointerCapture:()=>finish(true)};
  return <aside className="photo-editor__sidebar" hidden={!display.state.sidebarVisible} data-floating={layout.floating?"true":"false"}
    style={{"--editor-panel-width":`${layout.width}px`,"--editor-panel-height":`${layout.height}px`,"--editor-panel-x":`${layout.x}px`,"--editor-panel-y":`${layout.y}px`} as CSSProperties}
    onKeyDownCapture={event=>{if(event.key==="Escape" && drag.current) {event.preventDefault();event.stopPropagation();finish(true);}}}>
    <header className="photo-editor__sidebar-header" onPointerDown={event=>layout.floating && start("position",event)} {...handlers}>
      <span>{layout.floating?"浮动面板":"面板"}</span>
      <Button size="sm" tone="ghost" disabled={disabled || !update} onClick={()=>{if(canChange?.()!==false) update?.({floating:!layout.floating});}}>{layout.floating?"停靠右侧":"浮动"}</Button>
    </header>
    <div className="photo-editor__panel-slot photo-editor__panel-slot--properties" data-collapsed={layout.propertiesCollapsed}>{properties}</div>
    <div className="photo-editor__panel-stack" ref={stack}>
      <div className="photo-editor__panel-slot" data-collapsed={layout.layersCollapsed} style={{flex:layout.layersCollapsed?"0 0 38px":`${layout.split} 1 0`}}>{layers}</div>
      <div className="photo-editor__panel-splitter" hidden={layout.layersCollapsed || layout.historyCollapsed} title="拖动调整图层与历史高度" onPointerDown={event=>start("split",event)} {...handlers}/>
      <div className="photo-editor__panel-slot" data-collapsed={layout.historyCollapsed} style={{flex:layout.historyCollapsed?"0 0 38px":`${1-layout.split} 1 0`}}>{history}</div>
    </div>
    <div className="photo-editor__panel-width" title="拖动调整面板宽度" onPointerDown={event=>start("width",event)} {...handlers}/>
    {layout.floating?<div className="photo-editor__panel-size" title="拖动调整浮动面板大小" onPointerDown={event=>start("size",event)} {...handlers}/>:null}
  </aside>;
}
