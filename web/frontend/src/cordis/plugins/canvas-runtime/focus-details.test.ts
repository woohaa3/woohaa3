import {expect,it} from "vitest";
import {encodeFocusDetails,FocusDetailEncoder} from "./focus-details.js";
it("细节批次携带文档坐标、源尺寸和有界字节，清理无像素载荷",()=>{
  const encoded=encodeFocusDetails({nodeId:"image",width:4096,height:3000,tiles:[{x:1024,y:512,width:1,height:1,pixels:new Uint8Array([1,2,3,4])},{x:1025,y:512,width:1,height:1,pixels:new Uint8Array([5,6,7,8])}]});
  expect(JSON.parse(encoded.manifest)).toMatchObject({nodeId:"image",width:4096,tiles:[{x:1024,y:512,width:1,height:1},{x:1025,y:512,width:1,height:1}]});
  expect([...encoded.pixels]).toEqual([1,2,3,4,5,6,7,8]);
  expect(encodeFocusDetails(null)).toEqual({manifest:"",pixels:new Uint8Array()});
});
it("超限和非法区域在拼接前拒绝",()=>{
  const frame={nodeId:"image",width:4096,height:3000,tiles:[{x:0,y:0,width:1,height:1,pixels:new Uint8Array(4)}]};
  for(const patch of [{width:0},{height:32769},{tiles:[]},{tiles:Array(65).fill(frame.tiles[0])},{tiles:[{...frame.tiles[0],x:-1}]},{tiles:[{...frame.tiles[0],width:513}]},{tiles:[{...frame.tiles[0],pixels:new Uint8Array()}]}]) expect(()=>encodeFocusDetails({...frame,...patch})).toThrow();
});

it("增量只传变化块，失败不推进引用，清理/重建与目标变化重传",()=>{
  const encoder=new FocusDetailEncoder();
  const a={x:0,y:0,width:1,height:1,pixels:new Uint8Array([1,2,3,4])};
  const b={...a,x:1,pixels:new Uint8Array([5,6,7,8])};
  const frame={nodeId:"image",width:4096,height:3000,tiles:[a,b]};
  const calls:{tiles:{reuse:boolean;cacheId:number}[];pixels:number[]}[]=[];
  const send=(manifest:string,pixels:Uint8Array)=>{if(manifest)calls.push({tiles:JSON.parse(manifest).tiles,pixels:[...pixels]});};
  encoder.upload(frame,send);expect(calls.at(-1)?.pixels).toHaveLength(8);
  const changed={...frame,tiles:[a,{...b,pixels:new Uint8Array([9,10,11,12])}]};
  encoder.upload(changed,send);
  expect(calls.at(-1)?.tiles.map(t=>t.reuse)).toEqual([true,false]);
  expect(calls.at(-1)?.pixels).toEqual([9,10,11,12]);
  expect(calls.at(-1)?.tiles[0].cacheId).toBe(calls[0].tiles[0].cacheId);
  expect(()=>encoder.upload(frame,()=>{throw new Error("rejected");})).toThrow("rejected");
  encoder.upload(frame,send);expect(calls.at(-1)?.tiles.map(t=>t.reuse)).toEqual([true,false]);
  encoder.upload(frame,send);expect(calls.at(-1)?.pixels).toEqual([]);
  encoder.upload(null,send);encoder.upload(frame,send);expect(calls.at(-1)?.pixels).toHaveLength(8);
  encoder.reset();encoder.upload(frame,send);expect(calls.at(-1)?.pixels).toHaveLength(8);
  encoder.upload({...frame,nodeId:"other"},send);expect(calls.at(-1)?.pixels).toHaveLength(8);
  encoder.upload({...frame,width:5000},send);expect(calls.at(-1)?.pixels).toHaveLength(8);
  encoder.upload({...frame,width:5000,tiles:[{...a,x:2},b]},send);
  expect(calls.at(-1)?.tiles.map(t=>t.reuse)).toEqual([false,true]);
});
