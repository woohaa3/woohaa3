import { readFileSync } from 'node:fs';
import {expect,it} from 'vitest';
import {decodeSomaPosedJoints} from '@woohaa3/contracts';
import {describeRaisedHandFrames,validateRaisedWavePrerequisite} from './humanoid-motion-gesture.js';
function poses(frames:number){return new Float64Array(frames*77*3);}
function raise(values:Float64Array,frame:number,joint:number,height=1){values[(frame*77+joint)*3+1]=height;}
// One stored ZIP member, using the real bounded NPY/ZIP decoder rather than a mock.
function archive(values:Float64Array,frames:number){
 const header=`{'descr': '<f4', 'fortran_order': False, 'shape': (${frames},77,3), }\n`;
 const npy=new Uint8Array(10+header.length+values.length*4),nv=new DataView(npy.buffer);
 npy.set([147,78,85,77,80,89,1,0]);nv.setUint16(8,header.length,true);npy.set(new TextEncoder().encode(header),10);
 values.forEach((value,i)=>nv.setFloat32(10+header.length+i*4,value,true));
 let crc=0xffffffff;for(const byte of npy){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
 const name=new TextEncoder().encode('posed_joints.npy'),centralAt=30+name.length+npy.length,endAt=centralAt+46+name.length;
 const zip=new Uint8Array(endAt+22),v=new DataView(zip.buffer);
 v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint32(14,crc,true);v.setUint32(18,npy.length,true);v.setUint32(22,npy.length,true);v.setUint16(26,name.length,true);zip.set(name,30);zip.set(npy,30+name.length);
 v.setUint32(centralAt,0x02014b50,true);v.setUint16(centralAt+6,20,true);v.setUint32(centralAt+16,crc,true);v.setUint32(centralAt+20,npy.length,true);v.setUint32(centralAt+24,npy.length,true);v.setUint16(centralAt+28,name.length,true);zip.set(name,centralAt+46);
 v.setUint32(endAt,0x06054b50,true);v.setUint16(endAt+8,1,true);v.setUint16(endAt+10,1,true);v.setUint32(endAt+12,46+name.length,true);v.setUint32(endAt+16,centralAt,true);return zip;
}
it('requires one same-side wrist strictly above its shoulder in at least ten percent of frames',async()=>{
 const values=poses(20);raise(values,0,14);raise(values,1,14);
 expect(describeRaisedHandFrames(values,20)).toMatchObject({leftRaisedFrames:2,rightRaisedFrames:0,leftRaisedFraction:.1});
 const result=await validateRaisedWavePrerequisite(archive(values,20),20);expect(result.leftRaisedFraction).toBe(.1);
 values.fill(0);raise(values,0,14);raise(values,1,42);
 await expect(validateRaisedWavePrerequisite(archive(values,20),20)).rejects.toThrow('生成动作没有满足挥手所需的抬手姿态');
 values.fill(0);raise(values,0,42);raise(values,1,42);expect((await validateRaisedWavePrerequisite(archive(values,20),20)).rightRaisedFrames).toBe(2);
});
it('compares the matching shoulder, rejects no raised hand and verifies frame identity',async()=>{
 const values=poses(10);raise(values,0,14);raise(values,0,12,2);
 expect(describeRaisedHandFrames(values,10).leftRaisedFrames).toBe(0);
 await expect(validateRaisedWavePrerequisite(archive(values,10),10)).rejects.toThrow('抬手姿态');
 await expect(validateRaisedWavePrerequisite(archive(values,10),9)).rejects.toThrow('帧数不符');
 const fixture=new Uint8Array(readFileSync(new URL('../../../contracts/src/canvas/soma-motion/fixtures/motion.npz',import.meta.url)));
 await expect(validateRaisedWavePrerequisite(fixture,2)).rejects.toThrow('shape/type');
});
it('retains bounded finite numeric decoding for official 77-joint arrays',async()=>{
 const values=poses(1);expect((await decodeSomaPosedJoints(archive(values,1))).length).toBe(231);
 values[0]=NaN;await expect(decodeSomaPosedJoints(archive(values,1))).rejects.toThrow('nonfinite');
});
