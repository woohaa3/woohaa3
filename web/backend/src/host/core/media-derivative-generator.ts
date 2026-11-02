/**
 * 核心层 · media 的预览派生执行器。
 *
 * media-service 只负责排队、并发、预算与缓存，**不含 codec**（见
 * `@woohaa3/media-service` 的 `media-derivatives.ts`）。不注入执行器时，
 * `/api/media/<key>?variant=thumbnail&edge=…` 一律以 415 结束，前端只能回退原图 ——
 * 资源页一屏几十张 4096 宽、单张 8–23 MB 的 PNG 就是这么来的。
 *
 * 这里复用仓库已有的 Rust 解码模块（`media-image`，桌面端与浏览器共用同一套 codec），
 * 不引入新的原生依赖：
 * - 解码与缩放都在 `worker_threads` 里，避免把几十张 4K 图的事件循环堵住；
 * - 模块用 `initSync` 载入，Worker 启动一次、常驻复用；
 * - 找不到构建产物时**不报错、返回 null**，调用方退回「没有执行器」的老行为
 *   （接口 415、前端回退原图）—— 缩略图是优化，不能变成新的失败路径。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { MediaServiceOptions } from "@woohaa3/media-service";

type Generator = NonNullable<MediaServiceOptions["derivativeGenerator"]>;

/** 只有 PNG 有对应编码器（`PreparedImage.png()`）；其它格式在生成器里直接判失败。 */
const SUPPORTED_FORMAT = "png";
const WORKER_POOL_SIZE = 4;

export type MediaImageModule = { glueUrl: string; wasmPath: string };

/**
 * 定位 `build-media-image` 的产物。
 *
 * 源码树里是 `web/frontend/src/media-image-wasm/`（.gitignore，需要先跑
 * `pnpm run build:media-image`）；打包后的宿主是 `frontend/assets/media_image_bg-<hash>.wasm`，
 * 但那份 glue 已被 Vite 打进 chunk，没有可 import 的独立模块 —— 那种形态下返回 null。
 */
export function locateMediaImageModule(fromUrl: string): MediaImageModule | null {
  const configured = process.env.WOOHAA_MEDIA_IMAGE_DIR;
  if (configured) {
    const found = readModuleDir(configured);
    if (found) return found;
  }
  let dir = path.dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidates = [
      path.join(dir, "web", "frontend", "src", "media-image-wasm"),
      path.join(dir, "frontend", "src", "media-image-wasm"),
      path.join(dir, "src", "media-image-wasm")
    ];
    for (const candidate of candidates) {
      const found = readModuleDir(candidate);
      if (found) return found;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readModuleDir(dir: string): MediaImageModule | null {
  const glue = path.join(dir, "media_image.js");
  const wasm = path.join(dir, "media_image_bg.wasm");
  if (!existsSync(glue) || !existsSync(wasm)) return null;
  return { glueUrl: pathToFileURL(glue).href, wasmPath: wasm };
}

/**
 * Worker 引导脚本。
 *
 * 必须显式传两个路径：Worker 的模块解析基准是进程 cwd，靠包名或相对路径都不可靠。
 * `initSync` 吃的是 wasm 字节，所以在 Worker 里读一次文件，而不是从主线程把 2.4 MB 拷过去。
 */
const WORKER_BOOTSTRAP = `
import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";

let prepare;
try {
  const mod = await import(workerData.glueUrl);
  mod.initSync({ module: readFileSync(workerData.wasmPath) });
  prepare = mod.prepare_image;
} catch (error) {
  parentPort.postMessage({ id: 0, ok: false, error: "worker-init: " + (error && error.message ? error.message : String(error)) });
  process.exit(1);
}

parentPort.on("message", ({ id, bytes, edge }) => {
  try {
    const image = prepare(new Uint8Array(bytes), edge);
    try {
      parentPort.postMessage({ id, ok: true, png: image.png(), width: image.width, height: image.height });
    } finally {
      image.free();
    }
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: error && error.message ? error.message : String(error) });
  }
});
`;

type Waiter = { resolve: (worker: Worker) => void };
type Job = {
  resolve: (value: { png: Uint8Array; width: number; height: number }) => void;
  reject: (error: Error) => void;
};
type WorkerReply = { id: number; ok: boolean; png?: Uint8Array; width?: number; height?: number; error?: string };

/**
 * 常驻 Worker 池。生成的并发上限由 media-service 的 `concurrency` 控制，
 * 这里只需要保证「一次解码不占主线程」并且有界。
 */
export function createImageWorkerPool(module: MediaImageModule, size = WORKER_POOL_SIZE) {
  const idle: Worker[] = [];
  const all = new Set<Worker>();
  const waiters: Waiter[] = [];
  const jobs = new Map<number, Job>();
  let nextId = 1;
  let closed = false;

  const spawn = (): Worker => {
    const worker = new Worker(WORKER_BOOTSTRAP, {
      eval: true,
      workerData: { glueUrl: module.glueUrl, wasmPath: module.wasmPath },
      resourceLimits: { maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 64 }
    });
    worker.unref();
    all.add(worker);
    const fail = (error: Error) => {
      for (const [id, job] of jobs) {
        job.reject(error);
        jobs.delete(id);
      }
      all.delete(worker);
      const at = idle.indexOf(worker);
      if (at >= 0) idle.splice(at, 1);
    };
    worker.on("message", (reply: WorkerReply) => {
      const job = jobs.get(reply.id);
      if (job) {
        jobs.delete(reply.id);
        if (reply.ok && reply.png) job.resolve({ png: reply.png, width: reply.width ?? 0, height: reply.height ?? 0 });
        else job.reject(new Error(reply.error ?? "派生失败"));
      }
      if (!closed) {
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(worker);
        else idle.push(worker);
      }
    });
    worker.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
    worker.on("exit", (code) => { if (code !== 0) fail(new Error(`图片解码 Worker 退出：${code}`)); });
    return worker;
  };

  const acquire = (): Promise<Worker> => {
    const worker = idle.pop();
    if (worker) return Promise.resolve(worker);
    if (all.size < size) return Promise.resolve(spawn());
    return new Promise((resolve) => waiters.push({ resolve }));
  };

  return {
    async run(bytes: Uint8Array, edge: number) {
      if (closed) throw new Error("图片解码池已关闭");
      const worker = await acquire();
      const id = nextId++;
      const done = new Promise<{ png: Uint8Array; width: number; height: number }>((resolve, reject) => {
        jobs.set(id, { resolve, reject });
      });
      worker.postMessage({ id, bytes, edge });
      return done;
    },
    close() {
      closed = true;
      for (const [id, job] of jobs) {
        job.reject(new Error("图片解码池已关闭"));
        jobs.delete(id);
      }
      for (const worker of all) void worker.terminate();
      all.clear();
      idle.length = 0;
    }
  };
}

/**
 * 组装 media-service 需要的生成器；拿不到解码模块时返回 `undefined`。
 *
 * `undefined` 与「没有执行器」完全等价：接口继续以 415 结束，前端继续回退原图。
 */
export function createMediaImageDerivativeGenerator(options: {
  /** 用于定位模块的基准；默认本文件的 URL。 */
  fromUrl?: string;
  log?: (event: Record<string, unknown>) => void;
} = {}): Generator | undefined {
  const module = locateMediaImageModule(options.fromUrl ?? import.meta.url);
  if (!module) {
    options.log?.({ event: "media-derivative-unavailable", reason: "media-image 构建产物不存在" });
    return undefined;
  }
  const pool = createImageWorkerPool(module);
  return async (input) => {
    if (input.identity.format !== SUPPORTED_FORMAT) {
      throw new Error(`缩略图只支持 ${SUPPORTED_FORMAT} 输出，收到 ${input.identity.format}`);
    }
    const result = await pool.run(input.bytes, input.edge);
    return {
      bytes: new Uint8Array(result.png),
      contentType: "image/png",
      width: result.width,
      height: result.height
    };
  };
}
