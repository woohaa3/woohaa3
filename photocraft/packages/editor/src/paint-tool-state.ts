/** 绘画偏好属于当前编辑器；颜色共用、笔头分别记忆，目标读取内核。 */
import { useCallback, useRef, useState, type SetStateAction } from "react";
import { DEFAULT_BRUSH, type BrushSettings } from "./photo-editor-tools.js";

type PaintingTool = "brush" | "eraser";
function parameters({color: _color,target: _target,...settings}:BrushSettings) { return settings; }
export class PaintPercentInput {
  private previous: {digit:number;time:number;property:string;tool:PaintingTool} | null = null;
  reset(): void { this.previous = null; }
  input(digit:number,property:string,tool:PaintingTool,time:number): number {
    const previous=this.previous;
    if (previous && previous.tool===tool && previous.property===property && time-previous.time>=0 && time-previous.time<700) {
      this.previous=null;
      const percent=previous.digit*10+digit;
      return (percent || 100)/100;
    }
    this.previous={digit,time,property,tool};
    return (digit || 10)/10;
  }
}

export function usePaintTools(tool: string, target?: "pixels"|"mask") {
  const current: PaintingTool = tool === "eraser" ? "eraser" : "brush";
  const [settings,setSettings]=useState({brush:parameters(DEFAULT_BRUSH),eraser:parameters(DEFAULT_BRUSH)});
  const [colors,setColors]=useState({foreground:"#000000",background:"#ffffff"});
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
    const value=digits.current.input(digit,property,current,performance.now());
    setBrush({...brush,[property]:value});
  };
  return {brush,setBrush,colors,setColor,setBackground:(background:string)=>setColors((value)=>({...value,background})),colorAction,percent,resetDigits};
}
