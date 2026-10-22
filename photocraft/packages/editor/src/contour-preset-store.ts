import type {ContourPreset} from "./editor-wasm.js";

export type UserContourPreset=ContourPreset & {id:string};
export type ContourLibraryActions={create:(name:string,contour:unknown)=>boolean;rename:(id:string,name:string)=>boolean;remove:(id:string)=>boolean};
export const CONTOUR_LIBRARY_KEY="woohaa.image-editor.contours.v1";
export const MAX_USER_CONTOURS=64;
const MAX_BYTES=1_048_576;
const object=(v:unknown):v is Record<string,unknown>=>!!v && typeof v==="object" && !Array.isArray(v);
const keys=(v:Record<string,unknown>,allowed:string[])=>Object.keys(v).every(key=>allowed.includes(key));
const nameValid=(v:unknown):v is string=>typeof v==="string" && v.trim().length>0 && v.length<=200;
const unit=(v:unknown):v is number=>typeof v==="number" && Number.isFinite(v) && v>=0 && v<=1;

/** 库只保存原生 Contour 快照；不通过 SHC 量化验证，避免丢失精细控制点。 */
export function validLibraryContour(value:unknown):boolean {
  if(value==="Linear") return true;
  if(!object(value) || !keys(value,["Custom"]) || !object(value.Custom)) return false;
  const c=value.Custom;
  if(!keys(c,["name","points","corners"]) || typeof c.name!=="string" || c.name.length>200 || !Array.isArray(c.points) || c.points.length<2 || c.points.length>256) return false;
  let previous=-1;
  for(const p of c.points) {
    if(!object(p) || !keys(p,["input","output"]) || !unit(p.input) || !unit(p.output) || p.input<=previous) return false;
    previous=p.input;
  }
  return c.corners===undefined || (Array.isArray(c.corners) && c.corners.length<=c.points.length && c.corners.every(v=>typeof v==="boolean"));
}
export function validateContourLibrary(value:unknown):value is UserContourPreset[] {
  if(!Array.isArray(value) || value.length>MAX_USER_CONTOURS) return false;
  const ids=new Set<string>();
  const valid=value.every(p=>{
    if(!object(p) || !keys(p,["id","name","contour"]) || !nameValid(p.id) || ids.has(p.id) || !nameValid(p.name) || !validLibraryContour(p.contour)) return false;
    ids.add(p.id);return true;
  });
  return valid && new TextEncoder().encode(JSON.stringify({version:1,presets:value})).length<=MAX_BYTES;
}
export function readContourLibrary():UserContourPreset[] {
  try {
    const raw=localStorage.getItem(CONTOUR_LIBRARY_KEY);
    if(!raw || raw.length>MAX_BYTES || new TextEncoder().encode(raw).length>MAX_BYTES) return [];
    const stored=JSON.parse(raw);
    return object(stored) && stored.version===1 && validateContourLibrary(stored.presets)?stored.presets:[];
  } catch {return [];}
}
/** 写入失败仍可在当前编辑器使用，调用方显示未持久化提示。 */
export function saveContourLibrary(presets:UserContourPreset[]):boolean {
  if(!validateContourLibrary(presets)) return false;
  const raw=JSON.stringify({version:1,presets});
  if(new TextEncoder().encode(raw).length>MAX_BYTES) return false;
  try {localStorage.setItem(CONTOUR_LIBRARY_KEY,raw);return true;} catch {return false;}
}
export function namedContour(contour:unknown,name:string):unknown {
  const next=structuredClone(contour);
  if(object(next) && object(next.Custom)) next.Custom.name=name;
  return next;
}
