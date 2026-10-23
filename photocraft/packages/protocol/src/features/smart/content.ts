import { IMAGE_PROJECT_LIMITS } from "../../image-edit.js";
import { HASH16 } from "../shared/content.js";

/** 共享源按本文件首次出现顺序编号，不使用进程内 contents_id。完整仿射保留非等比/剪切。 */
export type ImageProjectSmartSummary = {
  sourceContentHash: string;
  sourceName: string;
  contentsGroup: number;
  transform: [number,number,number,number,number,number];
};

export function canonicalizeSmart(value: ImageProjectSmartSummary | null | undefined): string | null {
  if(!value || typeof value!=="object" || Array.isArray(value)
      || Object.keys(value).length!==4 || Object.keys(value).some(key=>!["sourceContentHash","sourceName","contentsGroup","transform"].includes(key))) return null;
  if(typeof value.sourceContentHash!=="string" || !HASH16.test(value.sourceContentHash)
      || typeof value.sourceName!=="string" || !value.sourceName.trim() || value.sourceName.length>200
      || /[\\/:\u0000-\u001f\u007f-\u009f]/.test(value.sourceName) || !/^.+\.pcraft$/i.test(value.sourceName) || !value.sourceName.slice(0,-7).trim()
      || !Number.isSafeInteger(value.contentsGroup) || value.contentsGroup<1 || value.contentsGroup>IMAGE_PROJECT_LIMITS.maxLayers
      || !Array.isArray(value.transform) || value.transform.length!==6 || !value.transform.every(n=>typeof n==="number" && Number.isFinite(n))) return null;
  const [a,b,c,d]=value.transform,det=a*d-b*c;
  if(!Number.isFinite(det) || Math.abs(det)<1e-12) return null;
  const view=new DataView(new ArrayBuffer(8));
  const affine=value.transform.map(n=>{view.setFloat64(0,n===0?0:n,true);return Array.from({length:8},(_,i)=>view.getUint8(i).toString(16).padStart(2,"0")).join("");}).join("");
  return `smart:${value.contentsGroup}:${value.sourceContentHash}:${affine}:${value.sourceName.length}:${value.sourceName}`;
}
