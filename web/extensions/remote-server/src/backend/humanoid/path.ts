import { createHash } from 'node:crypto';
import { decodeSomaRootPositions, somaBodyRootScale, type SomaBodyPresetId, projectSomaRootTranslation, type StoredAsset, type WorldTransform, type WorldPoint } from '@woohaa3/contracts';

export type HumanoidMotionPathInput = {
  bodyPreset?: SomaBodyPresetId;
  canvasId: string;
  asset: StoredAsset;
  transform: WorldTransform;
  groundAnchorLocal?: [number,number,number];
  bounds: {min:{u:number;v:number};max:{u:number;v:number}};
  readBytes(input:{canvasId:string;storageKey:string;maxBytes:number}):Promise<Uint8Array>;
};
/** Stable bytes and the canonical actor transform own this check. Segments are linear and bounds convex. */
export async function validateHumanoidMotionPath(input:HumanoidMotionPathInput):Promise<{frameCount:number;path:WorldPoint[];endpoint:WorldPoint}> {
  const {asset,transform,bounds}=input, metadata=asset.metadata;
  const maxBytes=128*1024*1024;
  if(asset.mediaKind!=='motion'||asset.status!=='ready'||!metadata||typeof metadata.storageKey!=='string'||typeof metadata.checksum!=='string'||!/^[a-f0-9]{64}$/i.test(metadata.checksum)||typeof metadata.size!=='number'||!Number.isInteger(metadata.size)||metadata.size<=0||metadata.size>maxBytes)throw new Error('动作路径缺少稳定资产身份');
  if(!bounds||![bounds.min.u,bounds.min.v,bounds.max.u,bounds.max.v].every(Number.isFinite)||bounds.min.u>bounds.max.u||bounds.min.v>bounds.max.v)throw new Error('动作路径缺少有效导演区范围');
  const bytes=await input.readBytes({canvasId:input.canvasId,storageKey:metadata.storageKey,maxBytes});
  if(bytes.byteLength!==metadata.size||createHash('sha256').update(bytes).digest('hex')!==metadata.checksum.toLowerCase())throw new Error('动作路径资产字节校验失败');
  const roots=await decodeSomaRootPositions(bytes),frameCount=roots.length/3;
  const motion=metadata.motion as {frameCount?:unknown}|undefined;
  if(!motion||motion.frameCount!==frameCount)throw new Error('动作路径帧数与稳定资产不符');
  const path:WorldPoint[]=[];
  const rootScale=input.bodyPreset?somaBodyRootScale(input.bodyPreset):1;
  for(let frame=0;frame<frameCount;frame++){
    const point=projectSomaRootTranslation([(roots[frame*3]!-roots[0]!)*rootScale,0,(roots[frame*3+2]!-roots[2]!)*rootScale],transform.rotation,transform.scale,transform.position);
    const anchor=input.groundAnchorLocal??[0,0,0];
    const membership=projectSomaRootTranslation(anchor,transform.rotation,transform.scale,point);
    if(![membership.u,membership.v,membership.h].every(Number.isFinite)||membership.u<bounds.min.u||membership.u>bounds.max.u||membership.v<bounds.min.v||membership.v>bounds.max.v)throw new Error(`动作路径超出导演区范围（帧 ${frame}）`);
    path.push(point);
  }
  return {frameCount,path,endpoint:path[path.length-1]!};
}
