import { SOMA77_JOINTS } from './skeleton.js';
export type SomaBindGroup = {id:string;parent?:string|null;position?:readonly number[];rotation?:readonly number[];scale?:readonly number[]};
const near=(a:readonly number[],b:readonly number[])=>a.length===b.length&&a.every((v,i)=>Number.isFinite(v)&&Math.abs(v-b[i]!)<1e-6);
/** Match compiled geometry frames, never source strings or an assistant's claimed profile. */
export function somaSkeletonPrefix(groups:readonly SomaBindGroup[],expectedPrefix?:string):string|null {
 const byId=new Map(groups.map(g=>[g.id,g]));
 for(const root of groups){
  if(expectedPrefix!==undefined&&root.id!==expectedPrefix)continue;
  if(!near(root.position??[0,0,0],[0,0,0])||!near(root.rotation??[0,0,0],[0,0,0])||!near(root.scale??[1,1,1],[1,1,1]))continue;
  const prefix=root.id;
  if(SOMA77_JOINTS.every(j=>{
   const g=byId.get(`${prefix}.${j.name}`);
   return g&&g.parent===(j.parent<0?prefix:`${prefix}.${SOMA77_JOINTS[j.parent]!.name}`)&&near(g.position??[0,0,0],j.position)&&near(g.rotation??[0,0,0],j.rotation)&&near(g.scale??[1,1,1],[1,1,1]);
  }))return prefix;
 }
 return null;
}
