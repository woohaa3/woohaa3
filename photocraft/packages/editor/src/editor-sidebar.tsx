import {useEffect,useRef,useState,type ReactNode,type PointerEvent,type CSSProperties} from "react";
import {Button} from "./ui/Button.js";
import {DEFAULT_PANEL_LAYOUT,type EditorPanelLayout,type EditorPanelId} from "./editor-panel-layout.js";
import type {EditorDisplayControls} from "./editor-display.js";

type PanelId=EditorPanelId;
type Drag={kind:"width"|"position"|"panel"|"size";panel?:PanelId;x:number;y:number;base:EditorPanelLayout;pointer:number;target:HTMLElement};
/** 面板只改变显示偏好；公共 FocusWorkspace 继续持有内容矩形。 */
export function EditorSidebar({display,disabled,canChange,layers,history,properties,panels=[],onClosePanel}:{display:EditorDisplayControls;disabled:boolean;canChange?:()=>boolean;layers:ReactNode;history:ReactNode;properties:ReactNode;panels?:{id:`feature.${string}`;label:string;content:ReactNode}[];onClosePanel?:(id:`feature.${string}`)=>void}) {
  const layout=display.state.panelLayout??DEFAULT_PANEL_LAYOUT;
  const [fallbackPanel,setFallbackPanel]=useState<PanelId>("layers");
  const activePanel=layout.activePanel??fallbackPanel;
  const setActivePanel=(id:PanelId)=>{setFallbackPanel(id);update?.({activePanel:id});};
  const drag=useRef<Drag|null>(null);
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
  const start=(kind:Drag["kind"],event:PointerEvent<HTMLElement>,panel?:PanelId)=>{
    if(disabled || canChange?.()===false || !update || event.button!==0 || ((kind==="position" || kind==="panel") && (event.target as Element).closest("button"))) return;
    event.preventDefault();event.stopPropagation();
    drag.current={kind,panel,x:event.clientX,y:event.clientY,base:layout,pointer:event.pointerId,target:event.currentTarget};
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const move=(event:PointerEvent<HTMLElement>)=>{
    const current=drag.current;if(!current || current.pointer!==event.pointerId) return;
    if(disabled || canChange?.()===false) {finish(true);return;}
    event.preventDefault();event.stopPropagation();const dx=event.clientX-current.x,dy=event.clientY-current.y;
    if(current.kind==="width") update?.({width:current.base.width+(current.base.floating?dx:-dx)});
    if(current.kind==="position") update?.({x:current.base.x+dx,y:current.base.y+dy});
    if(current.kind==="panel" && current.panel) {
      const point=current.base.detachedPanels?.[current.panel];
      if(point) update?.({detachedPanels:{...current.base.detachedPanels,[current.panel]:{x:Math.max(0,Math.min(window.innerWidth-80,point.x+dx)),y:Math.max(0,Math.min(window.innerHeight-80,point.y+dy))}}});
    }
    if(current.kind==="size") update?.({width:current.base.width+dx,height:current.base.height+dy});
  };
  const handlers={onPointerMove:move,onPointerUp:(event:PointerEvent<HTMLElement>)=>{if(drag.current?.pointer===event.pointerId) {move(event);finish();}},onPointerCancel:()=>finish(true),onLostPointerCapture:()=>finish(true)};
  const entries: [PanelId,string,ReactNode][] = [["properties","属性",properties],["layers","图层",layers],["history","历史",history],...panels.map(panel => [panel.id,panel.label,panel.content] as [PanelId,string,ReactNode])];
  return <aside className="photo-editor__sidebar" hidden={!display.state.sidebarVisible} data-floating={layout.floating?"true":"false"}
    style={{"--editor-panel-width":`${layout.width}px`,"--editor-panel-height":`${layout.height}px`,"--editor-panel-x":`${layout.x}px`,"--editor-panel-y":`${layout.y}px`} as CSSProperties}
    onKeyDownCapture={event=>{if(event.key==="Escape" && drag.current) {event.preventDefault();event.stopPropagation();finish(true);}}}>
    <header className="photo-editor__sidebar-header" onPointerDown={event=>layout.floating && start("position",event)} {...handlers}>
      <span>{layout.floating?"浮动面板组":"面板"}</span>
      <Button size="sm" tone="ghost" disabled={disabled || !update} onClick={()=>{if(canChange?.()!==false) update?.({floating:!layout.floating});}}>{layout.floating?"停靠右侧":"浮动"}</Button>
    </header>
    <nav className="photo-editor__panel-tabs" aria-label="编辑器面板">
      {entries.map(([id,label])=><Button key={id} size="sm" tone="ghost"
        aria-pressed={activePanel===id} disabled={disabled} onClick={()=>{if(canChange?.()!==false)setActivePanel(id);}}>{label}</Button>)}
    </nav>
    <div className="photo-editor__panel-stack" data-active-panel={activePanel}>
      {entries.map(([id,label,content])=>{
        const point=layout.detachedPanels?.[id];
        return <div key={id} className="photo-editor__panel-slot" hidden={!point && activePanel!==id} data-detached={!!point}
          data-collapsed={id === "properties" || id === "layers" || id === "history" ? layout[`${id}Collapsed`] : false}
          style={point?{left:Math.min(point.x,Math.max(0,window.innerWidth-layout.width)),top:Math.min(point.y,Math.max(0,window.innerHeight-100))}:undefined}>
          <header className="photo-editor__panel-slot-header" onPointerDown={event=>point && start("panel",event,id)} {...handlers}>
            <span>{label}</span>{id.startsWith("feature.") && onClosePanel ? <Button size="sm" tone="ghost" disabled={disabled} onClick={() => onClosePanel(id as `feature.${string}`)}>关闭面板</Button> : null}<Button size="sm" tone="ghost" disabled={disabled || !update} onClick={()=>{
              if(canChange?.()===false)return;
              const detachedPanels={...layout.detachedPanels};
              if(point) delete detachedPanels[id];
              else detachedPanels[id]={x:Math.max(8,window.innerWidth-layout.width*2-24),y:120};
              update?.({detachedPanels,activePanel:id});
            }}>{point?"停靠面板组":"独立浮动"}</Button>
          </header>{content}
        </div>;
      })}
    </div>
    <div className="photo-editor__panel-width" title="拖动调整面板宽度" onPointerDown={event=>start("width",event)} {...handlers}/>
    {layout.floating?<div className="photo-editor__panel-size" title="拖动调整浮动面板大小" onPointerDown={event=>start("size",event)} {...handlers}/>:null}
  </aside>;
}
