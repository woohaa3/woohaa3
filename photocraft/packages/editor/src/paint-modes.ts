import {PHOTOSHOP_BLENDS} from "./editor-view-model.js";
/** Clear belongs only to painting; it must never enter the layer blend catalogue. */
export const PAINT_MODES:readonly string[]=[...PHOTOSHOP_BLENDS.slice(0,2),"Clear",...PHOTOSHOP_BLENDS.slice(2)];
export function cyclePaintMode(value:string,direction:-1|1):string {
 const index=PAINT_MODES.findIndex(mode=>mode.toLowerCase()===value.toLowerCase());
 return PAINT_MODES[(Math.max(0,index)+direction+PAINT_MODES.length)%PAINT_MODES.length]!;
}
