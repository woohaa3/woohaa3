import {memoryRecord,memoryNumber,memoryChoice,memoryBoolean} from "./tool-memory.js";
import {DEFAULT_BUCKET,type BucketSettings} from "./bucket-tool.js";
import {DEFAULT_SAMPLE,SAMPLE_LAYERS,SAMPLE_SIZES,type SampleSettings} from "./eyedropper-tool.js";
import {DEFAULT_MAGIC_WAND,COLOR_RANGE_SELECTIONS,DEFAULT_COLOR_RANGE,type MagicWandSettings,type ColorRangeSettings} from "./photo-editor-tools.js";
import {DEFAULT_RETOUCH,RETOUCH_SPECS,type RetouchSettings,type RetouchToolId} from "./retouch-tools.js";
import type {PhotoEditorTool} from "./photo-editor-shortcuts.js";
export const decodeRememberedTool=(value:unknown):PhotoEditorTool=>memoryChoice(value,["pan","zoom","bucket","pencil","eyedropper","move","marquee","lasso","magicWand","brush","eraser","text"] as const,"marquee");
export const decodeMoveTarget=(value:unknown)=>memoryChoice(value,["layer","group"] as const,"group");
export const decodeSelectionMode=(value:unknown)=>memoryChoice(value,["replace","add","subtract","intersect"] as const,"replace");
export const decodeFeather=(value:unknown)=>memoryNumber(value,0,0,100);
export const decodeFalse=(value:unknown)=>memoryBoolean(value,false);
export const decodeTrue=(value:unknown)=>memoryBoolean(value,true);
export const decodeMarqueeLine=(value:unknown)=>value==="row" || value==="column"?value:undefined;
export const DEFAULT_CONSTRAINT={mode:"normal" as "normal"|"ratio"|"size",width:"1",height:"1"};
export function decodeMarqueeConstraint(value:unknown):typeof DEFAULT_CONSTRAINT {
 const raw=memoryRecord(value),mode=memoryChoice(raw.mode,["normal","ratio","size"] as const,"normal");
 const dimension=(value:unknown)=>typeof value==="string" && value.length<=32 && value.trim()!=="" && Number.isFinite(Number(value)) && Number(value)>=1 && Number(value)<=16384 && (mode!=="size" || Number.isInteger(Number(value)))?String(Number(value)):"1";
 return {mode,width:dimension(raw.width),height:dimension(raw.height)};
}
export function decodeBucketMemory(value:unknown):BucketSettings {
 const raw=memoryRecord(value);
 const number=(value:unknown,fallback:string,min:number,max:number)=>typeof value==="string" && value.trim()!=="" && Number.isFinite(Number(value)) && Number(value)>=min && Number(value)<=max?String(Number(value)):fallback;
 return {contents:memoryChoice(raw.contents,["foreground","pattern"] as const,DEFAULT_BUCKET.contents),pattern:typeof raw.pattern==="string" && raw.pattern.length<=256?raw.pattern:"",opacity:number(raw.opacity,"100",1,100),tolerance:number(raw.tolerance,"32",0,255),antiAlias:memoryBoolean(raw.antiAlias,true),contiguous:memoryBoolean(raw.contiguous,true),sampleAllLayers:memoryBoolean(raw.sampleAllLayers,false)};
}
export function decodeSampleMemory(value:unknown):SampleSettings {
 const raw=memoryRecord(value);return {size:typeof raw.size==="number" && (SAMPLE_SIZES as readonly number[]).includes(raw.size)?raw.size:DEFAULT_SAMPLE.size,sampleLayer:memoryChoice(raw.sampleLayer,SAMPLE_LAYERS.map(layer=>layer.id),"all")};
}
export function decodeMagicWandMemory(value:unknown):MagicWandSettings {
 const raw=memoryRecord(value);
 return {tolerance:memoryNumber(raw.tolerance,DEFAULT_MAGIC_WAND.tolerance,0,255),antialias:memoryBoolean(raw.antialias,DEFAULT_MAGIC_WAND.antialias),contiguous:memoryBoolean(raw.contiguous,DEFAULT_MAGIC_WAND.contiguous),sampleAllLayers:memoryBoolean(raw.sampleAllLayers,DEFAULT_MAGIC_WAND.sampleAllLayers)};
}
export function decodeColorRangeMemory(value:unknown):ColorRangeSettings {
 const raw=memoryRecord(value);const color=typeof raw.color==="string" && /^#[0-9a-f]{6}$/i.test(raw.color)?raw.color.toLowerCase():DEFAULT_COLOR_RANGE.color;
 return {select:memoryChoice(raw.select,COLOR_RANGE_SELECTIONS.map(([id])=>id),DEFAULT_COLOR_RANGE.select),color,fuzziness:memoryNumber(raw.fuzziness,DEFAULT_COLOR_RANGE.fuzziness,0,200),localized:memoryBoolean(raw.localized,DEFAULT_COLOR_RANGE.localized),range:memoryNumber(raw.range,DEFAULT_COLOR_RANGE.range,0,100),invert:memoryBoolean(raw.invert,DEFAULT_COLOR_RANGE.invert),sampleAllLayers:memoryBoolean(raw.sampleAllLayers,DEFAULT_COLOR_RANGE.sampleAllLayers),mode:memoryChoice(raw.mode,["replace","add","subtract","intersect"] as const,DEFAULT_COLOR_RANGE.mode)};
}

export const decodeRetouchTool=(value:unknown):RetouchToolId=>memoryChoice(value,Object.keys(RETOUCH_SPECS) as RetouchToolId[],"colorReplacement");
export function decodeRetouchMemory(value:unknown):RetouchSettings {
 const raw=memoryRecord(value),merged:Record<string,unknown>={...DEFAULT_RETOUCH};
 const point=(next:unknown):[number,number]|null=>Array.isArray(next)&&next.length===2&&next.every(entry=>typeof entry==="number"&&Number.isFinite(entry))?[next[0],next[1]]:null;
 for(const [key,fallback] of Object.entries(DEFAULT_RETOUCH)) {
  const next=raw[key];
  if(typeof fallback==="number")merged[key]=memoryNumber(next,fallback,-1e6,1e6);
  else if(typeof fallback==="boolean")merged[key]=memoryBoolean(next,fallback);
  else if(key==="historyState")merged[key]=typeof next==="number" && Number.isInteger(next) && next>=0 && next<=1e6?next:null;
  else if(key==="source"||key==="offset")merged[key]=point(next);
  else if(key==="sampleLayer")merged[key]=memoryChoice(next,["current","currentAndBelow","all"] as const,fallback as RetouchSettings["sampleLayer"]);
  else if(key==="sampling")merged[key]=memoryChoice(next,["continuous","once","backgroundSwatch"] as const,fallback as RetouchSettings["sampling"]);
  else if(key==="limits")merged[key]=memoryChoice(next,["contiguous","discontiguous","findEdges"] as const,fallback as RetouchSettings["limits"]);
  else if(key==="toneRange")merged[key]=memoryChoice(next,["shadows","midtones","highlights"] as const,fallback as RetouchSettings["toneRange"]);
  else if(key==="healingType")merged[key]=memoryChoice(next,["contentAware","createTexture","proximityMatch"] as const,fallback as RetouchSettings["healingType"]);
  else if(typeof fallback==="string")merged[key]=typeof next==="string" && next.length<=128?next:fallback;
 }
 return merged as RetouchSettings;
}
