import { measurePhotocraft } from "../../performance/photocraft-performance.js";
/** 图片聚焦的瞬时源像素纹理，与规范文档和宿主剪贴板无关。 */
export type ImageFocusDetails={nodeId:string;width:number;height:number;tiles:readonly {x:number;y:number;width:number;height:number;pixels:Uint8Array}[];onUploadFailure?:()=>void};
type EncodedDetails={manifest:string;pixels:Uint8Array};
export function encodeFocusDetails(frame:ImageFocusDetails|null):EncodedDetails {
  return encode(frame);
}
function encode(frame:ImageFocusDetails|null,reference?:(tile:ImageFocusDetails["tiles"][number])=>{cacheId:number;reuse:boolean}):EncodedDetails {
  if(!frame)return {manifest:"",pixels:new Uint8Array()};
  if(!frame.nodeId || frame.nodeId.length>128 || ![frame.width,frame.height].every(v=>Number.isInteger(v)&&v>0&&v<=32768) || frame.tiles.length<1 || frame.tiles.length>64)throw new Error("无效的图片细节批次");
  let bytes=0;
  const payload:Uint8Array[]=[];
  const tiles=frame.tiles.map(t=>{
    if(![t.x,t.y,t.width,t.height].every(Number.isSafeInteger) || t.x<0 || t.y<0 || t.width<1 || t.height<1 || t.width>512 || t.height>512 || t.x+t.width>frame.width || t.y+t.height>frame.height || t.pixels.length!==t.width*t.height*4) throw new Error("无效的图片细节区域");
    const ref=reference?.(t);
    if(!ref?.reuse){bytes+=t.pixels.length;payload.push(t.pixels);}
    return {x:t.x,y:t.y,width:t.width,height:t.height,...ref};
  });
  const pixels=new Uint8Array(bytes);let offset=0;
  for(const data of payload){pixels.set(data,offset);offset+=data.length;}
  return {manifest:JSON.stringify({nodeId:frame.nodeId,width:frame.width,height:frame.height,tiles}),pixels};
}


/** 仅引用上次已被 WASM 接受的不可变像素；每个 runtime 独立持有。 */
export class FocusDetailEncoder {
  private previous:ImageFocusDetails|null=null;
  private readonly ids=new WeakMap<Uint8Array,number>();
  private nextId=0;
  reset():void {this.previous=null;}
  upload(frame:ImageFocusDetails|null,send:(manifest:string,pixels:Uint8Array)=>void):void {
    const previous=this.previous;
    const compatible=frame && previous && frame.nodeId===previous.nodeId && frame.width===previous.width && frame.height===previous.height;
    const encoded=measurePhotocraft("region.pack", () => encode(frame,tile=>{
      let cacheId=this.ids.get(tile.pixels);
      if(cacheId===undefined){cacheId=++this.nextId;if(cacheId>0xffffffff)throw new Error("图片细节纹理代次超限");this.ids.set(tile.pixels,cacheId);}
      const reuse=!!compatible && previous.tiles.some(old=>old.x===tile.x&&old.y===tile.y&&old.width===tile.width&&old.height===tile.height&&old.pixels===tile.pixels);
      return {cacheId,reuse};
    }));
    measurePhotocraft("region.texture-submit", () => send(encoded.manifest,encoded.pixels), encoded.pixels.byteLength);
    this.previous=frame;
  }
}
