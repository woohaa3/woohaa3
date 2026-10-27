import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function crc32(bytes) {
  let crc=0xffffffff;
  for(const byte of bytes) { crc^=byte;for(let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
  return (crc^0xffffffff)>>>0;
}
function chunk(type,data) {
  const body=Buffer.concat([Buffer.from(type),data]);const result=Buffer.alloc(data.length+12);
  result.writeUInt32BE(data.length);body.copy(result,4);result.writeUInt32BE(crc32(body),data.length+8);return result;
}
/** Deterministic RGBA checker/diagonal geometry, encoded as a real PNG. */
export function createPng({size=1024,seed=42}={}) {
  if(!Number.isSafeInteger(size)||size<128||size>1024||(size&(size-1))) throw new RangeError('PNG size must be a power of two from 128 through 1024');
  if(!Number.isSafeInteger(seed)||seed<0) throw new RangeError('PNG seed must be a nonnegative safe integer');
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size,0);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=6;
  const stride=1+size*4;const raw=Buffer.alloc(stride*size);const tile=size/8;
  for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
    const offset=y*stride+1+x*4;const checker=(Math.floor(x/tile)+Math.floor(y/tile))%2;
    const diagonal=Math.abs(x-y)<size/16;
    raw[offset]=(seed*37+checker*101+(diagonal?90:0))%256;
    raw[offset+1]=(seed*73+Math.floor(x/tile)*19+40)%256;
    raw[offset+2]=(seed*17+Math.floor(y/tile)*23+(diagonal?120:0))%256;raw[offset+3]=255;
  }
  // Encode the full seed in a few pixels so seeds separated by 256 remain distinct.
  let seedValue=BigInt(seed);for(let i=0;i<7;i++){raw[1+i*4]=Number(seedValue&255n);seedValue>>=8n;}
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);
}
/** Returns an independent fixture; upload bytes are Buffers or verified byte counts. */
export function attachImageAssets(fixture,uploads,{shared=true}={}) {
  const workingCount=2*fixture.manifest.V;
  if(!Array.isArray(uploads)||uploads.length!==(shared?1:workingCount)) throw new RangeError(`Expected ${shared?1:workingCount} uploaded PNG assets`);
  const assets=uploads.map((upload,i)=>{
    const {storageKey,url,bytes,width,height}=upload;
    const checksum=Buffer.isBuffer(bytes)?sha256(bytes):/^sha256-([a-f0-9]{64})$/.exec(storageKey)?.[1];
    const size=Buffer.isBuffer(bytes)?bytes.length:bytes;
    if(typeof storageKey!=='string'||!storageKey||typeof url!=='string'||!url||!checksum||!Number.isSafeInteger(size)||size<1||!Number.isSafeInteger(width)||width<1||!Number.isSafeInteger(height)||height<1) throw new TypeError('Upload needs storageKey, url, bytes, width and height; numeric bytes require a SHA256 storage key');
    return {id:`asset-${i}`,title:`Benchmark image ${i}`,mediaKind:'image',source:'uploaded',status:'ready',url,createdAt:'2026-01-01T00:00:00.000Z',metadata:{storageKey,checksum,contentType:'image/png',size,width,height}};
  });
  const result=structuredClone(fixture);result.canvas.assets=assets;
  for(let i=0;i<workingCount;i++) {
    const node=result.canvas.document.nodes[i];node.type='image';
    result.canvas.nodeData[node.id]={...result.canvas.nodeData[node.id],outputAssetId:assets[shared?0:i].id,taskStatus:'successed'};
  }
  result.manifest.kind=shared?'image-shared':'image-unique';
  result.manifest.mediaSupport='uploaded PNG assets';result.manifest.hash=sha256(JSON.stringify(result.canvas));
  return result;
}
