import { nativeImagePort, retainImagePixels, releaseImagePixels } from "./native-port.js";
import {
  IMAGE_DECODE_RESERVATION_BYTES,
  IMAGE_FETCH_RESERVATION_BYTES
} from "@woohaa3/contracts";
import type { CanvasResourceCoordinator, ResidencyPurpose } from "../residency/index.js";
import { ImageLoadError } from '../image-load.js';
import { DEFAULT_RESIDENCY_POLICY } from '../residency/policy.js';
import { IMAGE_INPUT_LIMIT, IMAGE_WORKER_VERSION, type ImageJob, type ImageReply, type ImageResult } from './protocol.js';
const experimentalThreads = import.meta.env?.VITE_WOOHAA_IMAGE_THREADS === "1";
type Job = { request: ImageJob; resolve: (value: ImageResult) => void; reject: (error: unknown) => void; signal?: AbortSignal; cleanup: () => void };
type Slot = { worker: Worker; generation: number; job?: Job; timeout?: ReturnType<typeof setTimeout>; idle?: ReturnType<typeof setTimeout>; memoryBytes: number };

/** Page-wide executor. Residency owns admission; this cap also covers focus/JS consumers. */
export class ImageWorkerPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private sequence = 0;
  private generation = 0;
  private disposed = false;
  constructor(private readonly capacity = experimentalThreads ? 1 : DEFAULT_RESIDENCY_POLICY.imageDecodeMaxInstances,
    private readonly createWorker = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'woohaa-rust-image' })) {}
  /** Decode already-authorised compressed bytes. `bytes` is optional for the legacy URL-only ABI. */
  decode(url: string, maxEdge: number, signal?: AbortSignal, encoded = false, region?: ImageJob["region"], bytes?: ArrayBuffer): Promise<ImageResult> {
    if (this.disposed || signal?.aborted) return Promise.reject(new Error('image-cancelled'));
    if (!Number.isInteger(maxEdge) || maxEdge < 1 || maxEdge > MAX_DECODE_EDGE) return Promise.reject(new Error('variant-limit'));
    if (this.queue.length >= 512) return Promise.reject(new ImageLoadError('图片处理队列已满', false));
    return new Promise((resolve, reject) => {
      const request: ImageJob = { version: IMAGE_WORKER_VERSION, id: ++this.sequence, generation: 0, url: new URL(url, globalThis.location.href).href, maxEdge, encoded, allowThreads: experimentalThreads, ...(region ? {region} : {}), ...(bytes ? {bytes} : {}) };
      const abort = () => {
        const index = this.queue.indexOf(job);
        if (index !== -1) { this.queue.splice(index, 1); job.cleanup(); reject(new Error('image-cancelled')); }
        else {
          // Non-preemptible decode remains draining until a receipt or termination.
          const slot = this.slots.find(slot => slot.job === job);
          slot?.worker.postMessage({ cancel: request.id });
        }
      };
      const job: Job = { request, resolve, reject, signal, cleanup: () => signal?.removeEventListener('abort', abort) };
      signal?.addEventListener('abort', abort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }
  diagnostics() { return { workers: this.slots.length, queued: this.queue.length, active: this.slots.filter(s => s.job).length,
    wasmCapacityBytes: this.slots.reduce((n,s) => n+s.memoryBytes,0) }; }
  private destroy(slot: Slot) {
    clearTimeout(slot.timeout); clearTimeout(slot.idle);
    slot.worker.terminate();
    const i = this.slots.indexOf(slot); if (i >= 0) this.slots.splice(i,1);
  }
  private fail(slot: Slot, message: string) {
    const job = slot.job;
    this.destroy(slot);
    job?.cleanup(); job?.reject(new ImageLoadError(message, false));
    this.pump();
  }
  private spawn(): Slot {
    const slot: Slot = { worker: this.createWorker(), generation: ++this.generation, memoryBytes: 0 };
    slot.worker.onmessage = (event: MessageEvent<ImageReply>) => {
      const reply = event.data, job = slot.job;
      if (!job || reply.version !== IMAGE_WORKER_VERSION || reply.id !== job.request.id || reply.generation !== slot.generation) return;
      if (!reply.ok && reply.message === 'image-thread-init-failed' && job.request.allowThreads) {
        // Termination confirms nested compute Workers and their shared reservation are gone.
        this.destroy(slot);
        job.request.allowThreads = false;
        this.queue.unshift(job);
        this.pump();
        return;
      }
      clearTimeout(slot.timeout);
      slot.job = undefined;
      job.cleanup();
      if (job.signal?.aborted) job.reject(new Error('image-cancelled'));
      else if (reply.ok) { slot.memoryBytes = reply.result.memoryBytes; job.resolve(reply.result); }
      else job.reject(new ImageLoadError(reply.message, reply.transient));
      // Linear memory cannot shrink. Retire large instances immediately, others when idle.
      if (slot.memoryBytes > 64 * 1024 * 1024) this.destroy(slot);
      else slot.idle = setTimeout(() => { if (!slot.job) this.destroy(slot); }, 10000);
      this.pump();
    };
    slot.worker.onerror = () => this.fail(slot, '图片 Worker 意外终止，请重试');
    slot.worker.onmessageerror = () => this.fail(slot, '图片 Worker 回执无效');
    this.slots.push(slot);
    return slot;
  }
  private pump() {
    if (this.disposed) return;
    while (this.queue.length) {
      let slot = this.slots.find(s => !s.job);
      if (!slot) {
        if (this.slots.length >= Math.max(1, this.capacity)) return;
        try { slot = this.spawn(); }
        catch (error) { const job = this.queue.shift()!; job.cleanup(); job.reject(error); continue; }
      }
      clearTimeout(slot.idle);
      const job = this.queue.shift()!;
      job.request.generation = slot.generation;
      slot.job = job;
      slot.timeout = setTimeout(() => this.fail(slot!, '图片 Worker 处理超时，请重试'), 60000);
      slot.worker.postMessage(job.request, job.request.bytes ? [job.request.bytes] : []);
    }
  }
  dispose() {
    this.disposed = true;
    for (const slot of [...this.slots]) { slot.job?.cleanup(); slot.job?.reject(new Error('image-cancelled')); this.destroy(slot); }
    for (const job of this.queue.splice(0)) { job.cleanup(); job.reject(new Error('image-cancelled')); }
  }
}
let pool: ImageWorkerPool | undefined;
let coordinator: CanvasResourceCoordinator | undefined;
let jobSequence = 0;
export function registerImageCoordinator(value: CanvasResourceCoordinator) {
  coordinator=value;
  return () => { if(coordinator===value)coordinator=undefined; };
}

/** Page-side read of authorised compressed bytes; the decode slot is never held during this. */
async function readBytes(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const pageLocation = globalThis.location;
  const origin = pageLocation?.origin ?? 'http://localhost';
  const source = new URL(url, pageLocation?.href ?? origin);
  if (!['http:', 'https:', 'blob:', 'data:'].includes(source.protocol) || (source.protocol !== 'data:' && source.origin !== origin))
    throw new Error('unauthorised-image-origin');
  let response: Response;
  try { response = await fetch(source, { credentials: 'same-origin', ...(signal ? { signal } : {}) }); }
  catch (error) { throw new ImageLoadError(error instanceof Error ? error.message : '图片网络读取失败', true); }
  if (!response.ok) throw new ImageLoadError(`图片读取失败（HTTP ${response.status}）`, [408,425,429,500,502,503,504].includes(response.status));
  const declared = Number(response.headers.get('content-length'));
  if (declared > IMAGE_INPUT_LIMIT) { await response.body?.cancel(); throw new ImageLoadError('图片体积超过上限', false); }
  if (!response.body) throw new ImageLoadError('图片内容为空', false);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > IMAGE_INPUT_LIMIT) throw new ImageLoadError('图片体积超过上限', false);
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

function workerDecode(url: string, edge: number, signal?: AbortSignal, encoded = false, bytes?: ArrayBuffer, region?: ImageJob["region"]) {
  pool ??= new ImageWorkerPool();
  return pool.decode(url,edge,signal,encoded,region,bytes);
}

/**
 * Decoder output ceiling, matching Rust `media-image::MAX_EDGE`, the native job registrar and
 * the top of the residency tier ladder (`THUMBNAIL_TIERS`, 4096), so a zoomed-in card gets a
 * texture that follows its on-screen pixel size all the way up.
 *
 * Keep it equal to the Rust constant: if the decoder's limit is ever lowered again, preparation
 * above it is refused (`variant-limit`) and a zoomed-in card would lose its image entirely, so
 * the clamp below must be lowered with it (the texture then stays at the ceiling and keeps
 * rendering, just softer).
 */
const MAX_DECODE_EDGE = 4096;

/** Per-job decode reservation: small tiers cost half a full-size budget unit. */
function decodeReservation(edge: number): number {
  return edge <= 512 ? IMAGE_DECODE_RESERVATION_BYTES / 2 : IMAGE_DECODE_RESERVATION_BYTES;
}

async function admitted<T>(channel: "image" | "image-fetch", key: string, bytes: number, purpose: ResidencyPurpose,
  run:(signal?:AbortSignal)=>Promise<T>, signal?:AbortSignal):Promise<T> {
  if(!coordinator)return run(signal);
  const owner=coordinator;
  // 准入键就是调用方的内容/尝试键：通道各自一个队列，同一键落在两条通道上不冲突，
  // 而 `residency.cancel(key)` 能一次撤销读取与解码两段（纹理 owner 依赖这一点释放内容）。
  const abort=()=>owner.cancel(key);
  if(signal?.aborted)throw new Error('image-cancelled');
  signal?.addEventListener('abort',abort,{once:true});
  try {
    // 读取阶段可中止（fetch 支持 signal），取消立即归还读取名额；解码不可抢占，取消后
    // 仍 draining 到真实终结才归还。
    const result=await owner.admit({channel,key,purpose,bytes,abortable:channel==="image-fetch",run:({lease})=>run(lease.signal)});
    if(result.status==='settled')return result.value;
    if(result.status==='failed')throw result.error;
    throw new Error('image-cancelled');
  } finally {signal?.removeEventListener('abort',abort);}
}

/**
 * Two-stage pipeline: read under the `image-fetch` quota, then decode under the `image` quota.
 *
 * The read only reserves transfer bytes, so N reads can overlap a much smaller number of decodes;
 * a decode slot is acquired only once the bytes are local, which keeps Worker slots off RTT.
 * `fetched` = the caller already holds a pipeline (fetch) admission for this key and did the read
 * itself, so only the decode stage is admitted here.
 */
async function pipeline<T>(key: string, url: string, edge: number, purpose: ResidencyPurpose, fetched: boolean,
  signal: AbortSignal | undefined, decode: (bytes: ArrayBuffer, signal?: AbortSignal) => Promise<T>): Promise<T> {
  const bytes = fetched
    ? await readBytes(url, signal)
    : await admitted("image-fetch", key, IMAGE_FETCH_RESERVATION_BYTES, purpose, readSignal => readBytes(url, readSignal), signal);
  if (signal?.aborted) throw new Error('image-cancelled');
  return admitted("image", key, decodeReservation(edge), purpose, decodeSignal => decode(bytes, decodeSignal), signal);
}

export function decodeImageInWorker(url: string, maxEdge = 1024, signal?: AbortSignal, encoded = false): Promise<ImageResult> {
  const edge = Math.min(maxEdge, MAX_DECODE_EDGE);
  const key = `decode:${url}#${edge}#${encoded ? 'png' : 'rgba'}#${++jobSequence}`;
  return pipeline(key, url, edge, "interactive", false, signal, (bytes, decodeSignal) => workerDecode(url, edge, decodeSignal, encoded, bytes));
}

/** Encoded DOM preview: browser display decoding needs no application Canvas readback. */
export async function acquireImageThumbnail(url: string, maxEdge = 512, signal?: AbortSignal) {
  const result = await decodeImageInWorker(url,maxEdge,signal,true);
  const blobUrl = URL.createObjectURL(new Blob([result.png! as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
  let released = false;
  return { url: blobUrl, width: result.width, height: result.height, sourceWidth: result.sourceWidth, sourceHeight: result.sourceHeight, release: () => { if (!released) { released = true; URL.revokeObjectURL(blobUrl); } } };
}

type Prepared = import('@woohaa3/contracts').PreparedImageResource;
type SharedPreparation = { promise: Promise<Prepared>; controller: AbortController; consumers: number; interested: number };
const nativeIds=new WeakMap<object,number>();
let nextNativeId=0;
const sharedPreparations=new Map<string,SharedPreparation>();

export type PrepareImageOptions = {
  /** Residency priority for both stages; default `interactive`. */
  purpose?: ResidencyPurpose;
  /** Admission key; a caller may cancel with `residency.cancel(key)`. */
  key?: string;
  /** The caller already holds the `image-fetch` pipeline admission and reads nothing itself. */
  fetched?: boolean;
};

async function sharedPrepare(requestedEdge:number, url:string, signal:AbortSignal|undefined, purpose:ResidencyPurpose, fetched:boolean, admissionKey:string):Promise<Prepared> {
  if(signal?.aborted)throw new Error('image-cancelled');
  // 请求档位超过解码器上限（比如调用方传 8192）时收敛到 `MAX_DECODE_EDGE`，再进缓存与预留，
  // 让超限的请求与上限档共用一份结果，也不会多计解码预算。
  const edge = Math.min(requestedEdge, MAX_DECODE_EDGE);
  const native=nativeImagePort();
  if(native && !nativeIds.has(native))nativeIds.set(native,++nextNativeId);
  const key=`${native?`native-${nativeIds.get(native)}`:'worker'}:${url}:${edge}`;
  let entry=sharedPreparations.get(key);
  if(!entry || entry.controller.signal.aborted) {
    const controller=new AbortController();
    entry={controller,consumers:0,interested:0,promise:undefined as unknown as Promise<Prepared>};
    const target=entry;
    const registerBytes = native?.prepareBytes?.bind(native);
    // Ports that cannot register pre-read bytes keep the legacy single stage (they read themselves);
    // our native client always registers, so the page owns the read quota.
    entry.promise=(!native || registerBytes
      ? pipeline(admissionKey,url,edge,purpose,fetched,controller.signal,
          (bytes,decodeSignal)=>registerBytes
            ? registerBytes(new Uint8Array(bytes),edge,decodeSignal)
            : workerDecode(url,edge,decodeSignal,false,bytes))
      : admitted("image",admissionKey,decodeReservation(edge),purpose,
          prepareSignal=>native.prepare(url,edge,prepareSignal),controller.signal)
    ).then(result=> {
      retainImagePixels(result.pixels,target.consumers);
      return result;
    }).finally(()=>{if(sharedPreparations.get(key)===target)sharedPreparations.delete(key);});
    sharedPreparations.set(key,entry);
  }
  const target=entry;target.consumers++;target.interested++;
  const abort=()=>{target.interested--;if(target.interested===0)target.controller.abort();};
  signal?.addEventListener('abort',abort,{once:true});
  try {
    const result=await target.promise;
    if(signal?.aborted) {releaseImagePixels(result.pixels);throw new Error('image-cancelled');}
    return result;
  } finally {signal?.removeEventListener('abort',abort);}
}

/**
 * Public preparation facade; only executing jobs coalesce, so page admission cannot deadlock.
 *
 * `options.fetched` is set by the canvas texture owner, which already admitted the pipeline stage
 * (so its per-content key can be cancelled) and needs the decode slot acquired only after bytes
 * are local.
 */
export function prepareImageResource(url: string, edge = 1024, signal?: AbortSignal, options: PrepareImageOptions = {}): Promise<Prepared> {
  const purpose = options.purpose ?? "interactive";
  const admissionKey = options.key ?? `facade:${url}#${Math.min(edge, MAX_DECODE_EDGE)}#${++jobSequence}`;
  return sharedPrepare(edge, url, signal, purpose, options.fetched ?? false, admissionKey);
}

/** Explicit bounded RGBA export in the 2048-edge prepared variant, at most 512 × 512. */
export function readImageRegion(url:string, region:NonNullable<ImageJob['region']>, signal?:AbortSignal) {
  if(![region.x,region.y,region.width,region.height].every(Number.isInteger) || region.x<0 || region.y<0 || region.width<1 || region.height<1 || region.width>512 || region.height>512)
    return Promise.reject(new Error('pixel-region-limit'));
  const key = `region:${url}#${++jobSequence}`;
  return pipeline(key, url, 2048, "interactive", false, signal,
    (bytes, decodeSignal) => workerDecode(url, 2048, decodeSignal, false, bytes, region));
}
