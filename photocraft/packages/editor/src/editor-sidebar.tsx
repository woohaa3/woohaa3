import {useEffect,useRef,useState,type ReactNode,type PointerEvent,type CSSProperties} from "react";
import {Button} from "./ui/Button.js";
import {DropdownMenu} from "./ui/Menu.js";
import {DEFAULT_PANEL_LAYOUT,PANEL_GROUP_IDS,type EditorPanelLayout,type PanelGroupId} from "./editor-panel-layout.js";
import type {EditorDisplayControls} from "./editor-display.js";

type Drag={kind:"width"|"position"|"split"|"size"|"groupHeight"|"groupMove";group?:PanelGroupId;x:number;y:number;base:EditorPanelLayout;pointer:number;target:HTMLElement;span:number;sectionHeight:number};
export type PanelTab={id:string;label:string;content:ReactNode};
export {PANEL_GROUP_IDS};
export type {PanelGroupId};
export const PANEL_GROUP_ORDER = PANEL_GROUP_IDS;
export const PANEL_GROUP_LABELS:Record<PanelGroupId,string>={color:"颜色",properties:"属性",character:"字符 / 段落",navigator:"导航器 / 信息",history:"历史",layers:"图层",brushes:"画笔"};
// Layers is the primary dock in the native layout; keep supporting groups
// compact so the layer list receives the remaining viewport height.
const HEIGHTS:Record<PanelGroupId,number>={color:140,properties:140,character:270,navigator:210,history:200,layers:420,brushes:200};

/** Inactive tabs stay mounted so a panel switch never discards an editing candidate. */
export function PanelTabs({tabs,active,onActive}:{tabs:readonly PanelTab[];active?:string;onActive?:(id:string)=>void}) {
  const [local,setLocal]=useState(tabs[0]?.id ?? "");
  const current=tabs.find(tab=>tab.id===(active??local)) ?? tabs[0];
  if(!current)return null;
  return <div className="photo-editor__tabbed-panel">
    <nav className="photo-editor__panel-tabs" aria-label="面板标签">
      {tabs.map(tab=><button key={tab.id} type="button" className={tab.id===current.id?"is-active":""} aria-selected={tab.id===current.id} onClick={()=>{setLocal(tab.id);onActive?.(tab.id);}}>{tab.label}</button>)}
    </nav>
    <div className="photo-editor__tabbed-panel-content">{tabs.map(tab=><div key={tab.id} hidden={tab.id!==current.id}>{tab.content}</div>)}</div>
  </div>;
}

/** Only workspace preferences change here; the host retains the canvas content rectangle. */
export function EditorSidebar({display,disabled,canChange,layers,history,properties,info,infoVisible=true,color,character,characterVisible=false,brushes,brushesVisible=false}:{display:EditorDisplayControls;disabled:boolean;canChange?:()=>boolean;layers:ReactNode;history:ReactNode;properties:ReactNode;info?:ReactNode;infoVisible?:boolean;color?:ReactNode;character?:ReactNode;characterVisible?:boolean;brushes?:ReactNode;brushesVisible?:boolean}) {
  const layout=display.state.panelLayout??DEFAULT_PANEL_LAYOUT;
  const drag=useRef<Drag|null>(null),stack=useRef<HTMLDivElement>(null);
  const update=display.updatePanels;
  const [collapsed,setCollapsed]=useState(layout.collapsedGroups);
  useEffect(()=>setCollapsed(layout.collapsedGroups),[layout.collapsedGroups]);
  const allowed=()=>!disabled && canChange?.()!==false;
  const toggleGroup=(id:PanelGroupId)=>{if(!allowed())return;const next={...collapsed,[id]:!collapsed[id]};setCollapsed(next);update?.({collapsedGroups:next});};
  const order=layout.groupOrder??PANEL_GROUP_IDS;
  const reorder=(id:PanelGroupId,target:PanelGroupId)=>{if(id===target || !allowed())return;const next=order.filter(key=>key!==id);next.splice(next.indexOf(target),0,id);update?.({groupOrder:[...next]});};
  const finish=(cancel=false)=>{
    const current=drag.current;drag.current=null;if(!current)return;
    if(current.target.hasPointerCapture?.(current.pointer))current.target.releasePointerCapture(current.pointer);
    if(cancel)update?.(current.base);
  };
  useEffect(()=>{if(disabled || !display.state.sidebarVisible)finish(true);},[disabled,display.state.sidebarVisible]);
  useEffect(()=>{
    const blur=()=>finish(true);window.addEventListener("blur",blur);
    return()=>{window.removeEventListener("blur",blur);const current=drag.current;drag.current=null;if(current?.target.hasPointerCapture?.(current.pointer))current.target.releasePointerCapture(current.pointer);};
  },[update]);
  const start=(kind:Drag["kind"],event:PointerEvent<HTMLElement>,group?:PanelGroupId)=>{
    if(!allowed() || !update || event.button!==0 || (kind==="position" && (event.target as Element).closest("button")))return;
    event.preventDefault();event.stopPropagation();
    const section=group?stack.current?.querySelector<HTMLElement>(`[data-panel-group="${group}"]`):null;
    drag.current={kind,group,x:event.clientX,y:event.clientY,base:layout,pointer:event.pointerId,target:event.currentTarget,sectionHeight:section?.getBoundingClientRect().height??0,span:(kind==="groupHeight"?section:stack.current)?.getBoundingClientRect().height??0};
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const move=(event:PointerEvent<HTMLElement>)=>{
    const d=drag.current;if(!d || d.pointer!==event.pointerId)return;
    if(!allowed()){finish(true);return;}
    event.preventDefault();event.stopPropagation();const dx=event.clientX-d.x,dy=event.clientY-d.y;
    if(d.kind==="width")update?.({width:d.base.width+(d.base.floating?dx:-dx)});
    if(d.kind==="position")update?.({x:d.base.x+dx,y:d.base.y+dy});
    if(d.kind==="split" && d.span>0)update?.({split:d.base.split+dy/d.span,groupHeights:{...d.base.groupHeights,history:(d.sectionHeight || HEIGHTS.history)+dy}});
    if(d.kind==="size")update?.({width:d.base.width+dx,height:d.base.height+dy});
    if(d.kind==="groupHeight" && d.group)update?.({groupHeights:{...d.base.groupHeights,[d.group]:(d.span || HEIGHTS[d.group])+dy}});
  };
  const handlers={onPointerMove:move,onPointerUp:(event:PointerEvent<HTMLElement>)=>{
    const d=drag.current;if(d?.pointer!==event.pointerId)return;
    if(d.kind==="groupMove" && d.group){const target=document.elementFromPoint?.(event.clientX,event.clientY)?.closest<HTMLElement>("[data-panel-group]")?.dataset.panelGroup as PanelGroupId|undefined;if(target)reorder(d.group,target);}
    else move(event);
    finish();
  },onPointerCancel:()=>finish(true),onLostPointerCapture:()=>finish(true)};
  const content:Record<PanelGroupId,ReactNode>={color,properties,character:characterVisible?character:null,navigator:infoVisible?info:null,history,layers,brushes:brushesVisible?brushes:null};
  const visible=order.filter(id=>content[id]!=null && !layout.hiddenGroups?.[id]);
  // Layers receives remaining space, as in the native dock. Other groups own fixed-height viewports.
  const filler=visible.includes("layers") && !collapsed.layers?"layers":[...visible].reverse().find(id=>!collapsed[id]);
  return <aside className="photo-editor__sidebar" hidden={!display.state.sidebarVisible} data-floating={layout.floating?"true":"false"}
    style={{"--editor-panel-width":`${layout.width}px`,"--editor-panel-height":`${layout.height}px`,"--editor-panel-x":`${layout.x}px`,"--editor-panel-y":`${layout.y}px`} as CSSProperties}
    onKeyDownCapture={event=>{if(event.key==="Escape" && drag.current){event.preventDefault();event.stopPropagation();finish(true);}}}>
    <header className="photo-editor__sidebar-header" onPointerDown={event=>layout.floating && start("position",event)} {...handlers}>
      <span>{layout.floating?"浮动面板":"面板"}</span>
      <Button size="sm" tone="ghost" disabled={disabled || !update} onClick={()=>{if(allowed())update?.({floating:!layout.floating});}}>{layout.floating?"停靠右侧":"浮动"}</Button>
    </header>
    <div className="photo-editor__dock-group photo-editor__panel-stack" ref={stack}>
      {order.filter(id=>content[id]!=null).map(id=>{
        const label=PANEL_GROUP_LABELS[id],isCollapsed=!!collapsed[id];
        const legacyCollapsed=id==="layers"?layout.layersCollapsed:id==="history"?layout.historyCollapsed:id==="properties"?layout.propertiesCollapsed:false;
        return <section key={id} hidden={!!layout.hiddenGroups?.[id]} className={`photo-editor__panel-group photo-editor__panel-group--${id}`} data-panel-group={id} data-collapsed-group={isCollapsed?"true":"false"} onDoubleClickCapture={event=>{if((event.target as Element).closest(".photo-editor__panel-tabs")){event.preventDefault();toggleGroup(id);}}}
          style={{flex:isCollapsed || legacyCollapsed?"0 0 30px":id===filler?`1 0 ${layout.groupHeights?.[id]??140}px`:`0 1 ${layout.groupHeights?.[id]??HEIGHTS[id]}px`,minHeight:isCollapsed || legacyCollapsed?30:id==="layers"?140:80}}>
          <header className="photo-editor__panel-group-title" onDoubleClick={event=>{if(!(event.target as Element).closest("button"))toggleGroup(id);}}>
            <button type="button" className="photo-editor__panel-group-grip" title="拖动调整面板组顺序" disabled={disabled} onPointerDown={event=>start("groupMove",event,id)} {...handlers}>⠿</button>
            <button type="button" className="photo-editor__panel-group-toggle" aria-expanded={!isCollapsed} disabled={disabled} onClick={()=>toggleGroup(id)}>{label}<span aria-hidden="true">{isCollapsed?"＋":"−"}</span></button>
            <DropdownMenu label={`${label}面板菜单`} trigger={<button type="button" className="photo-editor__panel-group-menu" aria-label={`${label}面板菜单`} disabled={disabled}>⋯</button>} items={[
              {id:"collapse",label:isCollapsed?"展开面板组":"折叠面板组",onSelect:()=>toggleGroup(id)},
              {id:"up",label:"上移面板组",disabled:visible.indexOf(id)<=0,onSelect:()=>reorder(id,visible[visible.indexOf(id)-1])},
              {id:"down",label:"下移面板组",disabled:visible.indexOf(id)===visible.length-1,onSelect:()=>{const at=visible.indexOf(id),next=[...order],a=next.indexOf(id),b=next.indexOf(visible[at+1]);if(allowed() && b>=0){[next[a],next[b]]=[next[b],next[a]];update?.({groupOrder:next});}}},
              {id:"reset-size",label:"恢复默认高度",onSelect:()=>{if(allowed()){const next={...layout.groupHeights};delete next[id];update?.({groupHeights:next});}}},
              {id:"close",label:"关闭面板组",separatorBefore:true,onSelect:()=>{if(allowed())update?.({hiddenGroups:{...layout.hiddenGroups,[id]:true}});}}
            ]}/>
          </header>
          <div className={`photo-editor__panel-slot photo-editor__panel-slot--${id}`} data-collapsed={legacyCollapsed}>{content[id]}</div>
          <div className={id==="history"?"photo-editor__panel-splitter":"photo-editor__group-resizer"} title={id==="history"?"调整历史与图层高度":"调整面板组高度"} onPointerDown={event=>start(id==="history"?"split":"groupHeight",event,id)} {...handlers}/>
        </section>;
      })}
    </div>
    <div className="photo-editor__panel-width" title="拖动调整面板宽度" onPointerDown={event=>start("width",event)} {...handlers}/>
    {layout.floating?<div className="photo-editor__panel-size" title="拖动调整浮动面板大小" onPointerDown={event=>start("size",event)} {...handlers}/>:null}
  </aside>;
}
