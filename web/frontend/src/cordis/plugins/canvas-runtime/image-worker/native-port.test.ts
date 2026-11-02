import { afterEach, expect, it, vi } from 'vitest';
import { prepareImageResource } from './client.js';
import { registerNativeImagePort, releaseImagePixels, type NativeImagePort } from './native-port.js';
import type { PreparedImageResource } from '@woohaa3/contracts';
let unregister:(()=>void)|undefined;
afterEach(()=>{unregister?.();vi.unstubAllGlobals();});
function setup() {
  let finish!:(result:PreparedImageResource)=>void;
  const prepare=vi.fn(()=>new Promise<PreparedImageResource>(r=>{finish=r;}));
  const port:NativeImagePort={prepare,apply:vi.fn(),release:vi.fn()};
  const pixels={kind:'native-image' as const,handle:'lease-1',generation:1,width:1,height:1};
  unregister=registerNativeImagePort(port);
  return {port,finish:()=>finish({width:1,height:1,sourceWidth:1,sourceHeight:1,pixels})};
}
it('coalesces executing sources and releases native resources after the last consumer',async()=>{
 const {port,finish}=setup();const a=prepareImageResource('/media/same?canvas=a',128),b=prepareImageResource('/media/same?canvas=a',128);
 expect(port.prepare).toHaveBeenCalledTimes(1);finish();const [x,y]=await Promise.all([a,b]);
 expect(x.pixels).toBe(y.pixels);releaseImagePixels(x.pixels);expect(port.release).not.toHaveBeenCalled();
 releaseImagePixels(y.pixels);releaseImagePixels(y.pixels);expect(port.release).toHaveBeenCalledTimes(1);
});
it('cancelling one consumer keeps a shared job alive for another',async()=>{
 const {port,finish}=setup(),abort=new AbortController();
 const a=prepareImageResource('/media/same?canvas=a',128,abort.signal).catch(e=>e.message),b=prepareImageResource('/media/same?canvas=a',128);
 abort.abort();const signal=vi.mocked(port.prepare).mock.calls[0][2]!;expect(signal.aborted).toBe(false);
 finish();expect(await a).toBe('image-cancelled');const result=await b;expect(port.release).not.toHaveBeenCalled();releaseImagePixels(result.pixels);expect(port.release).toHaveBeenCalledOnce();
});
it('does not share leases across canvas-authorisation scopes',async()=>{
 const port:NativeImagePort={prepare:vi.fn(async (url:string):Promise<PreparedImageResource>=>({width:1,height:1,sourceWidth:1,sourceHeight:1,pixels:{kind:'native-image',handle:url,generation:1,width:1,height:1}})),apply:vi.fn(),release:vi.fn()};
 unregister=registerNativeImagePort(port);
 const [a,b]=await Promise.all([prepareImageResource('/media/same?canvas=a',128),prepareImageResource('/media/same?canvas=b',128)]);
 expect(port.prepare).toHaveBeenCalledTimes(2);
 releaseImagePixels(a.pixels);releaseImagePixels(b.pixels);expect(port.release).toHaveBeenCalledTimes(2);
});
