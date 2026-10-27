import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { createPng,attachImageAssets } from './media.mjs';
import { generateFixture } from './fixture.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
function crc32(b){let c=0xffffffff;for(const v of b){c^=v;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
test('PNG bytes contain real deterministic geometry and valid chunks',()=>{
 const png=createPng({size:256,seed:42});
 assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 assert.equal(hash(png),hash(createPng({size:256,seed:42})));
 assert.notEqual(hash(png),hash(createPng({size:256,seed:43})));
 const chunks=[];for(let offset=8;offset<png.length;){const n=png.readUInt32BE(offset);const body=png.subarray(offset+4,offset+8+n);assert.equal(png.readUInt32BE(offset+8+n),crc32(body));chunks.push({type:body.subarray(0,4).toString(),data:body.subarray(4)});offset+=12+n;}
 assert.equal(chunks[0].type,'IHDR');assert.equal(chunks[0].data.readUInt32BE(0),256);assert.equal(chunks[0].data.readUInt32BE(4),256);
 const pixels=inflateSync(Buffer.concat(chunks.filter(c=>c.type==='IDAT').map(c=>c.data)));
 assert.equal(pixels.length,256*(1+256*4));assert.ok(new Set(pixels).size>10);
 assert.equal(createPng().readUInt32BE(16),1024);
 for(const size of [0,64,129,2048,NaN]) assert.throws(()=>createPng({size}));
});
const upload=(seed=42)=>{const bytes=createPng({size:128,seed});return {storageKey:`sha256-${hash(bytes)}`,url:'/api/media/test',bytes,width:128,height:128};};
test('shared images resolve one real asset while offscreen remainder stays text',()=>{
 const f=attachImageAssets(generateFixture(),[upload()]);
 assert.equal(f.canvas.assets.length,1);assert.equal(f.canvas.assets[0].metadata.checksum,hash(upload().bytes));
 assert.equal(f.canvas.assets[0].metadata.size,upload().bytes.length);
 assert.equal(f.canvas.assets[0].source,'uploaded');assert.equal(f.canvas.assets[0].status,'ready');
 assert.equal(f.canvas.document.nodes[47].type,'image');assert.equal(f.canvas.document.nodes[48].type,'text');
 assert.equal(f.canvas.nodeData[f.targets.distant[0]].outputAssetId,'asset-0');assert.equal(f.canvas.nodeData[f.targets.origin[0]].taskStatus,'successed');
 assert.equal(f.manifest.kind,'image-shared');assert.equal(f.manifest.hash,hash(JSON.stringify(f.canvas)));
});
test('unique images map each working-set node to its own verified upload',()=>{
 const uploads=Array.from({length:4},(_,i)=>upload(i));
 const f=attachImageAssets(generateFixture({nodes:10,visible:2}),uploads,{shared:false});
 assert.equal(f.canvas.assets.length,4);assert.equal(f.canvas.nodeData[f.targets.distant[1]].outputAssetId,'asset-3');assert.equal(f.manifest.kind,'image-unique');
 assert.throws(()=>attachImageAssets(generateFixture(),[],{}));
 assert.throws(()=>attachImageAssets(generateFixture(),[upload()],{shared:false}));
 assert.throws(()=>attachImageAssets(generateFixture(),[{...upload(),storageKey:'invalid',bytes:20}]));
});
