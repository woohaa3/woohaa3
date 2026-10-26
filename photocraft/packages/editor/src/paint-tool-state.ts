/** 绘画偏好属于当前编辑器；颜色共用、笔头分别记忆，目标读取内核。 */
import { useCallback, useRef, type SetStateAction } from "react";
import { DEFAULT_BRUSH, clampBrushSize, type BrushSettings } from "./photo-editor-tools.js";

import {useToolMemory,memoryRecord,memoryNumber,memoryChoice,memoryBoolean,memoryColor} from "./tool-memory.js";
import {PAINT_MODES} from "./paint-modes.js";
type PaintingTool = "brush" | "eraser" | "pencil";
function parameters({color: _color,target: _target,...settings}:BrushSettings) { return settings; }
export class PaintPercentInput {
  private previous: {digit:number;time:number;property:string;tool:string} | null = null;
  reset(): void { this.previous = null; }
  input(digit:number,property:string,tool:string,time:number): number {
    const previous=this.previous;
    if (previous && previous.tool===tool && previous.property===property && time-previous.time>=0 && time-previous.time<800) {
      this.previous=null;
      const percent=previous.digit*10+digit;
      return percent/100;
    }
    this.previous={digit,time,property,tool};
    return (digit || 10)/10;
  }
}

const freshPaint=()=>({brush:parameters(DEFAULT_BRUSH),eraser:parameters(DEFAULT_BRUSH),pencil:parameters({...DEFAULT_BRUSH,size:1,hardness:1,smoothing:0})});
export function decodePaintMemory(value:unknown):ReturnType<typeof freshPaint> {
 const input=memoryRecord(value),result=freshPaint();
 for(const tool of ["brush","eraser","pencil"] as const) {
  const raw=memoryRecord(input[tool]),base=result[tool];
  result[tool]={size:memoryNumber(raw.size,base.size,1,512),hardness:memoryNumber(raw.hardness,base.hardness,0,1),opacity:memoryNumber(raw.opacity,base.opacity,0,1),flow:memoryNumber(raw.flow,base.flow,0,1),smoothing:memoryNumber(raw.smoothing,base.smoothing,0,1),
   ...(raw.angle!==undefined?{angle:memoryNumber(raw.angle,0,-180,180)}:{}),
   ...(raw.autoErase!==undefined?{autoErase:memoryBoolean(raw.autoErase,false)}:{}),
   ...(raw.eraserMode!==undefined?{eraserMode:memoryChoice(raw.eraserMode,["brush","pencil","block"] as const,"brush")} :{}),
   ...(raw.mode!==undefined?{mode:memoryChoice(raw.mode,PAINT_MODES,"Normal")}:{})};
 }
 return result;
}
const defaultColors={foreground:"#000000",background:"#ffffff"};
const defaultMaskColors={foreground:"#ffffff",background:"#000000"};
const decodeColors=(value:unknown,fallback:typeof defaultColors)=>{const raw=memoryRecord(value);return {foreground:memoryColor(raw.foreground,fallback.foreground),background:memoryColor(raw.background,fallback.background)};};
export const decodePaintColors=(value:unknown)=>decodeColors(value,defaultColors);
const decodeMaskColors=(value:unknown)=>decodeColors(value,defaultMaskColors);

export function usePaintTools(tool: string, target?: "pixels"|"mask",report?:(message:string)=>void) {
  const current: PaintingTool = tool === "eraser" ? "eraser" : tool==="pencil"?"pencil":"brush";
  const [settings,setSettings]=useToolMemory("paint",freshPaint(),decodePaintMemory,report);
  const [pixelColors,setPixelColors]=useToolMemory("colors",defaultColors,decodePaintColors,report);
  const [maskColors,setMaskColors]=useToolMemory("maskColors",defaultMaskColors,decodeMaskColors,report);
  const colors=target==="mask"?maskColors:pixelColors,setColors=target==="mask"?setMaskColors:setPixelColors;
  const digits=useRef(new PaintPercentInput());
  const resetDigits=useCallback(()=>digits.current.reset(),[]);
  const brush={...settings[current],color:colors.foreground,target:target ?? "pixels"};
  const setBrush=(action:SetStateAction<BrushSettings>) => {
    const next=typeof action === "function" ? action(brush) : action;
    setSettings((all)=>({...all,[current]:parameters(next)}));
    if (next.color!==colors.foreground) setColors((value)=>({...value,foreground:next.color}));
  };
  const setColor=(foreground:string) => setColors((value)=>({...value,foreground}));
  const colorAction=(action:"swap"|"reset") => setColors((value)=>action==="swap"
    ? {foreground:value.background,background:value.foreground}
    : brush.target==="mask" ? {foreground:"#ffffff",background:"#000000"} : {foreground:"#000000",background:"#ffffff"});
  const percent=(digit:number,property:"opacity"|"flow") => {
    if(current==="pencil" && property==="flow"){digits.current.reset();return;}
    const value=digits.current.input(digit,property,current,performance.now());
    setBrush({...brush,[property]:property==="flow"?Math.max(.01,value):value});
  };
  const resetPaint=(tool:PaintingTool|"all")=>{
    const fresh={brush:parameters(DEFAULT_BRUSH),eraser:parameters(DEFAULT_BRUSH),pencil:parameters({...DEFAULT_BRUSH,size:1,hardness:1,smoothing:0})};
    setSettings(all=>tool==="all"?fresh:{...all,[tool]:fresh[tool]});digits.current.reset();
  };
  return {brush,setBrush,resetPaint,colors,pixelBackground:pixelColors.background,setColor,setBackground:(background:string)=>setColors((value)=>({...value,background})),colorAction,percent,resetDigits};
}

/** Read preset tool settings back before local options can override them on the next stroke. */
export function nativeBrushSettings(value:unknown):Partial<BrushSettings> {
  if(!value || typeof value!=="object")return {};
  const raw=value as Record<string,unknown>,patch:Partial<BrushSettings>={};
  for(const key of ["size","hardness","opacity","flow","angle"] as const){const n=raw[key];if(typeof n==="number" && Number.isFinite(n))patch[key]=key==="size"?clampBrushSize(n):n;}
  if(raw.smoothing && typeof raw.smoothing==="object"){
    const smoothing=raw.smoothing as {enabled?:boolean;amount?:unknown};if(typeof smoothing.amount==="number" && Number.isFinite(smoothing.amount))patch.smoothing=smoothing.enabled===false?0:Math.max(0,Math.min(1,smoothing.amount));
  }
  if(typeof raw.mode==="string"){
    const normalize=(s:string)=>s.toLowerCase().replace(/\s|\(add\)/g,"");
    const mode=PAINT_MODES.find(mode=>normalize(mode)===normalize(raw.mode as string));if(mode)patch.mode=raw.erase===true?"Clear":mode;
  }
  return patch;
}
