import { supportsImageThreads, loadThreadedImageModule } from "./threaded.js";
import init, { prepare_image } from '../../../../media-image-wasm/media_image.js';
import {
  IMAGE_INPUT_LIMIT,
  IMAGE_WORKER_VERSION,
  type ImageFetchJob,
  type ImageFetchReply,
  type ImageJob,
  type ImageReply
} from './protocol.js';

const MAX_SOURCE_PIXELS = 8192 * 8192;
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<ImageJob | ImageFetchJob | { cancel: number } | { cancelFetch: number }>) => void;
  postMessage: (message: ImageReply | ImageFetchReply, transfer?: Transferable[]) => void;
};
let wasm: { memory: WebAssembly.Memory } | undefined;
let prepare = prepare_image;
let mode: "single" | "threaded" = "single";
let active: { id: number; controller: AbortController } | undefined;
const activeFetches = new Map<number, AbortController>();
let scratchCanvas: OffscreenCanvas | undefined;
let scratchCtx: OffscreenCanvasRenderingContext2D | null | undefined;

class FetchFailure extends Error { constructor(message: string, readonly transient: boolean) { super(message); } }

async function read(url: string, signal: AbortSignal): Promise<Uint8Array> {
  let response: Response;
  try { response = await fetch(url, { credentials: 'same-origin', signal }); }
  catch (error) { throw new FetchFailure(error instanceof Error ? error.message : '网络读取失败', true); }
  if (!response.ok) throw new FetchFailure(`图片读取失败（HTTP ${response.status}）`, [408,425,429,500,502,503,504].includes(response.status));
  const declared = Number(response.headers.get('content-length'));
  if (declared > IMAGE_INPUT_LIMIT) { await response.body?.cancel(); throw new FetchFailure('compressed-limit', false); }
  if (declared > 0 && declared <= IMAGE_INPUT_LIMIT && typeof response.arrayBuffer === 'function') {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) throw new FetchFailure('empty-image', false);
    if (buffer.byteLength > IMAGE_INPUT_LIMIT) throw new FetchFailure('compressed-limit', false);
    return new Uint8Array(buffer);
  }
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
  if (length === 0) throw new FetchFailure('empty-image', false);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/**
 * Browser-native hardware decode & downscale for <= 512px thumbnails.
 * Falls back to Rust WASM (`prepare_image`) on unsupported formats or source limit violations.
 */
async function decodeNativeThumbnail(bytes: Uint8Array, maxEdge: number): Promise<{
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  pixels: Uint8Array;
} | null> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
  let bitmap: ImageBitmap | undefined;
  try {
    const blob = new Blob([bytes as Uint8Array<ArrayBuffer>]);
    bitmap = await createImageBitmap(blob);
    const sourceWidth = bitmap.width;
    const sourceHeight = bitmap.height;
    if (sourceWidth < 1 || sourceHeight < 1) return null;
    if (sourceWidth * sourceHeight > MAX_SOURCE_PIXELS) {
      throw new Error('source-pixel-limit');
    }
    const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    if (!scratchCanvas) {
      scratchCanvas = new OffscreenCanvas(width, height);
      scratchCtx = scratchCanvas.getContext('2d', { willReadFrequently: true });
    } else {
      if (scratchCanvas.width !== width) scratchCanvas.width = width;
      if (scratchCanvas.height !== height) scratchCanvas.height = height;
    }
    if (!scratchCtx) return null;
    scratchCtx.clearRect(0, 0, width, height);
    scratchCtx.drawImage(bitmap, 0, 0, width, height);
    const data = scratchCtx.getImageData(0, 0, width, height).data;
    return {
      width,
      height,
      sourceWidth,
      sourceHeight,
      pixels: new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    };
  } catch (error) {
    if (error instanceof Error && error.message === 'source-pixel-limit') throw error;
    return null;
  } finally {
    bitmap?.close();
  }
}

scope.onmessage = (event) => {
  const data = event.data;
  if ('cancelFetch' in data) {
    const controller = activeFetches.get(data.cancelFetch);
    if (controller) {
      activeFetches.delete(data.cancelFetch);
      controller.abort();
    }
    return;
  }
  if ('fetchId' in data) {
    const controller = new AbortController();
    activeFetches.set(data.fetchId, controller);
    void (async () => {
      try {
        if (data.version !== IMAGE_WORKER_VERSION) throw new Error('image-protocol-version');
        const url = new URL(data.url, self.location.href);
        if (!['http:', 'https:', 'blob:', 'data:'].includes(url.protocol) || (url.protocol !== 'data:' && url.origin !== self.location.origin)) {
          throw new Error('unauthorised-image-origin');
        }
        const bytes = await read(url.href, controller.signal);
        const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? (bytes.buffer as ArrayBuffer)
          : bytes.slice().buffer;
        scope.postMessage({ version: 2, fetchId: data.fetchId, ok: true, bytes: buffer }, [buffer]);
      } catch (error) {
        scope.postMessage({
          version: 2,
          fetchId: data.fetchId,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          transient: error instanceof FetchFailure && error.transient
        });
      } finally {
        activeFetches.delete(data.fetchId);
      }
    })();
    return;
  }
  if ('cancel' in data) { if (active?.id === data.cancel) active.controller.abort(); return; }
  const job = data;
  if (active) return;
  const controller = new AbortController();
  active = { id: job.id, controller };
  void (async () => {
    try {
      if (job.version !== IMAGE_WORKER_VERSION) throw new Error('image-protocol-version');
      const url = new URL(job.url, self.location.href);
      if (!['http:', 'https:', 'blob:', 'data:'].includes(url.protocol) || (url.protocol !== 'data:' && url.origin !== self.location.origin)) throw new Error('unauthorised-image-origin');
      const bytes = job.bytes ? new Uint8Array(job.bytes) : await read(url.href, controller.signal);
      if (bytes.byteLength > IMAGE_INPUT_LIMIT) throw new FetchFailure('compressed-limit', false);
      if (controller.signal.aborted) throw new Error('image-cancelled');
      if (job.maxEdge <= 512 && !job.encoded && !job.region && !job.allowThreads) {
        const fast = await decodeNativeThumbnail(bytes, job.maxEdge);
        if (controller.signal.aborted) throw new Error('image-cancelled');
        if (fast) {
          const result = {
            width: fast.width,
            height: fast.height,
            sourceWidth: fast.sourceWidth,
            sourceHeight: fast.sourceHeight,
            pixels: fast.pixels,
            memoryBytes: wasm?.memory.buffer.byteLength ?? 0,
            mode,
            computeThreads: 0
          };
          scope.postMessage(
            { version: 2, id: job.id, generation: job.generation, ok: true, result },
            [fast.pixels.buffer as ArrayBuffer]
          );
          return;
        }
      }
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
