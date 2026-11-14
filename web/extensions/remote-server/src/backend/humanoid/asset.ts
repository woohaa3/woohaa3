import { isSomaMotionMetadata, type BackendMediaPort, type StoredAsset, type TaskResultSummary } from '@woohaa3/contracts';
/** Register only materialized motion bytes already owned by this canvas' storage route. */
export async function prepareHumanoidMotionAsset(media:BackendMediaPort,canvasId:string,result:TaskResultSummary,createdAt=new Date().toISOString()):Promise<{assetId:string;checksum:string;asset:StoredAsset}> {
 if(result.mediaKind!=='motion'||result.contentType!=='application/x-npz'||!result.storageKey||!result.checksum||!/^([a-f0-9]{64})$/.test(result.checksum)||!Number.isFinite(result.size)||result.size!<=0||result.size!>128*1024*1024||!isSomaMotionMetadata(result.motion))throw new Error('动作没有完整且有效的稳定资产身份');
 const verified=await media.verify(result.storageKey,{contentType:result.contentType,size:result.size,checksum:result.checksum},{canvasId});
 if(!verified.exists||!verified.matches)throw new Error('动作资产尚未落盘或校验失败');
 const assetId=`soma-motion-${result.checksum}`;
 const asset:StoredAsset={id:assetId,title:'角色动作',mediaKind:'motion',source:'generated',status:'ready',createdAt,durationSeconds:result.motion.frameCount/result.motion.fps,metadata:{storageKey:result.storageKey,checksum:result.checksum,contentType:result.contentType,size:result.size,motion:{...result.motion},fps:result.motion.fps}};
 return {assetId,checksum:result.checksum,asset};
}
