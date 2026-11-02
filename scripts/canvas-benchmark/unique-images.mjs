#!/usr/bin/env node
/** Create a scene package of actual, distinct image nodes for development validation. */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { encodeScenePackage, finalizeScenePackageManifest } from '../../web/backend/src/scene-package/archive.ts';
function chunk(type,data) {
  const body=Buffer.concat([Buffer.from(type),data]); let crc=0xffffffff;
  for(const byte of body) { crc^=byte; for(let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
  const out=Buffer.alloc(data.length+12); out.writeUInt32BE(data.length); body.copy(out,4); out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4); return out;
}
export function uniquePng(seed) {
  const size=128, stride=1+size*4, raw=Buffer.alloc(size*stride);
  let state=(seed+1)>>>0;
  const next=()=>{ state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0; };
  const bg=[next()%200+30,next()%200+30,next()%200+30];
  for(let y=0;y<size;y++) for(let x=0;x<size;x++) { const p=y*stride+1+x*4;raw[p]=bg[0];raw[p+1]=bg[1];raw[p+2]=bg[2];raw[p+3]=255; }
  for(let shape=0;shape<18;shape++) {
    const x=next()%110,y=next()%110,w=next()%45+8,h=next()%45+8,color=[next()%256,next()%256,next()%256];
    for(let dy=y;dy<Math.min(size,y+h);dy++) for(let dx=x;dx<Math.min(size,x+w);dx++) {
      if(shape%2 && ((dx-x-w/2)**2/(w*w)+(dy-y-h/2)**2/(h*h)>.25)) continue;
      const p=dy*stride+1+dx*4;raw[p]=color[0];raw[p+1]=color[1];raw[p+2]=color[2];
    }
  }
  // Full 32-bit source ID in the first row guarantees unique pixels as well as varied geometry.
  for(let b=0;b<4;b++) raw[1+b*4]=(seed>>>(8*b))&255;
  const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
export function uniqueImageScene(count=3000) {
  if(!Number.isSafeInteger(count)||count<1||count>3000) throw new RangeError('Image count must be 1–3000');
  const timestamp=new Date().toISOString(),nodes=[],nodeData={},assets=[],media=new Map(),entries=[],hashes=new Set();
  for(let i=0;i<count;i++) {
    const id=`unique-image-${String(i+1).padStart(4,'0')}`,assetId=`asset-${i+1}`,bytes=uniquePng(i),sha256=createHash('sha256').update(bytes).digest('hex');
    if(hashes.has(sha256)) throw new Error('Duplicate image content'); hashes.add(sha256);
    nodes.push({id,type:'image',position:{x:(i%60)*200,y:Math.floor(i/60)*185},width:180,height:160});
    nodeData[id]={title:`图片 ${String(i+1).padStart(4,'0')}`,outputAssetId:assetId};
    assets.push({id:assetId,nodeId:id,title:nodeData[id].title,mediaKind:'image',source:'uploaded',status:'ready',url:`scene-media:${assetId}`,createdAt:timestamp,metadata:{width:128,height:128}});
    entries.push({assetId,path:`media/${sha256}.png`,sha256,size:bytes.length,mimeType:'image/png'});media.set(assetId,bytes);
  }
  const canvas={id:'rust-worker-unique-images',title:`Rust 图片 Worker · ${count} 张不同图片`,revision:0,document:{schemaVersion:'asset-canvas-v1',nodes,edges:[],updatedAt:timestamp},nodeData,assets,jobs:[],updatedAt:timestamp};
  const ids=nodes.map(n=>n.id),manifest={format:'woohaa-scene',version:1,datasetId:`rust-worker-${count}-unique-images-v1`,contentHash:'',recipeVersion:1,kind:'image',title:canvas.title,views:{overview200:ids.slice(0,200),overview300:ids.slice(0,300),distant:ids.slice(-200)},media:entries};
  return {manifest:finalizeScenePackageManifest(manifest,canvas),canvas,media};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const output=process.argv[2]; if(!output) throw new Error('Output .woohaa-scene path required');
  const scene=uniqueImageScene(); writeFileSync(output,encodeScenePackage(scene));
  console.log(JSON.stringify({output,nodes:scene.canvas.document.nodes.length,uniqueImages:scene.media.size}));
}
