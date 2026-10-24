import {clampBrushSize} from "./photo-editor-tools.js";
export type BrushResizeValues={size:number;hardness:number;opacity:number};
export function resizeBrush(base:BrushResizeValues,dx:number,dy:number,hardness=true,zoom=1):BrushResizeValues {
  const property=hardness?"hardness":"opacity";
  return {...base,size:clampBrushSize(Math.round(base.size+2*(Number.isFinite(dx)?dx:0)/(Number.isFinite(zoom) && zoom>0?zoom:1))),[property]:Math.round(Math.max(0,Math.min(1,base[property]+(Number.isFinite(dy)?dy:0)/200))*100)/100};
}
export function stepBrushSize(size:number,direction:-1|1):number {
 return clampBrushSize(direction===1?Math.max(Math.round(size*1.25),size+1):Math.min(Math.round(size/1.25),size-1));
}
export function stepBrushHardness(value:number,direction:-1|1):number {
 return Math.max(0,Math.min(4,Math.round(value*4)+direction))/4;
}

export function normalizeBrushAngle(value:number):number {if(!Number.isFinite(value))return 0;const angle=((value+180)%360+360)%360-180;return Object.is(angle,-0)?0:angle;}
