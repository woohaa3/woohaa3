import { describe, expect, it } from 'vitest';
import { createMemoryJobRepository, type PptaskJobRecord } from '../../src/index.ts';
import { createFakeProvider } from '../support/fake-provider.ts';

describe('Pptask jobs', () => {
  it('starts, polls, and completes an asynchronous model', async () => {
    const { provider, controller } = createFakeProvider();
    const model = provider.imageModel('demo');
    const handle = await provider.jobs.start<{ images: Uint8Array[] }>({
      model,
      input: { prompt: 'hello', n: 1, providerOptions: {} },
    });

    expect((await handle.status()).state).toBe('running');
    const result = await handle.wait();

    expect(result.images[0]).toEqual(new Uint8Array([1, 2, 3]));
    expect(controller.starts).toBe(1);
    expect(controller.statuses).toBe(2);
  });

  it('resumes from the same store without creating the remote operation again', async () => {
    const store = createMemoryJobRepository();
    const controller = { starts: 0, statuses: 0, cancels: 0, completeAfter: 2, statusErrors: 0 };
    const first = createFakeProvider({ store, controller }).provider;
    const handle = await first.jobs.start({
      model: first.imageModel('recoverable'),
      input: { prompt: 'persist me', n: 1, providerOptions: {} },
    });

    const second = createFakeProvider({ store, controller }).provider;
    const restored = await second.jobs.resume<{ images: Uint8Array[] }>(handle.id);
    const result = await restored.wait();

    expect(result.images[0]).toEqual(new Uint8Array([1, 2, 3]));
    expect(controller.starts).toBe(1);
  });

  it('retries transient status errors while waiting', async () => {
    const controller = {
      starts: 0,
      statuses: 0,
      cancels: 0,
      completeAfter: 3,
      statusErrors: 1,
    };
    const { provider } = createFakeProvider({ controller });
    const job = await provider.jobs.start<{ images: Uint8Array[] }>({
      model: provider.imageModel('retry-status'),
      input: { prompt: 'hello', n: 1, providerOptions: {} },
    });

    await expect(job.wait()).resolves.toMatchObject({ images: [new Uint8Array([1, 2, 3])] });
    expect(controller.statuses).toBe(3);
  });

  it('cancels a remote operation and persists cancellation', async () => {
    const { provider, controller } = createFakeProvider();
    const job = await provider.jobs.start({
      model: provider.imageModel('cancel-me'),
      input: { prompt: 'hello', n: 1, providerOptions: {} },
    });

    await job.cancel();

    expect(controller.cancels).toBe(1);
    expect((await job.status()).state).toBe('cancelled');
  });

  it('does not persist request controls or credentials', async () => {
    const store = createMemoryJobRepository();
    const { provider } = createFakeProvider({ store });
    const job = await provider.jobs.start({
      model: provider.imageModel('secure'),
      input: {
        prompt: 'hello',
        apiKey: 'secret',
        headers: { authorization: 'Bearer secret' },
        providerOptions: { fake: { accessToken: 'secret', style: 'plain' } },
      },
    });
    const record = await store.get(job.id);

    expect(record?.input).toEqual({
      prompt: 'hello',
      providerOptions: { fake: { style: 'plain' } },
    });
  });

  it('preserves shared non-circular input references', async () => {
    const store = createMemoryJobRepository();
    const { provider } = createFakeProvider({ store });
    const shared = { style: 'plain' };
    const job = await provider.jobs.start({
      model: provider.imageModel('shared-input'),
      input: { first: shared, second: shared },
    });

    expect((await store.get(job.id))?.input).toEqual({ first: shared, second: shared });
  });

  it('retries a creating record after rehydration', async () => {
    const store = createMemoryJobRepository();
    const now = new Date().toISOString();
    const record: PptaskJobRecord = {
      schemaVersion: 1,
      id: 'job-retry',
      providerId: 'fake',
      modelType: 'image',
      modelId: 'demo',
      state: 'creating',
      input: { prompt: 'retry', n: 1, providerOptions: {} },
      createdAt: now,
      updatedAt: now,
    };
    await store.put(record);
    const { provider, controller } = createFakeProvider({ store });

    await provider.jobs.resume(record.id).then(handle => handle.wait());

    expect(controller.starts).toBe(1);
    expect((await store.get(record.id))?.state).toBe('succeeded');
  });

  it('deduplicates concurrent recovery of a creating record', async () => {
    const store = createMemoryJobRepository();
    const now = new Date().toISOString();
    await store.put({
      schemaVersion: 1,
      id: 'job-concurrent-create',
      providerId: 'fake',
      modelType: 'image',
      modelId: 'demo',
      state: 'creating',
      input: { prompt: 'retry', n: 1, providerOptions: {} },
      createdAt: now,
      updatedAt: now,
    });
    const controller = { starts: 0, statuses: 0, cancels: 0, completeAfter: 1, statusErrors: 0 };
    const { provider } = createFakeProvider({ store, controller });
    const [first, second] = await Promise.all([
      provider.jobs.status('job-concurrent-create'),
      provider.jobs.status('job-concurrent-create'),
    ]);

    expect(controller.starts).toBe(1);
    expect(first.state).toBe('succeeded');
    expect(second.state).toBe('succeeded');
  });

  it('creates an independent job for every start call', async () => {
    const store = createMemoryJobRepository();
    const { provider, controller } = createFakeProvider({ store });
    const model = provider.imageModel('independent');
    const first = await provider.jobs.start({ model, input: { prompt: 'first' } });
    const second = await provider.jobs.start({ model, input: { prompt: 'second' } });

    expect(second.id).not.toBe(first.id);
    expect(controller.starts).toBe(2);
    expect((await store.get(first.id))?.input).toEqual({ prompt: 'first' });
    expect((await store.get(second.id))?.input).toEqual({ prompt: 'second' });
  });
});
