import { supportsImageThreads, loadThreadedImageModule } from "./threaded.js";
import init, { prepare_image } from '../../../../media-image-wasm/media_image.js';
import { IMAGE_INPUT_LIMIT, IMAGE_WORKER_VERSION, type ImageJob, type ImageReply } from './protocol.js';

// A single-thread WASM instance runs exclusively inside this Dedicated Worker.
// No Image, createImageBitmap, canvas or renderer is instantiated here.
//
// Network reading normally happens on the page: the job carries already-authorised
// compressed bytes so a Worker slot is never held while waiting on RTT. The fallback
// reader stays for the legacy ABI and for probes that pass a URL only.
const scope = globalThis as unknown as { onmessage: (event: MessageEvent<ImageJob | { cancel: number }>) => void; postMessage: (message: ImageReply, transfer?: Transferable[]) => void };
let wasm: { memory: WebAssembly.Memory } | undefined;
let prepare = prepare_image;
let mode: "single" | "threaded" = "single";
let active: { id: number; controller: AbortController } | undefined;
class FetchFailure extends Error { constructor(message: string, readonly transient: boolean) { super(message); } }
async function read(url: string, signal: AbortSignal): Promise<Uint8Array> {
  let response: Response;
  try { response = await fetch(url, { credentials: 'same-origin', signal }); }
  catch (error) { throw new FetchFailure(error instanceof Error ? error.message : '网络读取失败', true); }
  if (!response.ok) throw new FetchFailure(`图片读取失败（HTTP ${response.status}）`, [408,425,429,500,502,503,504].includes(response.status));
  const declared = Number(response.headers.get('content-length'));
  if (declared > IMAGE_INPUT_LIMIT) { await response.body?.cancel(); throw new FetchFailure('compressed-limit', false); }
  if (!response.body) throw new FetchFailure('empty-image', false);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > IMAGE_INPUT_LIMIT) throw new FetchFailure('compressed-limit', false);
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
scope.onmessage = (event) => {
  if ('cancel' in event.data) { if (active?.id === event.data.cancel) active.controller.abort(); return; }
  const job = event.data;
  if (active) return;
  const controller = new AbortController();
  active = { id: job.id, controller };
  void (async () => {
    try {
      if (job.version !== IMAGE_WORKER_VERSION) throw new Error('image-protocol-version');
      const url = new URL(job.url, self.location.href);
      if (!['http:', 'https:', 'blob:', 'data:'].includes(url.protocol) || (url.protocol !== 'data:' && url.origin !== self.location.origin)) throw new Error('unauthorised-image-origin');
      if (!wasm) {
        if (job.allowThreads && supportsImageThreads()) {
          try {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const threaded = await Promise.race([loadThreadedImageModule(), new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('thread-init-timeout')),5000);})]);
              wasm=threaded.wasm;prepare=threaded.prepare;mode='threaded';
            } finally { clearTimeout(timer); }
          } catch { throw new Error('image-thread-init-failed'); }
        } else wasm = await init();
      }
      const bytes = job.bytes ? new Uint8Array(job.bytes) : await read(url.href, controller.signal);
      if (bytes.byteLength > IMAGE_INPUT_LIMIT) throw new FetchFailure('compressed-limit', false);
      if (controller.signal.aborted) throw new Error('image-cancelled');
      const image = prepare(bytes, job.maxEdge);
      try {
        // wasm-bindgen copies linear memory into an owned transferable buffer.
        const pixels = job.encoded ? new Uint8Array(0) : job.region ? image.region(job.region.x,job.region.y,job.region.width,job.region.height) : image.pixels();
        const png = job.encoded ? image.png() : undefined;
        const result = { width: job.region?.width ?? image.width, height: job.region?.height ?? image.height, sourceWidth: image.source_width, sourceHeight: image.source_height,
          pixels, ...(png ? { png } : {}), memoryBytes: wasm.memory.buffer.byteLength, mode, computeThreads: mode === "threaded" ? 2 : 0 };
        scope.postMessage({ version: 2, id: job.id, generation: job.generation, ok: true, result },
          [pixels.buffer, ...(png ? [png.buffer] : [])] as ArrayBuffer[]);
      } finally { image.free(); }
    } catch (error) {
      scope.postMessage({ version: 2, id: job.id, generation: job.generation, ok: false,
        message: error instanceof Error ? error.message : String(error), transient: error instanceof FetchFailure && error.transient });
    } finally { active = undefined; }
  })();
};
