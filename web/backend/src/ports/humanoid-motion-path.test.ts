import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import type {StoredAsset,WorldTransform} from '@woohaa3/contracts';
import {validateHumanoidMotionPath} from './humanoid-motion-path.js';
const bytes=new Uint8Array(readFileSync(new URL('../../../contracts/src/canvas/soma-motion/fixtures/motion.npz',import.meta.url)));
const transform:WorldTransform={version:'shared-world-v1',position:{u:3,v:4,h:1},rotation:[0,0,Math.SQRT1_2,Math.SQRT1_2],scale:2};
const asset:StoredAsset={id:'motion',title:'motion',mediaKind:'motion',source:'generated',status:'ready',createdAt:'2026-01-01',metadata:{storageKey:'stable/motion',size:bytes.length,checksum:createHash('sha256').update(bytes).digest('hex'),motion:{frameCount:2}}};
const bounds={min:{u:-100,v:-100},max:{u:100,v:100}};
it('reads canvas-scoped stable bytes and projects every frame without mutating canonical transform',async()=>{
 let request:unknown;
 const result=await validateHumanoidMotionPath({canvasId:'canvas',asset,transform,bounds,readBytes:async input=>{request=input;return bytes;}});
 expect(request).toEqual({canvasId:'canvas',storageKey:'stable/motion',maxBytes:128*1024*1024});
 expect(result.path).toHaveLength(2);expect(result.path[0]).toEqual(transform.position);expect(result.endpoint).toEqual(result.path[1]);expect(transform.position).toEqual({u:3,v:4,h:1});
});
it('fails closed for tampered bytes, frame counts, and paths outside canonical director bounds',async()=>{
 const input={canvasId:'canvas',asset,transform,bounds,readBytes:async()=>bytes};
 await expect(validateHumanoidMotionPath({...input,readBytes:async()=>bytes.slice(1)})).rejects.toThrow('字节校验');
 await expect(validateHumanoidMotionPath({...input,asset:{...asset,metadata:{...asset.metadata,motion:{frameCount:3}}}})).rejects.toThrow('帧数');
 await expect(validateHumanoidMotionPath({...input,bounds:{min:{u:0,v:0},max:{u:1,v:1}}})).rejects.toThrow('超出导演区');
});

it('uses the stable bind ground anchor rather than the model origin for membership',async()=>{
 const centered={...transform,rotation:[0,0,0,1] as [number,number,number,number],scale:1,position:{u:0,v:0,h:0}};
 await expect(validateHumanoidMotionPath({canvasId:'canvas',asset,transform:centered,bounds:{min:{u:-1,v:-1},max:{u:1,v:1}},groundAnchorLocal:[2,0,0],readBytes:async()=>bytes})).rejects.toThrow('超出导演区');
});
