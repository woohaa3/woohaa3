import {useEffect,useRef,useState} from "react";
import type {EditorPreview,EditorResult} from "./editor-wasm.js";
import {useEditorTheme} from "./editor-theme.js";
export const FONT_PREVIEWS=[{id:"off",label:"关闭",size:0},{id:"small",label:"小",size:14},{id:"medium",label:"中",size:18},{id:"large",label:"大",size:24},{id:"extraLarge",label:"特大",size:32},{id:"huge",label:"最大",size:40}] as const;
export type FontPreviewSize=(typeof FONT_PREVIEWS)[number]["id"];
export type FontSampleReader=(family:string,size:number,scale:number)=>EditorResult<EditorPreview>;
export function normalizeFontPreview(value:unknown):FontPreviewSize{return FONT_PREVIEWS.some(item=>item.id===value)?value as FontPreviewSize:"medium";}
/** Native monochrome samples are tinted with the local editor theme; no CSS font fallback. */
export function FontMenuSample({family,preview,read}:{family:string;preview:FontPreviewSize;read?:FontSampleReader}){
 const size=FONT_PREVIEWS.find(item=>item.id===preview)!.size,scale=Math.max(1,Math.min(4,Math.ceil(globalThis.devicePixelRatio||1)));
 const [pixels,setPixels]=useState<EditorPreview|null>(null),canvas=useRef<HTMLCanvasElement>(null),theme=useEditorTheme();
 useEffect(()=>{const result=size?read?.(family,size,scale):null;setPixels(result?.ok?result.value:null);},[family,size,scale,read]);
 useEffect(()=>{
  if(!pixels||!canvas.current)return;const context=canvas.current.getContext("2d");if(!context)return;
  context.putImageData(new ImageData(new Uint8ClampedArray(pixels.pixels),pixels.width,pixels.height),0,0);
  context.globalCompositeOperation="source-in";context.fillStyle=getComputedStyle(canvas.current).color;context.fillRect(0,0,pixels.width,pixels.height);context.globalCompositeOperation="source-over";
 },[pixels,theme.resolved]);
 return pixels&&size?<canvas ref={canvas} data-font-sample={family} title="AaBbCc" width={pixels.width} height={pixels.height} style={{width:pixels.width/scale,height:pixels.height/scale}}/>:null;
}
