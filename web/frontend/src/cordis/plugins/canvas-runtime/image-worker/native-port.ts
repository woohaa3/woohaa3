import type { NativeImageResource, ImagePixelSource, PreparedImageResource } from '@woohaa3/contracts';
export type NativeImagePort = {
  prepare(url: string, edge: number, signal?: AbortSignal): Promise<PreparedImageResource>;
  /**
   * Register compressed bytes the page already read under its own transport quota.
   *
   * When present the page never lets the native side fetch: reads stay on one page-wide lane and
   * the native decode pool is only occupied once bytes are local. Ports without it keep `prepare`.
   */
  prepareBytes?(bytes: Uint8Array, edge: number, signal?: AbortSignal): Promise<PreparedImageResource>;
  apply(image: NativeImageResource, id: string, plane: boolean, content: string): void;
  release(image: NativeImageResource): void;
};
let port: NativeImagePort | undefined;
const references = new WeakMap<NativeImageResource,number>();
export function retainImagePixels(pixels: ImagePixelSource, count=1) { if(isNativeImage(pixels))references.set(pixels,(references.get(pixels)??0)+count); }
export function registerNativeImagePort(value: NativeImagePort) { port=value; return () => { if(port===value) port=undefined; }; }
export function nativeImagePort() { return port; }
export function isNativeImage(pixels: ImagePixelSource): pixels is NativeImageResource { return !(pixels instanceof Uint8Array); }
export function applyNativeImage(pixels: NativeImageResource, id: string, plane: boolean, content: string) {
  if (!port) throw new Error('Native image renderer unavailable');
  port.apply(pixels,id,plane,content);
}
export function releaseImagePixels(pixels?: ImagePixelSource) {
  if(!pixels || !isNativeImage(pixels))return;
  const count=references.get(pixels);
  if(count!==undefined && count>1) {references.set(pixels,count-1);return;}
  if(count===0)return;
  references.set(pixels,0);port?.release(pixels);
}
