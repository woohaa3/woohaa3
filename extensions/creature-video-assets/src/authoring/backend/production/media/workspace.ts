import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ApplicationExtensionServices } from "@woohaa3/contracts";
import { WorkflowError, type Artifact } from "../../../../state/shared/workflow.js";

const MAX_FILE = 2 * 1024 ** 3;
/** Scratch paths are never persisted. Stable Media objects are the recovery source of truth. */
export class Workspace {
  private total = 0;
  private constructor(readonly root: string, private readonly services: ApplicationExtensionServices, private readonly canvasId?: string) {}
  static async create(services: ApplicationExtensionServices, canvasId?: string): Promise<Workspace> {
    return new Workspace(await mkdtemp(join(tmpdir(), "woohaa-creature-")), services, canvasId);
  }
  path(name: string): string {
    const path = resolve(this.root, name);
    if (!path.startsWith(this.root + sep) || name.includes("\0")) throw new WorkflowError("unsafe-path", "产物路径非法。");
    return path;
  }
  async directory(name: string): Promise<string> { const path = this.path(name); await mkdir(path, { recursive: true }); return path; }
  async materialize(artifact: Artifact, name: string): Promise<string> {
    if (!artifact.storageKey || !artifact.checksum) throw new WorkflowError("missing-media", "前序产物缺少稳定媒体引用。");
    const resources = this.services.media.resources;
    if (!resources?.openRead) throw new WorkflowError("streaming-unavailable", "当前宿主不支持流式媒体读取。");
    const source = await resources.openRead(artifact.storageKey, this.canvasId), output = this.path(name);
    this.total += source.size;
    if (source.size > MAX_FILE || this.total > 20 * 1024 ** 3) { source.cancel(); throw new WorkflowError("media-limit", "本轮媒体超过处理上限。"); }
    await mkdir(dirname(output), {recursive:true});
    const hash = createHash("sha256"); let size = 0;
    try {
      await pipeline(Readable.from((async function* () {
        for await (const chunk of source.bytes) { size += chunk.length; if (size > source.size) throw new Error("媒体超限"); hash.update(chunk); yield chunk; }
      })()), createWriteStream(output, {flags:"wx"}));
      if (size !== source.size || hash.digest("hex") !== artifact.checksum) throw new WorkflowError("media-corrupt", "媒体内容不完整或校验不一致。");
    } finally { source.cancel(); }
    return output;
  }
  async collect(file: string, title: string, kind: Artifact["kind"], contentType: string, extra: Partial<Artifact> = {}): Promise<Artifact> {
    if (!resolve(file).startsWith(this.root + sep)) throw new WorkflowError("unsafe-path", "产物不在当前工作目录。");
    const size = (await stat(file)).size;
    if (!size || size > MAX_FILE) throw new WorkflowError("media-limit", "产物为空或超过处理上限。");
    const resources = this.services.media.resources;
    if (!resources?.writeStream) throw new WorkflowError("streaming-unavailable", "当前宿主不支持流式媒体保存。");
    const stream = createReadStream(file);
    try { const media = await resources.writeStream({bytes:stream, contentType, maxBytes:MAX_FILE, canvasId:this.canvasId}); return {...extra, ...media, id:`media-${media.checksum}`, title, kind}; }
    finally { stream.destroy(); }
  }
  async dispose(): Promise<void> { await rm(this.root, {recursive:true,force:true}); }
}
