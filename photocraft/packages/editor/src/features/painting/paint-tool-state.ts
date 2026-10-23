/** 绘画偏好属于当前编辑器；颜色共用、笔头分别记忆，目标读取内核。 */
import { useCallback, useRef, useState, type SetStateAction } from "react";
import { DEFAULT_BRUSH, brushSettingsPatch, type BrushSettings } from "../../photo-editor-tools.js";

type PaintingTool = string;
function parameters({color: _color,target: _target,...settings}:BrushSettings) { return settings; }

/**
 * 把工具参数补丁拆成「标量」与「动态」两部分。
 *
 * 标量（size/hardness/opacity/flow/smoothing）由工具状态持有并即时反映到画布光标；
 * 其余键（spacing/angle/roundness/flip/shapeDynamics/…）属于笔刷动态，合并进 `dynamics`
 * 后由 `buildStroke` 原样作为 `paint.stroke` 的 `brush` 补丁传给内核。
 */
export function mergeBrushPatch(current: BrushSettings, patch: Partial<BrushSettings> & Record<string, unknown>): BrushSettings {
  const scalars: Partial<BrushSettings> = {};
  const dynamics: Record<string, unknown> = { ...(current.dynamics ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    // `mode` 是 `paint.stroke` 的顶层参数（U30），不是 brush 补丁：留在标量里，由 buildStroke 发出。
    if (key === "size" || key === "hardness" || key === "opacity" || key === "flow" || key === "smoothing" || key === "color" || key === "target" || key === "mode") {
      (scalars as Record<string, unknown>)[key] = value;
    } else {
      dynamics[key] = value;
    }
  }
  const next: BrushSettings = { ...current, ...scalars };
  if (Object.keys(dynamics).length) next.dynamics = dynamics;
  return next;
}

/** 动态补丁 → `paint.stroke` 的 `brush` 参数（供预览与命令共用）。 */
export function dynamicsCommandPatch(brush: BrushSettings): Record<string, unknown> | null {
  return brush.dynamics && Object.keys(brush.dynamics).length ? brushSettingsPatch(brush.dynamics) : null;
}

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
  const current: PaintingTool = tool;
  const [settings,setSettings]=useState<Record<string,ReturnType<typeof parameters>>>({brush:parameters(DEFAULT_BRUSH),eraser:parameters(DEFAULT_BRUSH)});
  const [colors,setColors]=useState({foreground:"#000000",background:"#ffffff"});
  const digits=useRef(new PaintPercentInput());
  const resetDigits=useCallback(()=>digits.current.reset(),[]);
  const brush={...(settings[current] ?? parameters(DEFAULT_BRUSH)),color:colors.foreground,target:target ?? "pixels"};
  const setBrush=(action:SetStateAction<BrushSettings>) => {
    const next=typeof action === "function" ? action(brush) : mergeBrushPatch(brush, action as Partial<BrushSettings> & Record<string, unknown>);
    setSettings((all)=>({...all,[current]:parameters(next)}));
    if (next.color!==colors.foreground) setColors((value)=>({...value,foreground:next.color}));
  };
  const setColor=(foreground:string) => setColors((value)=>({...value,foreground}));
  const colorAction=(action:"swap"|"reset") => setColors((value)=>action==="swap"
    ? {foreground:value.background,background:value.foreground}
    : brush.target==="mask" ? {foreground:"#ffffff",background:"#000000"} : {foreground:"#000000",background:"#ffffff"});
  const percent=(digit:number,property:"opacity"|"flow",apply=true) => {
    const value=digits.current.input(digit,property,current,performance.now());
    if (apply) setBrush({...brush,[property]:value});
    return value;
  };
  return {brush,setBrush,colors,setColor,setBackground:(background:string)=>setColors((value)=>({...value,background})),colorAction,percent,resetDigits};
}
