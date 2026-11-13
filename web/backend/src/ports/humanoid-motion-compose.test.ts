import {createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import type {BackendMediaPort,StoredAsset} from '@woohaa3/contracts';
const codec=vi.hoisted(()=>({compose:vi.fn(),roots:vi.fn()}));
vi.mock('@woohaa3/contracts',async original=>({...await original<object>(),composeSomaWalkingWave:codec.compose,decodeSomaRootPositions:codec.roots}));
import {composeHumanoidMotionAsset} from './humanoid-motion-compose.js';
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function fixture(){
 const walk=new Uint8Array([1,2]),wave=new Uint8Array([3,4]),output=new Uint8Array([5,6]);
 const asset=(id:string,bytes:Uint8Array):StoredAsset=>({id,title:id,mediaKind:'motion',source:'generated',status:'ready',createdAt:'2026-01-02',metadata:{storageKey:id,contentType:'application/x-npz',size:bytes.length,checksum:sha(bytes),motion:{formatVersion:'kimodo-soma-v1',skeletonId:'somaskel77',restPoseId:'kimodo-standard-tpose',fps:30,frameCount:300}}});
 const read=vi.fn(async(key:string)=>({bytes:key==='walk'?walk:wave,contentType:'application/x-npz'}));
 const write=vi.fn(async()=>({storageKey:'derived',contentType:'application/x-npz',size:output.length,checksum:sha(output)}));
 const media={resources:{read,write}} as unknown as BackendMediaPort;
 codec.roots.mockReset().mockResolvedValue(new Float64Array(900));codec.compose.mockReset().mockResolvedValue({bytes:output,frameCount:300,fps:30,walkDistance:8,raisedWindow:{start:1,end:4}});
 return {media,read,write,walk:asset('walk',walk),wave:asset('wave',wave),output};
}
it('writes a single content-addressed NPZ with canvas-scoped provenance without modifying source assets',async()=>{
 const f=fixture(),before=JSON.stringify([f.walk,f.wave]),result=await composeHumanoidMotionAsset(f.media,'canvas',f.walk,f.wave);
 expect(f.read.mock.calls).toEqual([['walk','canvas'],['wave','canvas']]);expect(f.write).toHaveBeenCalledWith({bytes:f.output,contentType:'application/x-npz',canvasId:'canvas'});
 expect(result.assetId).toBe(`soma-motion-${sha(f.output)}`);expect(result.asset.createdAt).toBe(f.walk.createdAt);expect(result.composition).toMatchObject({walkingAssetId:'walk',waveAssetId:'wave',walkDistance:8});expect(result.asset.metadata?.motion).toMatchObject({jointCount:77,frameCount:300,fps:30});expect(JSON.stringify([f.walk,f.wave])).toBe(before);
});
it('rejects tampered bytes, metadata frame mismatches and sampling-rate mismatches before writing',async()=>{
 let f=fixture();f.walk.metadata!.checksum='0'.repeat(64);await expect(composeHumanoidMotionAsset(f.media,'canvas',f.walk,f.wave)).rejects.toThrow('字节校验');expect(f.write).not.toHaveBeenCalled();
 f=fixture();codec.roots.mockResolvedValue(new Float64Array(6));await expect(composeHumanoidMotionAsset(f.media,'canvas',f.walk,f.wave)).rejects.toThrow('帧数');expect(f.write).not.toHaveBeenCalled();
 f=fixture();(f.wave.metadata!.motion as {fps:number}).fps=24;await expect(composeHumanoidMotionAsset(f.media,'canvas',f.walk,f.wave)).rejects.toThrow('采样率');expect(f.write).not.toHaveBeenCalled();
});
it('fails closed when content-addressed storage returns inconsistent derived metadata',async()=>{
 const f=fixture();f.write.mockResolvedValue({storageKey:'derived',contentType:'application/x-npz',size:2,checksum:'0'.repeat(64)});await expect(composeHumanoidMotionAsset(f.media,'canvas',f.walk,f.wave)).rejects.toThrow('落盘校验');
});
