import {readNarrowOptionsBar,subscribeNarrowOptionsBar,readLargeDocumentTabs,subscribeLargeDocumentTabs,readRememberWorkspaceChanges,subscribeRememberWorkspaceChanges,readWorkspaceVisibility,saveWorkspaceVisibility} from "./workspace-layout-memory.js";
import {useScreenModeWindow,type EditorScreenModeWindowPort} from "./screen-mode-window.js";
import {NO_STICKY_MODIFIERS,type StickyModifiers} from "./modifier-keys.js";
import {useCallback,useEffect,useMemo,useRef,useState} from "react";

import {DEFAULT_PANEL_LAYOUT,normalizePanelLayout,readPanelLayout,savePanelLayout,type EditorPanelLayout} from "./editor-panel-layout.js";

export type EditorScreenMode = "standard" | "fullScreenWithMenuBar" | "fullScreen";
export const EDITOR_SCREEN_MODES = [{id:"standard",label:"标准屏幕模式"},{id:"fullScreenWithMenuBar",label:"带菜单栏全屏"},{id:"fullScreen",label:"全屏模式"}] as const;
export type EditorDisplayAction = "extras" | "panels" | "sidebar" | "tools" | "options" | "modifiers" | "info" | "pixelGrid" | "histogram" | "navigator" | "cloneSource" | "brushPresets";
export type EditorDisplayState = {
  narrowOptionsBar?:boolean;
  largeDocumentTabs?:boolean;
  screenMode?:EditorScreenMode;
  screenModeError?:string;
  fullScreenChrome?:boolean;
  navigatorVisible?:boolean;
  histogramVisible?:boolean;
  infoVisible?:boolean;
  pixelGridVisible?:boolean;
  cloneSourceVisible?:boolean;
  brushPresetsVisible?:boolean;
  modifiersVisible?:boolean;
  stickyModifiers?:StickyModifiers;
  panelLayout?:EditorPanelLayout;
  extrasVisible:boolean;
  toolsVisible:boolean;
  optionsVisible:boolean;
  sidebarVisible:boolean;
  restore:{toolsVisible:boolean;optionsVisible:boolean;sidebarVisible:boolean} | null;
};
/** 宿主聚焦布局所需的编辑器占位配置（只含编辑器能决定的部分）。 */
export type EditorLayoutConfig = {
  chrome?:boolean;
  desktop: boolean;
  panel: boolean;
  toolColumn: number;
  toolbar: number;
  panelMaxWidth: number;
};

export type EditorDisplayControls = {state:EditorDisplayState;toggle:(action:EditorDisplayAction)=>void;setScreenMode?:(mode:EditorScreenMode)=>void;toggleStickyModifier?:(key:keyof StickyModifiers)=>void;updatePanels?:(patch:Partial<EditorPanelLayout>)=>void};
export const INITIAL_EDITOR_DISPLAY:EditorDisplayState={modifiersVisible:false,stickyModifiers:NO_STICKY_MODIFIERS,extrasVisible:true,toolsVisible:true,optionsVisible:true,sidebarVisible:true,restore:null};

export function toggleEditorDisplay(state:EditorDisplayState,action:EditorDisplayAction):EditorDisplayState {
  if(action==="panels" && state.screenMode==="fullScreen")return {...state,fullScreenChrome:!state.fullScreenChrome};
  if(action==="pixelGrid")return {...state,pixelGridVisible:!state.pixelGridVisible};
  if(action==="navigator")return {...state,navigatorVisible:!state.navigatorVisible,sidebarVisible:!state.navigatorVisible?true:state.sidebarVisible};
  if(action==="histogram")return {...state,histogramVisible:!state.histogramVisible,sidebarVisible:!state.histogramVisible?true:state.sidebarVisible};
  if(action==="info")return {...state,infoVisible:!state.infoVisible,sidebarVisible:!state.infoVisible?true:state.sidebarVisible};
  if(action==="cloneSource")return {...state,cloneSourceVisible:!state.cloneSourceVisible,sidebarVisible:!state.cloneSourceVisible?true:state.sidebarVisible};
  if(action==="brushPresets")return {...state,brushPresetsVisible:!state.brushPresetsVisible,sidebarVisible:!state.brushPresetsVisible?true:state.sidebarVisible};
  if(action==="modifiers")return {...state,modifiersVisible:!state.modifiersVisible};
  if(action==="extras") return {...state,extrasVisible:!state.extrasVisible};
  if(action!=="panels") {const key=action==="sidebar"?"sidebarVisible":action==="tools"?"toolsVisible":"optionsVisible";return {...state,[key]:!state[key],restore:null};}
  if(!state.toolsVisible && !state.optionsVisible && !state.sidebarVisible) return {...state,...(state.restore ?? {toolsVisible:true,optionsVisible:true,sidebarVisible:true}),restore:null};
  return {...state,toolsVisible:false,optionsVisible:false,sidebarVisible:false,restore:{toolsVisible:state.toolsVisible,optionsVisible:state.optionsVisible,sidebarVisible:state.sidebarVisible}};
}

export function editorChromeVisible(state:EditorDisplayState):boolean {return state.screenMode!=="fullScreen" || !!state.fullScreenChrome;}
export function setEditorScreenMode(state:EditorDisplayState,screenMode:EditorScreenMode):EditorDisplayState {return {...state,screenMode,fullScreenChrome:false};}
export function editorDisplayLayout(state:EditorDisplayState):EditorLayoutConfig {
  const panel=state.panelLayout??DEFAULT_PANEL_LAYOUT;
  const chrome=editorChromeVisible(state);
  return {...(!chrome?{chrome:false}:{}),desktop:true,panel:chrome && state.sidebarVisible && !panel.floating,toolColumn:chrome && state.toolsVisible?(panel.toolbarDouble?92:52):0,toolbar:chrome?(state.optionsVisible?(state.narrowOptionsBar?88:96):44):0,panelMaxWidth:panel.width};
}

/** 按本机偏好记忆面板显隐、尺寸、折叠与停靠；不保存Tab/全屏临时隐藏或锁存修饰键。 */
export function useEditorDisplay(beforeLayoutChange?:()=>void,windowPort?:EditorScreenModeWindowPort,enabled=true):EditorDisplayControls {
  const [state,setState]=useState<EditorDisplayState>(()=>({...INITIAL_EDITOR_DISPLAY,...readWorkspaceVisibility(),largeDocumentTabs:readLargeDocumentTabs(),narrowOptionsBar:readNarrowOptionsBar(),panelLayout:readPanelLayout()}));
  const [remember,setRemember]=useState(readRememberWorkspaceChanges),rememberRef=useRef(remember);rememberRef.current=remember;
  useEffect(()=>enabled?subscribeRememberWorkspaceChanges(value=>{rememberRef.current=value;setRemember(value);}):undefined,[enabled]);
  const latest=useRef(state);latest.current=state;
  useEffect(()=>enabled?subscribeLargeDocumentTabs(largeDocumentTabs=>{const current=latest.current;if(!!current.largeDocumentTabs===largeDocumentTabs)return;beforeLayoutChange?.();const next={...current,largeDocumentTabs};latest.current=next;setState(next);}):undefined,[enabled,beforeLayoutChange]);
  useEffect(()=>enabled?subscribeNarrowOptionsBar(narrowOptionsBar=>{const current=latest.current;if(!!current.narrowOptionsBar===narrowOptionsBar)return;if(current.optionsVisible && editorChromeVisible(current))beforeLayoutChange?.();const next={...current,narrowOptionsBar};latest.current=next;setState(next);}):undefined,[enabled,beforeLayoutChange]);
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
    if((current.toolsVisible && previous.toolbarDouble!==panelLayout.toolbarDouble) || (current.sidebarVisible && (previous.floating!==panelLayout.floating || (!panelLayout.floating && previous.width!==panelLayout.width)))) beforeLayoutChange?.();
    const next={...current,panelLayout};latest.current=next;setState(next);
  },[beforeLayoutChange]);
  useEffect(()=>{if(enabled && rememberRef.current && state.panelLayout)savePanelLayout(state.panelLayout);},[state.panelLayout,remember,enabled]);
  // Tab hides are temporary: persist the combination to restore rather than the hidden shell.
  useEffect(()=>{if(enabled && rememberRef.current)saveWorkspaceVisibility({...state,...state.restore});},[state.toolsVisible,state.optionsVisible,state.sidebarVisible,state.navigatorVisible,state.histogramVisible,state.infoVisible,state.cloneSourceVisible,state.brushPresetsVisible,state.modifiersVisible,state.restore,remember,enabled]);
  const toggleStickyModifier=useCallback((key:keyof StickyModifiers)=>{const previous=latest.current,sticky=previous.stickyModifiers??NO_STICKY_MODIFIERS,next={...previous,stickyModifiers:{...sticky,[key]:!sticky[key]}};latest.current=next;setState(next);},[]);
  const publishMode=useCallback((mode:EditorScreenMode,error?:string)=>{const next={...setEditorScreenMode(latest.current,mode),screenModeError:error};beforeLayoutChange?.();latest.current=next;setState(next);},[beforeLayoutChange]);
  const setScreenMode=useScreenModeWindow(publishMode,windowPort);
  return useMemo(()=>({state,toggle,updatePanels,toggleStickyModifier,setScreenMode}),[state,toggle,updatePanels,toggleStickyModifier,setScreenMode]);
}
