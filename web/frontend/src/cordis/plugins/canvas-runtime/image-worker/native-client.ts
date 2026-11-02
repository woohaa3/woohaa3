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
  const leaseWaiters=new Set<()=>void>();
  const wakeLeaseWaiters=()=>{const pending=[...leaseWaiters];leaseWaiters.clear();for(const wake of pending)wake();};
  const call=(path: string,body?: Uint8Array): Record<string,unknown> => {
    const result=request(path,body) as { ok:boolean;value?:Record<string,unknown>;error?:string };
    if(!result.ok) throw new Error(result.error ?? 'Native image request failed');
    return result.value ?? {};
  };
  const release=(handle:string)=>{if(!handles.delete(handle))return;try{call(`image-release?handle=${encodeURIComponent(handle)}`);}finally{wakeLeaseWaiters();}};
  /**
   * 等某个 lease 释放后再注册。
   *
   * `media-image` 的 16 个 lease 是背压上限而不是内容错误：上层按帧上传纹理，
   * 总览时解码完的图片会在上传队列里排队，超过上限的时间窗很常见。直接失败会把
   * 节点永久钉成「预览加载失败」，所以这里等释放；50ms 兜底覆盖别的 port 实例或
   * 宿主回收腾出 lease 的情况。
   */
  const waitForLease=(signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{
    if(disposed||signal?.aborted){reject(new Error('image-cancelled'));return;}
    let done=false,timer:ReturnType<typeof setTimeout>;
    const finish=(error?:Error)=>{
      if(done)return;
      done=true;clearTimeout(timer);leaseWaiters.delete(wake);signal?.removeEventListener('abort',onAbort);
      if(error)reject(error);else resolve();
    };
    const wake=()=>finish();
    const onAbort=()=>finish(new Error('image-cancelled'));
    timer=setTimeout(()=>finish(),50);
    leaseWaiters.add(wake);
    signal?.addEventListener('abort',onAbort,{once:true});
  });
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
  async function registerHandle(bytes: Uint8Array, edge: number, deadline: number, signal?: AbortSignal): Promise<string> {
    for(;;) {
      if(disposed || signal?.aborted) throw new Error('image-cancelled');
      try { return String(call(`image-register?edge=${edge}`,bytes).handle); }
      catch(error) {
        const code=error instanceof Error?error.message:String(error);
        if(code!=='native-image-lease-budget' && code!=='native-image-busy') throw error;
        if(performance.now()>=deadline) throw new ImageLoadError('native-image-timeout',true);
        await waitForLease(signal);
      }
    }
  }
  async function prepareBytesImpl(bytes: Uint8Array, edge: number, signal?: AbortSignal): Promise<PreparedImageResource> {
    if(disposed || signal?.aborted) throw new Error('image-cancelled');
    const deadline=performance.now()+60000;
    const handle=await registerHandle(bytes,edge,deadline,signal);
    handles.add(handle);
    try {
      for(;;) {
        if(disposed || signal?.aborted)throw new Error('image-cancelled');
        const result=call(`image-poll?handle=${encodeURIComponent(handle)}`);
        if(result.status==='failed')throw new Error(String(result.error));
        if(result.status==='ready')return {width:Number(result.width),height:Number(result.height),sourceWidth:Number(result.sourceWidth),sourceHeight:Number(result.sourceHeight),
          pixels:{kind:'native-image' as const,handle,generation,width:Number(result.width),height:Number(result.height)}};
        if(performance.now()>deadline)throw new ImageLoadError('native-image-timeout',true);
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
  return { port, prepareBytes: prepareBytesImpl, dispose() { disposed=true; for(const handle of [...handles]) {try{release(handle);}catch{ /* Host may already be gone. */ }} wakeLeaseWaiters(); } };
}
