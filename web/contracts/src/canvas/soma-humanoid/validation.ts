import { SOMA77_JOINTS } from './skeleton.js';
import { SOMA_BODY_PRESETS, somaBodyJoints, type SomaBodyPresetId } from './body-presets.js';
export type SomaBindGroup = {id:string;parent?:string|null;position?:readonly number[];rotation?:readonly number[];scale?:readonly number[]};
const near=(a:readonly number[],b:readonly number[])=>a.length===b.length&&a.every((v,i)=>Number.isFinite(v)&&Math.abs(v-b[i]!)<1e-6);
/** Match all compiled parent links, local bind frames and unit scales against immutable exports. */
export function somaSkeletonIdentity(groups:readonly SomaBindGroup[],expectedPrefix?:string):{prefix:string;bodyPreset?:SomaBodyPresetId}|null {
 const byId=new Map(groups.map(g=>[g.id,g]));
 if(byId.size!==groups.length)return null;
 for(const root of groups){
  if(expectedPrefix!==undefined&&root.id!==expectedPrefix)continue;
  if(!near(root.position??[0,0,0],[0,0,0])||!near(root.rotation??[0,0,0],[0,0,0])||!near(root.scale??[1,1,1],[1,1,1]))continue;
  const prefix=root.id;
  const matches=(joints:typeof SOMA77_JOINTS)=>joints.every(j=>{
   const g=byId.get(`${prefix}.${j.name}`);
   return g&&g.parent===(j.parent<0?prefix:`${prefix}.${joints[j.parent]!.name}`)&&near(g.position??[0,0,0],j.position)&&near(g.rotation??[0,0,0],j.rotation)&&near(g.scale??[1,1,1],[1,1,1]);
  });
  if(matches(SOMA77_JOINTS))return {prefix};
  // Root candidates must have a Hips child before any body data is decoded.
  if(!byId.has(`${prefix}.Hips`))continue;
  for(const preset of SOMA_BODY_PRESETS)if(matches(somaBodyJoints(preset.id)))return {prefix,bodyPreset:preset.id};
 }
 return null;
}
export function somaSkeletonPrefix(groups:readonly SomaBindGroup[],expectedPrefix?:string):string|null {
 return somaSkeletonIdentity(groups,expectedPrefix)?.prefix??null;
}
