/** Local package publication. Separate receipts from external-source migration/ACL. */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { parseCanvasAggregate, type ServerCanvas, type ScenePackageJob, type ScenePackageImportReceipt, type ScenePackageManifest } from '@woohaa3/contracts';
import { serverCanvasToYDoc, YJS_CANVAS_FORMAT_VERSION } from '@woohaa3/contracts/canvas-yjs';
import { encodeStateAsUpdate } from 'yjs';
import { loadNodeSqlite } from './sqlite-loader.js';
type InternalJob = ScenePackageJob & {
    fence: number;
};
export class SqliteScenePackageStore {
    private readonly db: DatabaseSync;
    private closed = false;
    constructor(private readonly options: {
        path: string;
        onWritePoint?: (point: string) => void;
    }) {
        this.db = new (loadNodeSqlite().DatabaseSync)(options.path);
        this.db.exec(`PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS local_scene_package_jobs(operation_id TEXT PRIMARY KEY,package_hash TEXT NOT NULL,canvas_id TEXT NOT NULL,phase TEXT NOT NULL,payload TEXT NOT NULL,fence INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS local_scene_package_operations(operation_id TEXT PRIMARY KEY,package_hash TEXT NOT NULL,canvas_id TEXT NOT NULL,phase TEXT NOT NULL,fence INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS local_scene_package_receipts(canvas_id TEXT PRIMARY KEY,package_hash TEXT NOT NULL,receipt_json TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS local_scene_package_hash ON local_scene_package_receipts(package_hash);
   INSERT OR IGNORE INTO local_scene_package_operations SELECT operation_id,package_hash,canvas_id,phase,fence FROM local_scene_package_jobs;`);
    }
    close() { if (!this.closed) {
        this.closed = true;
        this.db.close();
    } }
    get(id: string): InternalJob | null {
        const r = this.db.prepare('SELECT payload,fence FROM local_scene_package_jobs WHERE operation_id=?').get(id) as {
            payload: string;
            fence: number;
        } | undefined;
        if (r)
            return { ...JSON.parse(r.payload), fence: r.fence };
        const op = this.db.prepare('SELECT * FROM local_scene_package_operations WHERE operation_id=?').get(id) as {
            operation_id: string;
            package_hash: string;
            canvas_id: string;
            phase: string;
            fence: number;
        } | undefined;
        if (!op)
            return null;
        const receipt = this.receipt(op.canvas_id);
        const ready = op.phase === 'ready';
        const total = receipt?.manifest.media.length ?? 0;
        return { operationId: id, packageHash: op.package_hash, canvasId: op.canvas_id, phase: ready ? 'ready' : 'failed', fence: op.fence, completedMedia: ready ? total : 0, totalMedia: total, ...(!ready ? { error: { code: 'package-operation-expired', message: '此历史导入请求已过期，请重新选择文件创建新请求', retryable: false } } : {}) };
    }
    activeCount() { return (this.db.prepare("SELECT COUNT(*) AS count FROM local_scene_package_jobs WHERE phase NOT IN ('ready','failed','cancelled')").get() as {
        count: number;
    }).count; }
    private prune() { this.db.prepare("DELETE FROM local_scene_package_jobs WHERE phase IN ('ready','failed','cancelled') AND operation_id NOT IN (SELECT operation_id FROM local_scene_package_jobs ORDER BY rowid DESC LIMIT 256)").run(); }
    private remember(job: InternalJob) { this.db.prepare('INSERT INTO local_scene_package_operations VALUES(?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET canvas_id=excluded.canvas_id,phase=excluded.phase,fence=excluded.fence').run(job.operationId, job.packageHash, job.canvasId, job.phase, job.fence); }
    retainedPackageHashes() {
        return [...new Set([
                ...this.db.prepare('SELECT package_hash FROM local_scene_package_receipts WHERE EXISTS(SELECT 1 FROM canvases WHERE id=canvas_id)').all(),
                ...this.db.prepare("SELECT package_hash FROM local_scene_package_jobs WHERE phase NOT IN ('ready','failed','cancelled')").all()
            ].map(r => String(r.package_hash)))];
    }
    reserve(operationId: string, packageHash: string): InternalJob {
        const old = this.get(operationId);
        if (old) {
            if (old.packageHash !== packageHash)
                throw Error('operation-conflict');
            if (old.error?.code === 'package-operation-expired')
                throw Error('package-operation-expired');
            return old;
        }
        const active = this.db.prepare("SELECT COUNT(*) AS count FROM local_scene_package_jobs WHERE phase NOT IN ('ready','failed','cancelled')").get() as {
            count: number;
        };
        if (active.count >= 2)
            throw Error('package-import-busy');
        this.prune();
        const job: InternalJob = { operationId, packageHash, canvasId: randomUUID(), phase: 'uploaded', completedMedia: 0, totalMedia: 0, fence: 0 };
        this.db.prepare('INSERT INTO local_scene_package_jobs VALUES(?,?,?,?,?,0)').run(operationId, packageHash, job.canvasId, job.phase, JSON.stringify(job));
        this.remember(job);
        return job;
    }
    update(id: string, patch: Partial<ScenePackageJob>, fence?: number): InternalJob {
        const job = this.get(id);
        if (!job)
            throw Error('package-job-not-found');
        if (fence !== undefined && (job.fence !== fence || job.phase === 'cancelled' || job.phase === 'failed' || job.phase === 'ready'))
            throw Error('stale-package-attempt');
        const next = { ...job, ...patch, operationId: job.operationId, canvasId: job.canvasId, packageHash: job.packageHash };
        this.db.prepare('UPDATE local_scene_package_jobs SET phase=?,payload=? WHERE operation_id=?').run(next.phase, JSON.stringify(next), id);
        this.remember(next);
        return next;
    }
    begin(id: string): InternalJob { const job = this.get(id); if (job?.error?.code === 'package-operation-expired')
        throw Error('package-operation-expired'); if (job?.phase === 'failed' && this.activeCount() >= 2)
        throw Error('package-import-busy'); if (!job || job.phase === 'ready' || job.phase === 'cancelled')
        throw Error('package-job-not-retryable'); const next = { ...job, phase: 'validating' as const, error: undefined, fence: job.fence + 1 }; this.db.prepare('UPDATE local_scene_package_jobs SET phase=?,payload=?,fence=? WHERE operation_id=?').run(next.phase, JSON.stringify(next), next.fence, id); this.remember(next); return next; }
    recover() { for (const r of this.db.prepare("SELECT operation_id FROM local_scene_package_jobs WHERE phase NOT IN ('ready','failed','cancelled')").all() as {
        operation_id: string;
    }[]) {
        const j = this.get(r.operation_id)!;
        this.db.prepare('UPDATE local_scene_package_jobs SET phase=?,payload=?,fence=fence+1 WHERE operation_id=?').run('failed', JSON.stringify({ ...j, phase: 'failed', error: { code: 'interrupted', message: '导入被中断，可重新选择文件重试', retryable: true } }), j.operationId);
        this.remember(this.get(j.operationId)!);
    } }
    cancel(id: string) { const j = this.get(id); if (!j)
        throw Error('package-job-not-found'); if (j.phase === 'committing' || j.phase === 'ready')
        return j; this.db.prepare('UPDATE local_scene_package_jobs SET phase=?,payload=?,fence=fence+1 WHERE operation_id=?').run('cancelled', JSON.stringify({ ...j, phase: 'cancelled' }), id); const next = this.get(id)!; this.remember(next); return next; }
    receipt(canvasId: string): ScenePackageImportReceipt | null { const r = this.db.prepare('SELECT receipt_json FROM local_scene_package_receipts WHERE canvas_id=? AND EXISTS(SELECT 1 FROM canvases WHERE id=canvas_id)').get(canvasId) as {
        receipt_json: string;
    } | undefined; return r ? JSON.parse(r.receipt_json) : null; }
    findReady(hash: string): ScenePackageImportReceipt | null { const r = this.db.prepare('SELECT receipt_json FROM local_scene_package_receipts WHERE package_hash=? AND EXISTS(SELECT 1 FROM canvases WHERE id=canvas_id) ORDER BY rowid DESC LIMIT 1').get(hash) as {
        receipt_json: string;
    } | undefined; return r ? JSON.parse(r.receipt_json) : null; }
    findContentReady(contentHash: string): ScenePackageImportReceipt | null {
        const rows = this.db.prepare('SELECT receipt_json FROM local_scene_package_receipts WHERE EXISTS(SELECT 1 FROM canvases WHERE id=canvas_id) ORDER BY rowid DESC').all() as {
            receipt_json: string;
        }[];
        for (const row of rows) {
            const receipt = JSON.parse(row.receipt_json) as ScenePackageImportReceipt;
            if (receipt.manifest.contentHash === contentHash)
                return receipt;
        }
        return null;
    }
    reuse(operationId: string, receipt: ScenePackageImportReceipt): InternalJob {
        const j = this.get(operationId);
        if (!j || !['uploaded', 'validating'].includes(j.phase))
            throw Error('stale-package-attempt');
        const next = { ...j, canvasId: receipt.canvasId, phase: 'ready' as const };
        this.db.prepare('UPDATE local_scene_package_jobs SET canvas_id=?,phase=?,payload=? WHERE operation_id=?').run(next.canvasId, next.phase, JSON.stringify(next), operationId);
        this.remember(next);
        return next;
    }
    async commit(id: string, fence: number, candidate: ServerCanvas, manifest: ScenePackageManifest): Promise<ScenePackageImportReceipt> {
        const now = new Date().toISOString();
        const parsed = parseCanvasAggregate(candidate, { now });
        if (!parsed.ok || parsed.canvas.document.nodes.length !== candidate.document.nodes.length || parsed.canvas.document.edges.length !== candidate.document.edges.length)
            throw Error('package-candidate-invalid');
        const canvas = { ...parsed.canvas, revision: 1 };
        const doc = serverCanvasToYDoc(canvas);
        let checkpoint: Uint8Array;
        try {
            checkpoint = encodeStateAsUpdate(doc);
        }
        finally {
            doc.destroy();
        }
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const j = this.get(id);
            if (!j || j.fence !== fence || j.phase === 'failed' || j.phase === 'cancelled' || j.phase === 'ready' || j.canvasId !== canvas.id)
                throw Error('stale-package-attempt');
            const receipt: ScenePackageImportReceipt = { canvasId: canvas.id, operationId: id, packageHash: j.packageHash, manifest, importedAt: now };
            this.db.prepare('INSERT INTO canvases(id,revision,title,canvas_json,created_at,updated_at) VALUES(?,1,?,?,?,?)').run(canvas.id, canvas.title ?? '', JSON.stringify(canvas), now, now);
            this.options.onWritePoint?.('canonical');
            this.db.prepare('INSERT INTO canvas_yjs_documents(canvas_id,format_version,room_epoch,snapshot,snapshot_seq,revision,projection_json,created_at,updated_at) VALUES(?,?,?,?,0,1,?,?,?)').run(canvas.id, YJS_CANVAS_FORMAT_VERSION, randomUUID(), checkpoint, JSON.stringify(canvas), now, now);
            this.options.onWritePoint?.('yjs');
            this.db.prepare('INSERT INTO local_scene_package_receipts VALUES(?,?,?)').run(canvas.id, j.packageHash, JSON.stringify(receipt));
            this.options.onWritePoint?.('receipt');
            this.update(id, { phase: 'ready', completedMedia: j.totalMedia }, fence);
            this.db.exec('COMMIT');
            return receipt;
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }
}
