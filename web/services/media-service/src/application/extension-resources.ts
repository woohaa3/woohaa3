/** 有界、内容寻址的扩展资源端口；HTTP 与进程内宿主共享同一存储策略。 */
import {
  ALLOWED_MEDIA_TYPES, computeStorageKey, inferMediaKindFromType, isValidStorageKey,
  normalizeMediaType, type ApplicationExtensionMediaResourcesFacade, type MediaStorage,
  type MediaStorageScope
} from "@woohaa3/contracts";
import { computeSha256Hex } from "./ingest.js";
import { decodeCanvasScope } from "./media-scope.js";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_BYTES = 16 * 1024 * 1024;
let activeTransfers = 0;
const commits = new WeakMap<MediaStorage,Map<string,Promise<void>>>();
async function commit<T>(storage:MediaStorage,key:string,work:()=>Promise<T>):Promise<T> {
  let locks=commits.get(storage);if(!locks){locks=new Map();commits.set(storage,locks);}
  const previous=locks.get(key);let release!:()=>void;const current=new Promise<void>(r=>{release=r;});locks.set(key,current);
  try {await previous;return await work();}finally{release();if(locks.get(key)===current)locks.delete(key);}
}
const TYPES = new Set([...ALLOWED_MEDIA_TYPES, "application/zip", "text/html", "text/css",
  "application/javascript", "text/javascript", "model/gltf-binary", "model/gltf+json",
  "application/octet-stream", "image/svg+xml", "font/woff", "font/woff2", "font/ttf", "font/otf"]);

export class ExtensionResourceError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

/**
 * 把可选的 canvasId 解成存储作用域。
 *
 * 不变量：**声明了画布就必须带作用域落到该画布的后端**，远端画布的字节只在托管存储里
 * （`<canvasId>/media/<key>`）；非法 id 直接拒绝，绝不静默退化成「无作用域」。
 * 省略 canvasId 表示与画布无关（扩展素材、独立页），行为与历史一致。
 */
function scopeOf(canvasId: string | undefined): MediaStorageScope | undefined {
  const decoded = decodeCanvasScope(canvasId);
  if (!decoded.ok) throw new ExtensionResourceError("malformed-request", 400, decoded.message);
  return decoded.scope;
}

export function createExtensionMediaResources(storage: MediaStorage): ApplicationExtensionMediaResourcesFacade {
  return {
    async openRead(storageKey, canvasId) {
      const scope = scopeOf(canvasId);
      if (!isValidStorageKey(storageKey)) throw new ExtensionResourceError("malformed-request", 400, "稳定资源键非法");
      if (!storage.stat || !storage.openRead) throw new ExtensionResourceError("unsupported", 503, "当前存储不支持流式读取");
      const meta = await storage.stat(storageKey, scope);
      if (meta.size > 2 * 1024 ** 3) throw new ExtensionResourceError("limit-exceeded", 413, "资源超过流式读取上限");
      return { ...await storage.openRead(storageKey, undefined, scope), contentType: meta.contentType ?? "application/octet-stream", size: meta.size };
    },
    async writeStream(input) {
      const scope = scopeOf(input.canvasId);
      const contentType = normalizeMediaType(input.contentType);
      if (!TYPES.has(contentType)) throw new ExtensionResourceError("malformed-request", 400, "媒体类型非法");
      const limit = Math.min(input.maxBytes ?? 2 * 1024 ** 3, 2 * 1024 ** 3);
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new ExtensionResourceError("malformed-request", 400, "资源上限非法");
      input.signal?.throwIfAborted();
      if (activeTransfers >= 2) throw new ExtensionResourceError("transfer-busy",429,"媒体传输繁忙，请稍后重试");
      activeTransfers++;
      let directory: string;
      try { directory = await mkdtemp(join(tmpdir(), "woohaa-media-")); } catch(error) {activeTransfers--;throw error;}
      const file = join(directory, "upload");
      const hash = createHash("sha256"); let size = 0;
      try {
        const handle = await open(file, "wx");
        try {
          for await (const chunk of input.bytes) {
            input.signal?.throwIfAborted(); size += chunk.byteLength;
            if (size > limit) throw new ExtensionResourceError("limit-exceeded", 413, "资源字节超限");
            hash.update(chunk);
            let offset = 0;
            while (offset < chunk.length) { const written = await handle.write(chunk, offset); if (!written.bytesWritten) throw new Error("媒体临时写入失败"); offset += written.bytesWritten; }
          }
        } finally { await handle.close(); }
        if (!size) throw new ExtensionResourceError("malformed-request", 400, "资源为空");
        const checksum = hash.digest("hex"), storageKey = computeStorageKey(checksum);
        input.signal?.throwIfAborted();
        await commit(storage,`${input.canvasId ?? ""}:${storageKey}`,async()=>{if (await storage.exists(storageKey, scope)) {
          const meta = storage.stat ? await storage.stat(storageKey, scope) : await storage.get(storageKey, scope).then(o => ({ contentType: o.contentType, size: o.bytes.length }));
          if (meta.contentType !== contentType || meta.size !== size) throw new ExtensionResourceError("content-type-conflict", 409, "稳定资源内容或类型冲突");
        } else if (storage.putStream) {
          const stream = createReadStream(file);
          try { await storage.putStream(storageKey, stream, contentType, { size, signal: input.signal }, scope); } finally { stream.destroy(); }
        } else throw new ExtensionResourceError("unsupported", 503, "当前存储不支持流式写入");});
        return { storageKey, checksum, contentType, size, mediaKind: inferMediaKindFromType(contentType) ?? "other" };
      } finally { activeTransfers--; await rm(directory, { recursive: true, force: true }); }
    },
    async read(storageKey, canvasId) {
      if (!isValidStorageKey(storageKey)) throw new ExtensionResourceError("malformed-request", 400, "稳定资源键非法");
      const scope = scopeOf(canvasId);
      if (storage.stat && (await storage.stat(storageKey, scope)).size > MAX_BYTES) throw new ExtensionResourceError("limit-exceeded", 413, "资源超过读取上限");
      const object = await storage.get(storageKey, scope);
      if (object.bytes.byteLength > MAX_BYTES) throw new ExtensionResourceError("limit-exceeded", 413, "资源超过读取上限");
      return { bytes: object.bytes, contentType: object.contentType ?? "application/octet-stream" };
    },
    async write(input) {
      const contentType = normalizeMediaType(input.contentType);
      if (!TYPES.has(contentType)) throw new ExtensionResourceError("malformed-request", 400, "媒体类型非法");
      if (!input.bytes.byteLength || input.bytes.byteLength > MAX_BYTES) throw new ExtensionResourceError("limit-exceeded", 413, "资源字节超限");
      const scope = scopeOf(input.canvasId);
      const checksum = await computeSha256Hex(input.bytes);
      const storageKey = computeStorageKey(checksum);
      await commit(storage,`${input.canvasId ?? ""}:${storageKey}`,async()=>{if (await storage.exists(storageKey, scope)) {
        const existing = await storage.get(storageKey, scope);
        if (existing.contentType !== contentType) throw new ExtensionResourceError("content-type-conflict", 409, "同一稳定资源不可更改类型");
      } else await storage.put(storageKey, input.bytes, contentType, scope);});
      return { storageKey, checksum, contentType, size: input.bytes.byteLength, mediaKind: inferMediaKindFromType(contentType) ?? "other" };
    }
  };
}
