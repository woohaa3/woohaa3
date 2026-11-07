import { afterEach, expect, it, vi } from 'vitest';
import { ImageWorkerPool } from './client.js';
import type { ImageReply } from './protocol.js';
class FakeWorker {
  onmessage: ((e: MessageEvent<ImageReply>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  sent: unknown[] = [];
  transferred: unknown[][] = [];
  terminate = vi.fn();
  postMessage(message: unknown, transfer?: unknown[]) { this.sent.push(message); this.transferred.push(transfer ?? []); }
  reply() {
    const job = this.sent[0] as { id: number; generation: number };
    this.onmessage?.({ data: { version: 2, ...job, ok: true, result: { width: 1, height: 1, sourceWidth: 1, sourceHeight: 1, pixels: new Uint8Array(4), memoryBytes: 65536 } } } as unknown as MessageEvent<ImageReply>);
  }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function setup(capacity = 2) {
  vi.stubGlobal('location', new URL('http://localhost/dev/test/'));
  const workers: FakeWorker[] = [];
  const pool = new ImageWorkerPool(capacity, () => { const w = new FakeWorker(); workers.push(w); return w as unknown as Worker; });
  return { pool, workers };
}
it('caps active instances and ignores duplicate or stale receipts', async () => {
  const {pool,workers} = setup();
  const a=pool.decode('/a',128), b=pool.decode('/b',128), c=pool.decode('/c',128);
  expect(workers).toHaveLength(2);
  workers[0].reply(); await a;
  expect(pool.diagnostics().active).toBe(2);
  // Duplicate a receipt must not complete c.
  workers[0].reply(); expect(pool.diagnostics().active).toBe(2);
  workers[1].reply(); await b;
  const request = workers[0].sent[1] as {id:number;generation:number};
  workers[0].sent=[request]; workers[0].reply(); await c;
  expect(pool.diagnostics().active).toBe(0);
  pool.dispose();
});
it('keeps cancelled running work draining until its real receipt', async () => {
  const {pool,workers}=setup(1); const controller=new AbortController();
  const a=pool.decode('/a',128,controller.signal).catch(e=>e.message);
  const b=pool.decode('/b',128);
  controller.abort();
  expect(pool.diagnostics()).toMatchObject({ active:1,queued:1 });
  workers[0].reply(); expect(await a).toBe('image-cancelled');
  expect(pool.diagnostics()).toMatchObject({active:1,queued:0});
  workers[0].sent=[workers[0].sent[2]]; workers[0].reply(); await b;
  pool.dispose();
});
it('terminates a timed-out instance before assigning replacement work', async () => {
  vi.useFakeTimers(); const {pool,workers}=setup(1);
  const a=pool.decode('/a',128).catch(e=>e.message); const b=pool.decode('/b',128);
  await vi.advanceTimersByTimeAsync(60000);
  expect(await a).toContain('超时'); expect(workers[0].terminate).toHaveBeenCalledOnce();
  expect(workers).toHaveLength(2); workers[1].reply(); await b;
  pool.dispose();
});
it('transfers page-read bytes into the worker instead of letting it fetch', async () => {
  const {pool,workers}=setup(1);
  const bytes = new Uint8Array([1,2,3,4]).buffer;
  const job = pool.decode('/a',128,undefined,false,undefined,bytes);
  const sent = workers[0].sent[0] as { bytes?: ArrayBuffer };
  expect(sent.bytes).toBe(bytes);
  // The buffer must move by transfer so the page keeps no second copy.
  expect(workers[0].transferred[0]).toEqual([bytes]);
  workers[0].reply(); await job;
  pool.dispose();
});
it('lets small tiers run more instances than the large-tier default', async () => {
  // Default instance cap is 4 while a 1024 tier still only fits 2 decode budgets.
  const {pool,workers}=setup(4);
  const jobs=[pool.decode('/a',128),pool.decode('/b',128),pool.decode('/c',128),pool.decode('/d',128)];
  expect(workers).toHaveLength(4);
  for (const worker of workers) worker.reply();
  await Promise.all(jobs);
  pool.dispose();
});
it('accepts a 4096-edge variant (top residency tier) and refuses anything above it', async () => {
  const {pool,workers}=setup(1);
  const ok = pool.decode('/a',4096);
  expect((workers[0].sent[0] as {maxEdge:number}).maxEdge).toBe(4096);
  workers[0].reply(); await ok;
  await expect(pool.decode('/b',4097)).rejects.toThrow('variant-limit');
  await expect(pool.decode('/c',0)).rejects.toThrow('variant-limit');
  pool.dispose();
});
it('forwards the 4096 tier to the decoder instead of clamping it back to 2048', async () => {
  const { prepareImageResource } = await import('./client.js');
  const { registerNativeImagePort } = await import('./native-port.js');
  const pixels = { kind: 'native-image', handle: 'h', generation: 1, width: 1, height: 1 };
  const prepare = vi.fn(async (_url: string, _edge: number) => ({ width: 1, height: 1, sourceWidth: 1, sourceHeight: 1, pixels }));
  const unregister = registerNativeImagePort({ prepare, apply: vi.fn(), release: vi.fn() } as never);
  try {
    // 不同 URL：`sharedPrepare` 按 url+edge 合并在途任务，别让两次调用互相合并。
    await prepareImageResource('/tier-4096', 4096);
    await prepareImageResource('/tier-8192', 8192);
    expect(prepare.mock.calls.map(call => call[1])).toEqual([4096, 4096]);
  } finally { unregister(); }
});
