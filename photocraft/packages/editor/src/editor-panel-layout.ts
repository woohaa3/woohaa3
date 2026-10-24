import {readRememberWorkspaceChanges} from "./workspace-layout-memory.js";
/** 只保存工作区偏好，不进入图片工程或文档历史。 */
export type EditorPanelLayout = {
  width:number;floating:boolean;x:number;y:number;height:number;split:number;
  toolbarDouble:boolean;showMoveTransform:boolean;
  layersCollapsed:boolean;historyCollapsed:boolean;propertiesCollapsed:boolean;
};
export const PANEL_LAYOUT_KEY="woohaa.image-editor.panels.v1";
export const DEFAULT_PANEL_LAYOUT:EditorPanelLayout={toolbarDouble:false,showMoveTransform:true,width:280,floating:false,x:20,y:20,height:640,split:.6,layersCollapsed:false,historyCollapsed:false,propertiesCollapsed:false};
export function normalizePanelLayout(value:unknown):EditorPanelLayout {
  const obj=value && typeof value==="object"?value as Record<string,unknown>:{};
  const number=(key:keyof EditorPanelLayout,min:number,max:number)=>typeof obj[key]==="number" && Number.isFinite(obj[key]) ? Math.min(max,Math.max(min,obj[key] as number)) : DEFAULT_PANEL_LAYOUT[key] as number;
  const bool=(key:keyof EditorPanelLayout)=>typeof obj[key]==="boolean"?obj[key] as boolean:DEFAULT_PANEL_LAYOUT[key] as boolean;
  return {toolbarDouble:bool("toolbarDouble"),showMoveTransform:bool("showMoveTransform"),width:number("width",240,480),height:number("height",320,1200),x:number("x",0,10000),y:number("y",0,10000),split:number("split",.2,.8),floating:bool("floating"),layersCollapsed:bool("layersCollapsed"),historyCollapsed:bool("historyCollapsed"),propertiesCollapsed:bool("propertiesCollapsed")};
}
export function readPanelLayout():EditorPanelLayout {
  if(!readRememberWorkspaceChanges())return {...DEFAULT_PANEL_LAYOUT};
  try {return normalizePanelLayout(JSON.parse(localStorage.getItem(PANEL_LAYOUT_KEY)??"null"));} catch {return {...DEFAULT_PANEL_LAYOUT};}
}
export function savePanelLayout(value:EditorPanelLayout):void {
  if(!readRememberWorkspaceChanges())return;
  try {localStorage.setItem(PANEL_LAYOUT_KEY,JSON.stringify(value));} catch { /* 存储受限时仍可在当前工作区调整。 */ }
}
