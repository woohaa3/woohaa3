import {expect,it} from "vitest";
import {OpenFileBatchQueue,sortOpenFiles} from "../src/open-file-batch.js";
it("filenames use natural ordering and equal names retain picker order",()=>{
 const a={name:"image2.png",id:1},b={name:"image2.png",id:2};expect(sortOpenFiles([{name:"image10.png"},b,{name:"image1.png"},a]).map(file=>file.name)).toEqual(["image1.png","image2.png","image2.png","image10.png"]);
 expect(sortOpenFiles([b,a])).toEqual([b,a]);
});
it("each file completes before the next; errors include filenames and do not stop the batch",async()=>{
 const queue=new OpenFileBatchQueue<{name:string}>(),calls:string[]=[];
 const result=await queue.enqueue([{name:"image10"},{name:"image2"},{name:"image1"}],async file=>{calls.push(file.name);if(file.name==="image1")throw new Error("损坏");return file.name==="image2"?"不支持":null;});
 expect(calls).toEqual(["image1","image2","image10"]);expect(result).toEqual({opened:1,errors:[{name:"image1",message:"损坏"},{name:"image2",message:"不支持"}],cancelled:false});
});
it("separate picker batches never interleave and disposal skips remaining reads",async()=>{
 const queue=new OpenFileBatchQueue<{name:string}>(),calls:string[]=[];let release!:()=>void;
 const first=queue.enqueue([{name:"a2"},{name:"a1"}],async file=>{calls.push(file.name);if(file.name==="a1")await new Promise<void>(resolve=>{release=resolve;});return null;});
 const second=queue.enqueue([{name:"b1"}],async file=>{calls.push(file.name);return null;});await Promise.resolve();expect(calls).toEqual(["a1"]);release();await Promise.all([first,second]);expect(calls).toEqual(["a1","a2","b1"]);
 let active=true;const result=await queue.enqueue([{name:"1"},{name:"2"}],async()=>{active=false;return null;},()=>active);expect(result).toEqual({opened:1,errors:[],cancelled:true});
});
