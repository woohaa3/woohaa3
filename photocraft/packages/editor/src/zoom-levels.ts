/** Fixed upstream zoom ladder; limits apply to every editor navigation control. */
export const ZOOM_LEVELS=[.001,.002,.003,.004,.005,.007,.01,.015,.02,.03,.04,.05,.0625,1/12,.125,1/6,.25,1/3,.5,2/3,1,2,3,4,5,6,7,8,12,16,32,64,128] as const;
export function minimumZoom(width:number,height:number):number {const short=Math.min(width,height);return short>0?Math.min(128,2/short):.001;}
export function clampEditorZoom(value:number,width:number,height:number):number {return Number.isFinite(value)?Math.min(128,Math.max(minimumZoom(width,height),value)):1;}
export function stepEditorZoom(value:number,direction:number,width:number,height:number):number {
 const current=clampEditorZoom(value,width,height),next=direction>0?ZOOM_LEVELS.find(step=>step>current*1.001)??128:[...ZOOM_LEVELS].reverse().find(step=>step<current*.999)??current;
 return clampEditorZoom(next,width,height);
}
