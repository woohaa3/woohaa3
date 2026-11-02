import { expect, it, vi } from 'vitest';
import type { NativeImageResource } from '@woohaa3/contracts';
import { createNativeImagePort } from './native-client.js';

type Reply = { ok: boolean; value?: Record<string, unknown>; error?: string };

const ready: Reply = { ok: true, value: { status: 'ready', width: 4, height: 4, sourceWidth: 4, sourceHeight: 4 } };

function harness(register: (attempt: number) => Reply) {
  let attempts = 0;
  const request = vi.fn((path: string): Reply => {
    if (path.startsWith('image-register')) return register(++attempts);
    if (path.startsWith('image-poll')) return ready;
    return { ok: true, value: {} };
  });
  return { client: createNativeImagePort(request), attempts: () => attempts };
}

it('waits for a released lease and then registers instead of failing the node', async () => {
  const { client, attempts } = harness(attempt => attempt === 2
    ? { ok: false, error: 'native-image-lease-budget' }
    : { ok: true, value: { handle: `h${attempt}` } });
  const first = await client.prepareBytes(new Uint8Array([1]), 128);
  const second = client.prepareBytes(new Uint8Array([2]), 128);
  // prepareBytes 同步走到等 lease，此时释放第一个句柄即可唤醒重试。
  client.port.release(first.pixels as NativeImageResource);
  await expect(second).resolves.toMatchObject({ pixels: { handle: 'h3' } });
  expect(attempts()).toBe(3);
});

it('retries a full decode queue instead of surfacing it as a content failure', async () => {
  vi.useFakeTimers();
  try {
    const { client, attempts } = harness(attempt => attempt === 1
      ? { ok: false, error: 'native-image-busy' }
      : { ok: true, value: { handle: 'h1' } });
    const prepared = client.prepareBytes(new Uint8Array([1]), 128);
    await vi.advanceTimersByTimeAsync(60);
    await expect(prepared).resolves.toMatchObject({ pixels: { handle: 'h1' } });
    expect(attempts()).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

it('does not retry failures that belong to the content itself', async () => {
  const { client, attempts } = harness(() => ({ ok: false, error: 'variant-limit' }));
  await expect(client.prepareBytes(new Uint8Array([1]), 128)).rejects.toThrow('variant-limit');
  expect(attempts()).toBe(1);
});

it('cancels a lease wait when the caller aborts', async () => {
  const { client } = harness(attempt => attempt === 1
    ? { ok: true, value: { handle: 'h1' } }
    : { ok: false, error: 'native-image-lease-budget' });
  const first = await client.prepareBytes(new Uint8Array([1]), 128);
  const controller = new AbortController();
  const second = client.prepareBytes(new Uint8Array([2]), 128, controller.signal);
  controller.abort();
  await expect(second).rejects.toThrow('image-cancelled');
  client.port.release(first.pixels as NativeImageResource);
});
