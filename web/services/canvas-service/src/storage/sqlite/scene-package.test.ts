import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { createEmptyWoohaa3ServerCanvas } from '@woohaa3/contracts';
import { SqliteCanvasRepository } from './index.js';
import { SqliteYjsRepository } from './yjs.js';
import { SqliteScenePackageStore } from './scene-package.js';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.reverse())
    fn(); cleanup.length = 0; });
function fixture(failPoint?: string) { const dir = mkdtempSync(path.join(tmpdir(), 'scene-import-')); const file = path.join(dir, 'canvas.sqlite'); const repo = new SqliteCanvasRepository({ path: file }); const yjs = new SqliteYjsRepository({ path: file }); const store = new SqliteScenePackageStore({ path: file, onWritePoint: p => { if (p === failPoint)
        throw Error('injected'); } }); cleanup.push(() => rmSync(dir, { recursive: true, force: true }), () => repo.close(), () => yjs.close(), () => store.close()); return { store, repo, yjs }; }
const manifest = { format: 'woohaa-scene', version: 1, datasetId: 'fixture', contentHash: 'a'.repeat(64), recipeVersion: '1', kind: 'text', title: 'fixture', views: { overview200: [], overview300: [], distant: [] }, media: [] } as const;
describe('local scene package transaction', () => {
    it('publishes canonical, Yjs checkpoint and receipt together; repeats reuse the operation', async () => { const { store, repo, yjs } = fixture(); const j = store.reserve('request', 'b'.repeat(64)); const c = createEmptyWoohaa3ServerCanvas(j.canvasId); c.document.nodes.push({ id: 'n', type: 'text', position: { x: 0, y: 0 } }); c.nodeData.n = { panelPrompt: 'text' }; const running = store.begin('request'); const receipt = await store.commit('request', running.fence, c, manifest as never); expect(receipt.canvasId).toBe(c.id); expect((await repo.getCanvas(c.id))?.document.nodes).toHaveLength(1); expect(await yjs.loadYjsState(c.id)).toBeTruthy(); expect(store.get('request')?.phase).toBe('ready'); expect(store.reserve('request', 'b'.repeat(64)).canvasId).toBe(c.id); expect(() => store.reserve('request', 'c'.repeat(64))).toThrow(/conflict/i); });
    it('rolls back all publication if receipt commit fails', async () => { const { store, repo } = fixture('receipt'); const j = store.reserve('broken', 'b'.repeat(64)); const running = store.begin('broken'); await expect(store.commit('broken', running.fence, createEmptyWoohaa3ServerCanvas(j.canvasId), manifest as never)).rejects.toThrow('injected'); expect(await repo.getCanvas(j.canvasId)).toBeNull(); expect(store.receipt(j.canvasId)).toBeNull(); });
    it('fences interrupted work and never resurrects a deleted target', async () => { const { store, repo } = fixture(); const j = store.reserve('old', 'b'.repeat(64)); const running = store.begin('old'); store.recover(); expect(store.get('old')?.phase).toBe('failed'); await expect(store.commit('old', running.fence, createEmptyWoohaa3ServerCanvas(j.canvasId), manifest as never)).rejects.toThrow(/stale/i); const next = store.begin('old'); await store.commit('old', next.fence, createEmptyWoohaa3ServerCanvas(j.canvasId), manifest as never); await repo.deleteCanvas(j.canvasId, 1); expect(store.findReady('b'.repeat(64))).toBeNull(); expect(store.receipt(j.canvasId)).toBeNull(); });
});
it('failed retries obey admission and bounded history retains operation identity', () => { const { store } = fixture(); store.reserve('retry', 'a'.repeat(64)); store.begin('retry'); store.update('retry', { phase: 'failed' }); store.reserve('active1', 'b'.repeat(64)); store.reserve('active2', 'c'.repeat(64)); expect(() => store.begin('retry')).toThrow(/busy/); store.cancel('active1'); store.cancel('active2'); for (let i = 0; i < 520; i++) {
    const j = store.reserve(`failed${i}`, 'd'.repeat(64));
    store.update(j.operationId, { phase: 'failed' });
} expect(store.get('failed0')?.error?.code).toBe('package-operation-expired'); expect(() => store.reserve('failed0', 'e'.repeat(64))).toThrow(/conflict/); });
