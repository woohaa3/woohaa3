import { IMAGE_PROJECT_LIMITS } from "../../image-edit.js";
import { type ImageProjectLayer, isNonEmptyShortString, isFinitePositiveInteger } from "../shared/content.js";

/** 内容身份支持的混合模式；pass-through 仅用于组。 */
export const IMAGE_PROJECT_BLEND_MODES = ["normal", "dissolve", "darken", "multiply", "color-burn", "linear-burn", "darker-color", "lighten", "screen", "color-dodge", "linear-dodge", "lighter-color", "overlay", "soft-light", "hard-light", "vivid-light", "linear-light", "pin-light", "hard-mix", "difference", "exclusion", "subtract", "divide", "hue", "saturation", "color", "luminosity", "pass-through"] as const;

export type ImageProjectBlendMode = (typeof IMAGE_PROJECT_BLEND_MODES)[number];

export function canonicalizeLocks(locks: ImageProjectLayer["locks"]): string | null {
  if (locks === undefined) return "";
  if (locks === null || typeof locks !== "object" || Array.isArray(locks)) return null;
  const keys = ["transparency", "pixels", "position", "artboard", "all"] as const;
  if (Object.keys(locks).some(key => !keys.includes(key as typeof keys[number]))) return null;
  if (Object.values(locks).some(value => typeof value !== "boolean")) return null;
  const flags = keys.map(key => locks[key] === true ? "1" : "0").join("");
  return flags.includes("1") ? `|locks:${flags}` : "";
}

export function isImageProjectBlendMode(value: unknown): value is ImageProjectBlendMode {
  return typeof value === "string" && (IMAGE_PROJECT_BLEND_MODES as readonly string[]).includes(value);
}

/** 有界样式结构与可选工程图案关联检查，最终类型解析仍由固定 Rust 内核执行。 */
export function isSupportedImageProjectEffects(input: unknown,patterns?:unknown[]): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const effects = input as Record<string,unknown>;
  if (typeof effects.enabled !== "boolean" || !Array.isArray(effects.items) || effects.items.length > 64 || effects.psd_raw != null) return false;
  if (effects.reference != null && (!Array.isArray(effects.reference) || effects.reference.length !== 2 || !effects.reference.every(value=>typeof value==="number" && Number.isFinite(value)))) return false;
  const kinds = ["DropShadow","InnerShadow","OuterGlow","InnerGlow","Stroke","ColorOverlay","GradientOverlay","PatternOverlay","Satin","BevelEmboss"];
  let budget=8192;const references:{id:string;name:string}[]=[];
  const bounded=(value:unknown,depth:number,key=""):boolean=>{
    if (depth>16 || budget--<=0) return false;
    if (value===null) return key==="texture" || key==="contour";
    if (typeof value==="boolean") return true;
    if (typeof value==="number") {
      const range:Record<string,[number,number]>={opacity:[0,1],spread:[0,1],range:[0,1],jitter:[0,1],noise:[0,1],size:[0,2048],soften:[0,2048],distance:[0,2048],depth:[0,10],"texture-depth":[-10,10],scale:[.01,10],angle:[-360,360],altitude:[0,90]};
      const [min,max]=range[key]??[-1_000_000,1_000_000];return Number.isFinite(value) && value>=min && value<=max;
    }
    if (typeof value==="string") return value.length<=200;
    if (Array.isArray(value)) return value.length<=256
      && (!["stops","opacity_stops"].includes(key) || value.every(stop=>Array.isArray(stop) && stop.length===2
        && typeof stop[0]==="number" && Number.isFinite(stop[0]) && stop[0]>=0 && stop[0]<=1
        && (key!=="opacity_stops" || (typeof stop[1]==="number" && Number.isFinite(stop[1]) && stop[1]>=0 && stop[1]<=1))))
      && value.every(item=>bounded(item,depth+1));
    if (typeof value!=="object" || !value) return false;
    const entries=Object.entries(value);
    if(["Pattern","PatternOverlay","texture"].includes(key)) {
      const p=value as Record<string,unknown>;
      if(typeof p.id!=="string" || !p.id.trim() || typeof p.name!=="string" || !p.name.trim()
          || typeof p.scale!=="number" || !Number.isFinite(p.scale) || p.scale<.01 || p.scale>10
          || (p.phase!==undefined && (!Array.isArray(p.phase) || p.phase.length!==2))) return false;
      references.push({id:p.id,name:p.name});
    }
    if ("Custom" in value) {
      const custom=(value as {Custom:unknown}).Custom;
      if (!custom || typeof custom!=="object" || Array.isArray(custom)) return false;
      const {points,corners}=custom as Record<string,unknown>;
      if (!Array.isArray(points) || points.length<2 || points.length>256) return false;
      let previous=-1;
      if (!points.every(point=>{
        if (!point || typeof point!=="object" || Array.isArray(point)) return false;
        const {input,output}=point as Record<string,unknown>;
        if (typeof input!=="number" || typeof output!=="number" || !Number.isFinite(input) || !Number.isFinite(output)
          || input<0 || input>1 || output<0 || output>1 || input<=previous) return false;
        previous=input;return true;
      })) return false;
      if (corners!==undefined && (!Array.isArray(corners) || corners.length>points.length || !corners.every(corner=>typeof corner==="boolean"))) return false;
    }
    return entries.length<=64 && entries.every(([field,item])=>(field!=="blend" || (typeof item==="string" && IMAGE_PROJECT_BLEND_MODES.some(mode=>mode!=="pass-through" && mode.replace(/-/g,"")===item.toLowerCase()))) && bounded(item,depth+1,field==="depth" && key==="texture"?"texture-depth":field));
  };
  const shape=effects.items.every(item=>item && typeof item==="object" && !Array.isArray(item)
    && Object.keys(item).length===1 && kinds.includes(Object.keys(item)[0]!) && bounded(item,0));
  return shape && (patterns===undefined || references.every(ref=>patterns.some(p=>!!p && typeof p==="object" && (p as Record<string,unknown>).id===ref.id && (p as Record<string,unknown>).name===ref.name)));

}

/** 工程图案资源的轻量结构核验；在原生 tile 解码前执行。 */
export function isSupportedImageProjectPatterns(value:unknown):boolean {
  if(value===undefined) return true;
  if(!Array.isArray(value) || value.length>IMAGE_PROJECT_LIMITS.maxPatterns) return false;
  const ids=new Set<string>();let pixels=0;
  const object=(v:unknown):v is Record<string,unknown>=>!!v && typeof v==="object" && !Array.isArray(v);
  return value.every(p=>{
    if(!object(p) || !isNonEmptyShortString(p.id,200) || !p.id.trim() || ids.has(p.id)
        || !isNonEmptyShortString(p.name,200) || !p.name.trim()
        || !isFinitePositiveInteger(p.width) || !isFinitePositiveInteger(p.height)
        || p.width>IMAGE_PROJECT_LIMITS.maxPatternSide || p.height>IMAGE_PROJECT_LIMITS.maxPatternSide) return false;
    ids.add(p.id);pixels+=p.width*p.height;if(pixels>IMAGE_PROJECT_LIMITS.maxPatternPixels) return false;
    const s=p.surface;if(!object(s) || !object(s.format)) return false;
    const f=s.format;
    if(f.mode!=="Rgb" || f.sample!=="U8" || typeof f.alpha!=="boolean"
        || typeof s.default!=="string" || s.default.length!==(f.alpha?8:6) || !/^[a-f0-9]+$/i.test(s.default)
        || !Array.isArray(s.tiles) || s.tiles.length>16) return false;
    const width=p.width,height=p.height;
    const coords=new Set<string>();
    return s.tiles.every(t=>{
      if(!object(t) || typeof t.tx!=="number" || typeof t.ty!=="number" || !Number.isInteger(t.tx) || !Number.isInteger(t.ty)
          || t.tx<0 || t.ty<0 || t.tx>=Math.ceil(width/256) || t.ty>=Math.ceil(height/256)) return false;
      const key=`${t.tx},${t.ty}`;if(coords.has(key)) return false;coords.add(key);return true;
    });
  });
}
