import type {EditorViewport} from "./viewport.js";
import {clampEditorZoom} from "./zoom-levels.js";
export type NavigatorFrame={viewport:EditorViewport;size:{width:number;height:number};document:{width:number;height:number}};
export type NavigatorAction={type:"center";x:number;y:number}|{type:"rectangle";x:number;y:number;width:number;height:number};
export function navigatorVisibleRect(frame:NavigatorFrame){const {viewport:v,size,document:d}=frame;return {x:d.width/2-(size.width/2+v.x)/v.zoom,y:d.height/2-(size.height/2+v.y)/v.zoom,width:size.width/v.zoom,height:size.height/v.zoom};}
export function navigatorViewport(frame:NavigatorFrame,action:NavigatorAction):EditorViewport|null {
  if(!["center","rectangle"].includes(action.type)||typeof action.x!=="number"||typeof action.y!=="number"||![action.x,action.y].every(Number.isFinite))return null;
  let {x,y}=action,zoom=frame.viewport.zoom;
  if(action.type==="rectangle"){if(![action.width,action.height].every(value=>typeof value==="number"&&Number.isFinite(value))||action.width<=0||action.height<=0||frame.size.width<=0||frame.size.height<=0)return null;zoom=clampEditorZoom(Math.min(frame.size.width/action.width,frame.size.height/action.height),frame.document.width,frame.document.height);x+=action.width/2;y+=action.height/2;}
  return {x:(frame.document.width/2-x)*zoom,y:(frame.document.height/2-y)*zoom,zoom};
}

/** Upstream menus paste in place when any copied area is visible; native paste handles document bounds. */
export function clipboardVisible(bounds:readonly number[],frame:NavigatorFrame):boolean {const visible=navigatorVisibleRect(frame);return bounds[2]!>visible.x&&bounds[0]!<visible.x+visible.width&&bounds[3]!>visible.y&&bounds[1]!<visible.y+visible.height;}
