import {createHash} from 'node:crypto';
import {composeSomaWalkingWave,decodeSomaRootPositions,isSomaMotionMetadata,type BackendMediaPort,type StoredAsset} from '@woohaa3/contracts';
const MAX_BYTES=128*1024*1024;
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
/** Materialize one derived NPZ; canonical canvas registration belongs to the caller's transaction. */
export async function composeHumanoidMotionAsset(media:BackendMediaPort,canvasId:string,walkAsset:StoredAsset,waveAsset:StoredAsset){
 const resources=media.resources;
 if(!resources)throw new Error('动作合成缺少稳定资源读写端口');
 async function read(asset:StoredAsset){
  const meta=asset.metadata;
  if(asset.mediaKind!=='motion'||asset.status!=='ready'||!meta||typeof meta.storageKey!=='string'||!meta.storageKey.trim()||meta.contentType!=='application/x-npz'||typeof meta.checksum!=='string'||!/^([a-f0-9]{64})$/.test(meta.checksum)||typeof meta.size!=='number'||!Number.isInteger(meta.size)||meta.size<=0||meta.size>MAX_BYTES||!isSomaMotionMetadata(meta.motion))throw new Error('动作合成缺少有效的稳定资产身份');
  const result=await resources!.read(meta.storageKey,canvasId);
  if(result.contentType!=='application/x-npz'||result.bytes.length!==meta.size||sha(result.bytes)!==meta.checksum)throw new Error('动作合成源资产字节校验失败');
  const roots=await decodeSomaRootPositions(result.bytes);
  if(roots.length/3!==meta.motion.frameCount)throw new Error('动作合成源资产帧数不符');
  return {bytes:result.bytes,motion:meta.motion};
 }
 const walk=await read(walkAsset),wave=await read(waveAsset);
 if(walk.motion.fps!==wave.motion.fps)throw new Error('动作合成源资产采样率不一致');
 const output=await composeSomaWalkingWave(walk.bytes,wave.bytes,walk.motion.fps);
 if(output.bytes.length===0||output.bytes.length>MAX_BYTES||output.fps!==walk.motion.fps||output.frameCount!==walk.motion.frameCount)throw new Error('动作合成产物超出范围或帧身份不符');
 const checksum=sha(output.bytes),assetId=`soma-motion-${checksum}`;
 const stored=await resources.write({bytes:output.bytes,contentType:'application/x-npz',canvasId});
 if(!stored.storageKey?.trim()||stored.contentType!=='application/x-npz'||stored.size!==output.bytes.length||stored.checksum!==checksum)throw new Error('动作合成产物落盘校验失败');
 const composition={walkingAssetId:walkAsset.id,waveAssetId:waveAsset.id,walkDistance:output.walkDistance,raisedWindow:output.raisedWindow};
 const asset:StoredAsset={id:assetId,title:'行走挥手动作',mediaKind:'motion',source:'generated',status:'ready',createdAt:walkAsset.createdAt,durationSeconds:output.frameCount/output.fps,metadata:{storageKey:stored.storageKey,checksum,contentType:stored.contentType,size:stored.size,fps:output.fps,motion:{formatVersion:'kimodo-soma-v1',skeletonId:'somaskel77',restPoseId:'kimodo-standard-tpose',jointCount:77,fps:output.fps,frameCount:output.frameCount},composition}};
 return {assetId,checksum,asset,fps:output.fps,frameCount:output.frameCount,composition};
}
