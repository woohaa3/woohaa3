import {it,expect,vi} from 'vitest';
import {prepareHumanoidMotionAsset} from './humanoid-motion-asset.js';
const checksum='a'.repeat(64);
const result={mediaKind:'motion',storageKey:'generation-outputs/wave.npz',checksum,contentType:'application/x-npz',size:120,motion:{fps:30,frameCount:60,skeletonId:'somaskel77',restPoseId:'kimodo-standard-tpose',formatVersion:'kimodo-soma-v1'}} as const;
it('checks storage in canvas scope before making a stable canonical asset',async()=>{
 const verify=vi.fn(async()=>({exists:true,matches:true}));
 const a=await prepareHumanoidMotionAsset({verify} as any,'canvas',result,'2026-11-12T00:00:00Z');
 expect(verify).toHaveBeenCalledWith(result.storageKey,{contentType:result.contentType,size:120,checksum},{canvasId:'canvas'});
 expect(a.asset.metadata?.motion).toEqual(result.motion);expect(a.assetId).toBe(`soma-motion-${checksum}`);
});
it('rejects missing motion identity or unavailable bytes',async()=>{
 await expect(prepareHumanoidMotionAsset({} as any,'c',{...result,motion:undefined})).rejects.toThrow('稳定资产');
 await expect(prepareHumanoidMotionAsset({verify:async()=>({exists:true,matches:false})} as any,'c',result)).rejects.toThrow('校验失败');
});
