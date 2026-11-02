/** Optional acceleration. Every gate must pass in the Dedicated Worker itself. */
export function supportsImageThreads(): boolean {
  return globalThis.isSecureContext && globalThis.crossOriginIsolated && typeof SharedArrayBuffer === 'function'
    && WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,5,4,1,3,1,1]));
}
type ThreadedModule = {
  default: () => Promise<{ memory: WebAssembly.Memory }>;
  initThreadPool: (threads: number) => Promise<void>;
  prepare_image: typeof import('../../../../media-image-wasm/media_image.js').prepare_image;
};
export async function loadThreadedImageModule() {
  const url = new URL(`${import.meta.env.BASE_URL}assets/media-image-threaded/media_image.js`, location.origin).href;
  const module = await import(/* @vite-ignore */ url) as ThreadedModule;
  const wasm = await module.default();
  // Exactly one coordinator + two compute Workers per page; never hardwareConcurrency per image.
  await module.initThreadPool(2);
  return { wasm, prepare: module.prepare_image };
}
