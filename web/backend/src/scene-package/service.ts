/** Orchestrates local package bytes/media; Canvas owns atomic publication. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ScenePackageJob, ScenePackageImportReceipt, BackendMediaPort } from '@woohaa3/contracts';
import { SCENE_PACKAGE_LIMITS } from '@woohaa3/contracts';
import type { SqliteScenePackageStore } from '@woohaa3/canvas-service';
import { decodeScenePackage, ScenePackageError } from './archive.js';
import { remapScenePackage } from './remap.js';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const publicJob = (j: ScenePackageJob): ScenePackageJob => ({ operationId: j.operationId, packageHash: j.packageHash, canvasId: j.canvasId, phase: j.phase, completedMedia: j.completedMedia, totalMedia: j.totalMedia, ...(j.error ? { error: j.error } : {}) });
export class ScenePackageService {
    private readonly inFlight = new Map<string, Promise<void>>();
    private closed = false;
    private initError: unknown;
    private readonly initialized: Promise<void>;
    private readers = 0;
    private files: Promise<void> = Promise.resolve();
    constructor(private readonly options: {
        store: SqliteScenePackageStore;
        directory: string;
        importMedia: BackendMediaPort['importBytes'];
        verifyMedia: (storageKey: string, expected: {
            checksum: string;
            size: number;
            contentType: string;
        }, canvasId: string) => Promise<boolean>;
    }) { this.initialized = this.cleanupSources(true).catch(error => { this.initError = error; }); }
    async ready() { await this.initialized; if (this.initError)
        throw Error('package-storage-unavailable'); }
    canAcceptUpload(pendingUploads = 0) { return !this.closed && !this.initError && this.inFlight.size + this.readers + pendingUploads < 2 && this.options.store.activeCount() < 2; }
    private withFiles<T>(run: () => Promise<T>): Promise<T> { const result = this.files.then(run); this.files = result.then(() => undefined, () => undefined); return result; }
    private cleanupSources(temporary = false) { return this.withFiles(() => this.cleanupFiles(temporary)); }
    private async cleanupFiles(temporary = false) { await mkdir(this.options.directory, { recursive: true }); const retained = new Set(this.options.store.retainedPackageHashes()); for (const entry of await readdir(this.options.directory)) {
        const source = /^([a-f0-9]{64})\.woohaa-scene$/.exec(entry);
        const abandoned = temporary && /^[a-f0-9]{64}-[a-f0-9-]{36}\.tmp$/.test(entry);
        if (abandoned || (source && !retained.has(source[1])))
            await unlink(path.join(this.options.directory, entry)).catch(e => { if (e.code !== 'ENOENT')
                throw e; });
    } }
    get(id: string) { const j = this.options.store.get(id); if (!j)
        throw Error('package-job-not-found'); return publicJob(j); }
    receipt(id: string) { return this.options.store.receipt(id); }
    async start(operationId: string, bytes: Uint8Array, copy = false): Promise<{
        job: ScenePackageJob;
        duplicate?: boolean;
        receipt?: ScenePackageImportReceipt;
    }> {
        await this.ready();
        if (this.closed)
            throw Error('package-service-closed');
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(operationId))
            throw Error('invalid-operation-id');
        if (bytes.byteLength > SCENE_PACKAGE_LIMITS.compressedBytes)
            throw Error('package-too-large');
        const hash = sha(bytes), store = this.options.store, old = store.get(operationId);
        if (old) {
            if (old.packageHash !== hash)
                throw Error('operation-conflict');
            if (old.phase === 'ready' && !store.receipt(old.canvasId))
                throw Error('package-target-deleted');
            if (old.phase !== 'failed' || this.inFlight.has(operationId))
                return { job: publicJob(old) };
        }
        const job = store.reserve(operationId, hash);
        // Include validation in the tracked task so shutdown cannot close the publication store early.
        let resolveValidation!: (value: {
            job: ScenePackageJob;
            duplicate?: boolean;
            receipt?: ScenePackageImportReceipt;
        }) => void;
        const validation = new Promise<{
            job: ScenePackageJob;
            duplicate?: boolean;
            receipt?: ScenePackageImportReceipt;
        }>(r => resolveValidation = r);
        const task = (async () => {
            let fence: number | undefined = job.fence;
            try {
                fence = store.begin(operationId).fence;
                await new Promise<void>(r => setImmediate(r));
                this.check(operationId, fence);
                const decoded = await decodeScenePackage(bytes);
                this.check(operationId, fence);
                if (!copy) {
                    const receipt = store.findContentReady(decoded.manifest.contentHash);
                    if (receipt) {
                        store.reuse(operationId, receipt);
                        resolveValidation({ job: this.get(operationId), duplicate: true, receipt });
                        return;
                    }
                }
                await this.retain(hash, bytes);
                this.check(operationId, fence);
                store.update(operationId, { phase: 'staging-media', totalMedia: decoded.manifest.media.length }, fence);
                resolveValidation({ job: this.get(operationId) });
                // Yield before importing so immediate cancellation after the POST can be observed.
                await new Promise<void>(r => setImmediate(r));
                const media = new Map<string, {
                    storageKey: string;
                    url: string;
                    size: number;
                    mimeType: string;
                }>();
                for (const entry of decoded.manifest.media) {
                    this.check(operationId, fence);
                    const raw = decoded.media.get(entry.assetId)!;
                    const metadata = await this.options.importMedia({ bytesBase64: Buffer.from(raw).toString('base64'), contentType: entry.mimeType, maxBytes: entry.size, canvasId: job.canvasId });
                    this.check(operationId, fence);
                    if (!await this.options.verifyMedia(metadata.storageKey, { checksum: entry.sha256, size: entry.size, contentType: entry.mimeType }, job.canvasId))
                        throw Error('package-media-unavailable');
                    this.check(operationId, fence);
                    media.set(entry.assetId, { storageKey: metadata.storageKey, url: `/api/media/${metadata.storageKey}`, size: entry.size, mimeType: entry.mimeType });
                    store.update(operationId, { completedMedia: media.size }, fence);
                }
                this.check(operationId, fence);
                const mapped = remapScenePackage(decoded, { canvasId: job.canvasId, media });
                store.update(operationId, { phase: 'committing' }, fence);
                await store.commit(operationId, fence, mapped.canvas, mapped.manifest);
            }
            catch (e) {
                const current = store.get(operationId);
                if (current && current.phase !== 'cancelled' && current.phase !== 'ready' && current.fence === fence) {
                    const code = this.closed ? 'interrupted' : e instanceof ScenePackageError ? e.code : e instanceof Error && /^(package-|invalid-|unsupported-|scene-)/.test(e.message) ? e.message.slice(0, 80) : 'package-import-failed';
                    store.update(operationId, { phase: 'failed', error: { code, message: this.closed ? '导入被中断，请重试' : e instanceof ScenePackageError ? '场景文件损坏、格式不支持或内容不完整，请重新选择文件' : '场景导入失败，请重试', retryable: !(e instanceof ScenePackageError) } });
                }
                resolveValidation({ job: this.get(operationId) });
            }
        })();
        this.inFlight.set(operationId, task);
        void task.finally(async () => { this.inFlight.delete(operationId); await this.cleanupSources().catch(() => undefined); });
        return validation;
    }
    private check(id: string, fence: number) { const j = this.options.store.get(id); if (this.closed || !j || j.fence !== fence || j.phase === 'cancelled')
        throw Error('package-attempt-cancelled'); }
    cancel(id: string) { return publicJob(this.options.store.cancel(id)); }
    async reset(canvasId: string, operationId: string = randomUUID()) { await this.ready(); if (!this.canAcceptUpload())
        throw Error('package-import-busy'); this.readers++; try {
        const receipt = this.receipt(canvasId);
        if (!receipt)
            throw Error('package-receipt-not-found');
        const bytes = await this.withFiles(() => this.readRetained(receipt.packageHash));
        return await this.start(operationId, bytes, true);
    }
    finally {
        this.readers--;
    } }
    private async readRetained(hash: string) { const file = path.join(this.options.directory, `${hash}.woohaa-scene`); const info = await stat(file); if (info.size > SCENE_PACKAGE_LIMITS.compressedBytes)
        throw Error('package-source-corrupt'); const bytes = await readFile(file); if (sha(bytes) !== hash)
        throw Error('package-source-corrupt'); return bytes; }
    private retain(hash: string, bytes: Uint8Array) { return this.withFiles(() => this.retainFile(hash, bytes)); }
    private async retainFile(hash: string, bytes: Uint8Array) {
        await mkdir(this.options.directory, { recursive: true });
        const file = path.join(this.options.directory, `${hash}.woohaa-scene`);
        try {
            const info = await stat(file);
            if (info.size === bytes.byteLength && sha(await this.readRetained(hash)) === hash)
                return;
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                throw e;
        }
        let size = 0;
        for (const entry of await readdir(this.options.directory)) {
            if (/^[a-f0-9]{64}\.woohaa-scene$/.test(entry))
                size += (await stat(path.join(this.options.directory, entry))).size;
        }
        if (size + bytes.byteLength > 2 * 1024 * 1024 * 1024)
            throw Error('package-retention-limit');
        const temporary = path.join(this.options.directory, `${hash}-${randomUUID()}.tmp`);
        try {
            await writeFile(temporary, bytes, { flag: 'wx' });
            await rename(temporary, file);
        }
        finally {
            await unlink(temporary).catch(() => undefined);
        }
    }
    async close() { this.closed = true; await this.initialized; await Promise.allSettled(this.inFlight.values()); await this.cleanupSources().catch(() => undefined); }
}
