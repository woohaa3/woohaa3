import {useCallback,useEffect,useMemo,useRef,useState} from "react";

import {DEFAULT_PANEL_LAYOUT,normalizePanelLayout,readPanelLayout,savePanelLayout,type EditorPanelLayout} from "./editor-panel-layout.js";

export type EditorDisplayAction = "extras" | "panels" | "sidebar";
export type EditorDisplayState = {
  panelLayout?:EditorPanelLayout;
  extrasVisible:boolean;
  toolsVisible:boolean;
  sidebarVisible:boolean;
  restore:{toolsVisible:boolean;sidebarVisible:boolean} | null;
};
/** 宿主聚焦布局所需的编辑器占位配置（只含编辑器能决定的部分）。 */
export type EditorLayoutConfig = {
  desktop: boolean;
  panel: boolean;
  toolColumn: number;
  toolbar: number;
  panelMaxWidth: number;
};

export type EditorDisplayControls = {state:EditorDisplayState;toggle:(action:EditorDisplayAction)=>void;updatePanels?:(patch:Partial<EditorPanelLayout>)=>void};
export const INITIAL_EDITOR_DISPLAY:EditorDisplayState={extrasVisible:true,toolsVisible:true,sidebarVisible:true,restore:null};

export function toggleEditorDisplay(state:EditorDisplayState,action:EditorDisplayAction):EditorDisplayState {
  if(action==="extras") return {...state,extrasVisible:!state.extrasVisible};
  if(action==="sidebar") return {...state,sidebarVisible:!state.sidebarVisible,restore:null};
  if(!state.toolsVisible && !state.sidebarVisible) return {...state,...(state.restore ?? {toolsVisible:true,sidebarVisible:true}),restore:null};
  return {...state,toolsVisible:false,sidebarVisible:false,restore:{toolsVisible:state.toolsVisible,sidebarVisible:state.sidebarVisible}};
}

export function editorDisplayLayout(state:EditorDisplayState):EditorLayoutConfig {
  const panel=state.panelLayout??DEFAULT_PANEL_LAYOUT;
  return {desktop:true,panel:state.sidebarVisible && !panel.floating,toolColumn:state.toolsVisible?52:0,toolbar:state.toolsVisible?96:44,panelMaxWidth:panel.width};
}

/** 显隐只属于当前工作区；面板尺寸、折叠与停靠偏好保存在本机，不进入工程或撤销历史。 */
export function useEditorDisplay(beforeLayoutChange?:()=>void):EditorDisplayControls {
  const [state,setState]=useState<EditorDisplayState>(()=>({...INITIAL_EDITOR_DISPLAY,panelLayout:readPanelLayout()}));
  const latest=useRef(state);latest.current=state;
  const toggle=useCallback((action:EditorDisplayAction)=>{
    const current=latest.current;
    const next=toggleEditorDisplay(current,action);
    if(JSON.stringify(editorDisplayLayout(current))!==JSON.stringify(editorDisplayLayout(next))) beforeLayoutChange?.();
    latest.current=next;setState(next);
  },[beforeLayoutChange]);
  const updatePanels=useCallback((patch:Partial<EditorPanelLayout>)=>{
    const current=latest.current;
    const previous=current.panelLayout??DEFAULT_PANEL_LAYOUT;
    const panelLayout=normalizePanelLayout({...previous,...patch});
    if(current.sidebarVisible && (previous.floating!==panelLayout.floating || (!panelLayout.floating && previous.width!==panelLayout.width))) beforeLayoutChange?.();
    const next={...current,panelLayout};latest.current=next;setState(next);
  },[beforeLayoutChange]);
  useEffect(()=>{if(state.panelLayout) savePanelLayout(state.panelLayout);},[state.panelLayout]);
  return useMemo(()=>({state,toggle,updatePanels}),[state,toggle,updatePanels]);
}
