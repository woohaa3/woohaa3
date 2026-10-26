import {readRememberWorkspaceChanges} from "./workspace-layout-memory.js";
/** 只保存工作区偏好，不进入图片工程或文档历史。 */
export const PANEL_GROUP_IDS = ["color","properties","character","navigator","history","layers","brushes"] as const;
export type PanelGroupId = typeof PANEL_GROUP_IDS[number];
export type EditorPanelLayout = {
  width:number;floating:boolean;x:number;y:number;height:number;split:number;
  toolbarDouble:boolean;showMoveTransform:boolean;
  layersCollapsed:boolean;historyCollapsed:boolean;propertiesCollapsed:boolean;
  collapsedGroups:Partial<Record<PanelGroupId,boolean>>;
  hiddenGroups:Partial<Record<PanelGroupId,boolean>>;
  groupOrder:PanelGroupId[];
  groupHeights:Partial<Record<PanelGroupId,number>>;
  activeTabs:Partial<Record<PanelGroupId,string>>;
};
export const PANEL_LAYOUT_KEY="woohaa.image-editor.panels.v1";
export const DEFAULT_PANEL_LAYOUT:EditorPanelLayout={toolbarDouble:false,showMoveTransform:true,width:280,floating:false,x:20,y:20,height:640,split:.6,layersCollapsed:false,historyCollapsed:false,propertiesCollapsed:false,collapsedGroups:{},hiddenGroups:{history:true,character:true},groupOrder:[...PANEL_GROUP_IDS],groupHeights:{},activeTabs:{}};
export function normalizePanelLayout(value:unknown):EditorPanelLayout {
  const obj=value && typeof value==="object"?value as Record<string,unknown>:{};
  const number=(key:keyof EditorPanelLayout,min:number,max:number)=>typeof obj[key]==="number" && Number.isFinite(obj[key]) ? Math.min(max,Math.max(min,obj[key] as number)) : DEFAULT_PANEL_LAYOUT[key] as number;
  const bool=(key:keyof EditorPanelLayout)=>typeof obj[key]==="boolean"?obj[key] as boolean:DEFAULT_PANEL_LAYOUT[key] as boolean;
  const collapsedGroups:Partial<Record<PanelGroupId,boolean>>={};
  if(obj.collapsedGroups && typeof obj.collapsedGroups === "object") for(const id of PANEL_GROUP_IDS) {
    if(typeof (obj.collapsedGroups as Record<string,unknown>)[id] === "boolean") collapsedGroups[id]=(obj.collapsedGroups as Record<string,boolean>)[id];
  }
  const hiddenGroups:EditorPanelLayout["hiddenGroups"]={...DEFAULT_PANEL_LAYOUT.hiddenGroups},groupHeights:EditorPanelLayout["groupHeights"]={},activeTabs:EditorPanelLayout["activeTabs"]={};
  for(const id of PANEL_GROUP_IDS) {
    const hidden=(obj.hiddenGroups as Record<string,unknown>|undefined)?.[id];
    if(typeof hidden==="boolean")hiddenGroups[id]=hidden;
    const height=(obj.groupHeights as Record<string,unknown>|undefined)?.[id];
    if(typeof height==="number" && Number.isFinite(height))groupHeights[id]=Math.min(1000,Math.max(id==="layers"?140:id==="brushes"?100:80,height));
    const tab=(obj.activeTabs as Record<string,unknown>|undefined)?.[id];
    if(typeof tab==="string" && tab.length<=80)activeTabs[id]=tab;
  }
  const ordered=Array.isArray(obj.groupOrder)?obj.groupOrder.filter((id):id is PanelGroupId=>PANEL_GROUP_IDS.includes(id as PanelGroupId)):[];
  const groupOrder=[...new Set([...ordered,...PANEL_GROUP_IDS])];
  return {toolbarDouble:bool("toolbarDouble"),showMoveTransform:bool("showMoveTransform"),width:number("width",240,480),height:number("height",320,1200),x:number("x",0,10000),y:number("y",0,10000),split:number("split",.2,.8),floating:bool("floating"),layersCollapsed:bool("layersCollapsed"),historyCollapsed:bool("historyCollapsed"),propertiesCollapsed:bool("propertiesCollapsed"),collapsedGroups,hiddenGroups,groupOrder,groupHeights,activeTabs};
}
export function readPanelLayout():EditorPanelLayout {
  if(!readRememberWorkspaceChanges())return {...DEFAULT_PANEL_LAYOUT};
  try {return normalizePanelLayout(JSON.parse(localStorage.getItem(PANEL_LAYOUT_KEY)??"null"));} catch {return {...DEFAULT_PANEL_LAYOUT};}
}
export function savePanelLayout(value:EditorPanelLayout):void {
  if(!readRememberWorkspaceChanges())return;
  try {localStorage.setItem(PANEL_LAYOUT_KEY,JSON.stringify(value));} catch { /* 存储受限时仍可在当前工作区调整。 */ }
}
