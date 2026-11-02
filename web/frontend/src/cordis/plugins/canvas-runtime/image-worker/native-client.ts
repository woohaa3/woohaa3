/** Authorised compressed registration. Native code never resolves WebView URLs or cookies. */
import type { NativeImagePort } from './native-port.js';
import type { PreparedImageResource } from '@woohaa3/contracts';
import { ImageLoadError } from '../image-load.js';
import { IMAGE_INPUT_LIMIT } from './protocol.js';
let nextGeneration = 0;

/** Read authorised compressed bytes on the page so the native decode pool never waits on RTT. */
async function readBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const source=new URL(url,location.href);
  if(!['http:','https:','blob:','data:'].includes(source.protocol) || (source.protocol!=='data:' && source.origin!==location.origin)) throw new Error('unauthorised-image-origin');
  let response: Response;
  try { response=await fetch(source,{credentials:'same-origin',...(signal?{signal}:{})}); }
  catch(error) { throw new ImageLoadError(error instanceof Error?error.message:'图片网络读取失败',true); }
  if(!response.ok)throw new ImageLoadError(`图片读取失败（HTTP ${response.status}）`,[408,425,429,500,502,503,504].includes(response.status));
  const reader=response.body?.getReader();
  if(!reader)throw new Error('empty-image');
  let length=0;const chunks:Uint8Array[]=[];
  try {for(;;) {const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>IMAGE_INPUT_LIMIT)throw new Error('compressed-limit');chunks.push(value);}}
  finally {await reader.cancel();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return bytes;
}

export function createNativeImagePort(request: (path: string, body?: Uint8Array) => unknown) {
  const generation=++nextGeneration, handles=new Set<string>(); let disposed=false;
  const call=(path: string,body?: Uint8Array): Record<string,unknown> => {
    const result=request(path,body) as { ok:boolean;value?:Record<string,unknown>;error?:string };
    if(!result.ok) throw new Error(result.error ?? 'Native image request failed');
    return result.value ?? {};
  };
  const release=(handle:string)=>{if(handles.delete(handle))call(`image-release?handle=${encodeURIComponent(handle)}`);};
  const port: NativeImagePort = {
    async prepare(url,edge,signal) {
      if(disposed || signal?.aborted) throw new Error('image-cancelled');
      // Register pre-read bytes: the read already happened under the page's fetch quota.
      return await prepareBytesImpl(await readBytes(url,signal),edge,signal);
    },
    prepareBytes(bytes,edge,signal) { return prepareBytesImpl(bytes,edge,signal); },
    apply(image,id,plane,content) {
      if(disposed || image.generation!==generation || !handles.has(image.handle))throw new Error('native-image-stale');
      call(`image-apply?${new URLSearchParams({handle:image.handle,id,plane:plane?'1':'0',content})}`);
    },
    release(image) {if(image.generation===generation)release(image.handle);}
  };
  /** Register bytes already read by the caller (used when the page owns the fetch quota). */
  async function prepareBytesImpl(bytes: Uint8Array, edge: number, signal?: AbortSignal): Promise<PreparedImageResource> {
    if(disposed || signal?.aborted) throw new Error('image-cancelled');
    const handle=String(call(`image-register?edge=${edge}`,bytes).handle);
    handles.add(handle);
    const deadline=performance.now()+60000;
    try {
      for(;;) {
        if(disposed || signal?.aborted)throw new Error('image-cancelled');
        const result=call(`image-poll?handle=${encodeURIComponent(handle)}`);
        if(result.status==='failed')throw new Error(String(result.error));
        if(result.status==='ready')return {width:Number(result.width),height:Number(result.height),sourceWidth:Number(result.sourceWidth),sourceHeight:Number(result.sourceHeight),
          pixels:{kind:'native-image' as const,handle,generation,width:Number(result.width),height:Number(result.height)}};
        if(performance.now()>deadline)throw new Error('native-image-timeout');
        await new Promise(resolve=>setTimeout(resolve,16));
      }
    } catch(error) {
      // Keep the page reservation until native confirms the cancelled job really ended.
      if(!disposed && handles.has(handle)) {
        const status=call(`image-release?handle=${encodeURIComponent(handle)}`);
        if(status.draining) {
          while(!disposed && call(`image-poll?handle=${encodeURIComponent(handle)}`).status==='draining')
            await new Promise(resolve=>setTimeout(resolve,16));
        }
      }
      release(handle);throw error;
    }
  }
  return { port, prepareBytes: prepareBytesImpl, dispose() { for(const handle of [...handles]) {try{release(handle);}catch{ /* Host may already be gone. */ }} disposed=true; } };
}
