/** Local tool preferences only: no document, draft, target, or temporary tool state. */
import {useEffect,useRef,useState,type Dispatch,type SetStateAction} from "react";
export const TOOL_MEMORY_PREFIX="photocraft.tools.v1.";
export type MemoryDecoder<T>=(value:unknown)=>T;
export function readToolMemory<T>(key:string,fallback:T,decode:MemoryDecoder<T>):T {
 try {const raw=globalThis.localStorage?.getItem(TOOL_MEMORY_PREFIX+key);return raw?decode(JSON.parse(raw)):fallback;}catch{return fallback;}
}
export function nondefaultToolMemory(value:unknown,fallback:unknown):unknown {
 if(value===fallback)return undefined;
 if(value!==null && typeof value==="object" && !Array.isArray(value)) {
  const base=memoryRecord(fallback),result:Record<string,unknown>={};
  for(const [key,item] of Object.entries(value)) {const changed=nondefaultToolMemory(item,base[key]);if(changed!==undefined)result[key]=changed;}
  return Object.keys(result).length?result:undefined;
 }
 return value;
}
export function useToolMemory<T>(key:string,fallback:T,decode:MemoryDecoder<T>,report?:(message:string)=>void):[T,Dispatch<SetStateAction<T>>] {
 const [value,setValue]=useState<T>(()=>readToolMemory(key,fallback,decode));
 const reportRef=useRef(report);reportRef.current=report;
 const previous=useRef<string|null|undefined>(undefined),failed=useRef(false);
 useEffect(()=>{
  const clean=decode(value),encoded=JSON.stringify(nondefaultToolMemory(clean,fallback)) ?? null;
  if(previous.current===encoded)return;
  try {
   const storage=globalThis.localStorage;if(!storage)throw new Error("storage unavailable");
   if(encoded===null)storage.removeItem(TOOL_MEMORY_PREFIX+key);
   else storage.setItem(TOOL_MEMORY_PREFIX+key,encoded);
   previous.current=encoded;failed.current=false;
  }catch{if(!failed.current){failed.current=true;reportRef.current?.("工具设置未能保存；本次编辑仍可使用，重新打开后可能恢复默认值。");}}
 },[value,key]);
 return [value,setValue];
}
export const memoryRecord=(value:unknown):Record<string,unknown>=>value!==null && typeof value==="object" && !Array.isArray(value)?value as Record<string,unknown>:{};
export const memoryNumber=(value:unknown,fallback:number,min:number,max:number)=>typeof value==="number" && Number.isFinite(value) && value>=min && value<=max?value:fallback;
export const memoryChoice=<T extends string>(value:unknown,choices:readonly T[],fallback:T):T=>typeof value==="string" && choices.includes(value as T)?value as T:fallback;
export const memoryBoolean=(value:unknown,fallback:boolean)=>typeof value==="boolean"?value:fallback;
export const memoryColor=(value:unknown,fallback:string)=>typeof value==="string" && /^#[0-9a-f]{6}$/i.test(value)?value.toLowerCase():fallback;
