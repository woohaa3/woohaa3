import { describe, expect, it } from 'vitest';
import type { PptaskJobRecord } from '@sdppp/pptask';
import { createMemoryPptaskTaskStore } from '../src/memory-task-store.js';

function date(ms: number): Date {
  return new Date(ms);
}

function imageParams(input: unknown = { prompt: 'hi' }) {
  return { modelType: 'image' as const, modelId: 'demo', input };
}

describe('createMemoryPptaskTaskStore', () => {
  it('submits idempotently on key, starting in submitting state', async () => {
    const store = createMemoryPptaskTaskStore();
    const first = await store.submit({
      key: 'req-1', providerId: 'fake', params: imageParams(), context: { tenantId: 't1' }, ownerId: 'u1', now: date(1000),
    });
    expect(first.created).toBe(true);
    expect(first.record.status).toBe('submitting');
    expect(first.record.params).toEqual(imageParams());
    expect(first.record.context).toEqual({ tenantId: 't1' });
    expect(first.record.ownerId).toBe('u1');
    expect(first.record.attempt).toBe(0);

    const second = await store.submit({
      key: 'req-1', providerId: 'other', params: imageParams({ prompt: 'other' }), now: date(2000),
    });
    expect(second.created).toBe(false);
    expect(second.record.providerId).toBe('fake');
    expect(second.record.params).toEqual(imageParams());
    expect(second.record.createdAt).toEqual(date(1000));
  });

  it('adopts an existing execution as queued with its snapshot', async () => {
    const store = createMemoryPptaskTaskStore();
    const { record, created } = await store.submit({
      key: 'adopt-1', providerId: 'fake', state: { handler: 'banana', step: 2 }, now: date(1000),
    });
    expect(created).toBe(true);
    expect(record.status).toBe('queued');
    expect(record.state).toEqual({ handler: 'banana', step: 2 });
  });

  it('claims only due tasks, ordered by nextRunAt then createdAt', async () => {
    const store = createMemoryPptaskTaskStore();
    await store.submit({ key: 'future', providerId: 'fake', params: imageParams(), now: date(1000) });
    await store.submit({ key: 'immediate', providerId: 'fake', params: imageParams(), now: date(2000) });
    await store.submit({ key: 'early', providerId: 'fake', params: imageParams(), now: date(3000) });

    // `future` backs off far ahead, `early` has a near backoff target, and
    // `immediate` has none — an undefined nextRunAt sorts first.
    const future = await store.find('future');
    await store.save({ ...future!, nextRunAt: date(10_000) });
    const early = await store.find('early');
    await store.save({ ...early!, nextRunAt: date(4500) });

    const claimed = await store.claimDue({ now: date(5000), leaseUntil: date(6000) });
    expect(claimed?.key).toBe('immediate');
    expect(claimed?.status).toBe('executing');
    expect(claimed?.leaseUntil).toEqual(date(6000));
    expect(claimed?.attempt).toBe(1);
    expect(claimed?.claimToken).toBeTruthy();

    const second = await store.claimDue({ now: date(5000), leaseUntil: date(6000) });
    expect(second?.key).toBe('early');

    // `future` is not due yet.
    const third = await store.claimDue({ now: date(5000), leaseUntil: date(6000) });
    expect(third).toBeNull();
  });

  it('reclaims executing tasks after their lease expires', async () => {
    const store = createMemoryPptaskTaskStore();
    await store.submit({ key: 'job-1', providerId: 'fake', params: imageParams(), now: date(1000) });
    const claimed = await store.claimDue({ now: date(1000), leaseUntil: date(2000) });
    expect(claimed?.key).toBe('job-1');

    const leased = await store.claimDue({ now: date(1500), leaseUntil: date(2500) });
    expect(leased).toBeNull();

    const takeover = await store.claimDue({ now: date(2001), leaseUntil: date(3000) });
    expect(takeover?.key).toBe('job-1');
    expect(takeover?.attempt).toBe(2);
    expect(takeover?.claimToken).not.toEqual(claimed?.claimToken);
  });

  it('never claims the same record concurrently', async () => {
    const store = createMemoryPptaskTaskStore();
    for (let i = 0; i < 5; i += 1) {
      await store.submit({ key: `job-${i}`, providerId: 'fake', params: imageParams(), now: date(1000) });
    }
    const claims = await Promise.all([
      store.claimDue({ now: date(1000), leaseUntil: date(2000) }),
      store.claimDue({ now: date(1000), leaseUntil: date(2000) }),
      store.claimDue({ now: date(1000), leaseUntil: date(2000) }),
      store.claimDue({ now: date(1000), leaseUntil: date(2000) }),
      store.claimDue({ now: date(1000), leaseUntil: date(2000) }),
    ]);
    const keys = claims.map((claim) => claim?.key).sort();
    expect(keys).toEqual(['job-0', 'job-1', 'job-2', 'job-3', 'job-4']);
  });

  it('fences heartbeat and save with the claimToken', async () => {
    const store = createMemoryPptaskTaskStore();
    await store.submit({ key: 'job-1', providerId: 'fake', params: imageParams(), now: date(1000) });
    const claimed = await store.claimDue({ now: date(1000), leaseUntil: date(2000) });

    const renewed = await store.heartbeat({
      key: 'job-1',
      claimToken: claimed!.claimToken!,
      leaseUntil: date(3000),
      now: date(1500),
    });
    expect(renewed).toBe(true);

    const staleHeartbeat = await store.heartbeat({
      key: 'job-1',
      claimToken: 'stale-token',
      leaseUntil: date(4000),
      now: date(1600),
    });
    expect(staleHeartbeat).toBe(false);

    await store.save({ ...claimed!, claimToken: 'stale-token', consecutiveFailures: 99 });
    const afterStaleSave = await store.find('job-1');
    expect(afterStaleSave?.consecutiveFailures).toBe(0);
    expect(afterStaleSave?.leaseUntil).toEqual(date(3000));

    await store.save({ ...claimed!, status: 'completed' });
    const afterFreshSave = await store.find('job-1');
    expect(afterFreshSave?.status).toBe('completed');
  });

  it('cancel rotates the token and loses to terminal writes', async () => {
    const store = createMemoryPptaskTaskStore();
    await store.submit({ key: 'job-1', providerId: 'fake', params: imageParams(), now: date(1000) });
    const claimed = await store.claimDue({ now: date(1000), leaseUntil: date(2000) });

    const cancelled = await store.cancel('job-1', date(1500));
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.claimToken).not.toEqual(claimed!.claimToken);
    expect(cancelled?.leaseUntil).toBeUndefined();

    // The stale claimant's completion write is fenced out.
    await store.save({ ...claimed!, status: 'completed' });
    expect((await store.find('job-1'))?.status).toBe('cancelled');

    // Cancelling again keeps the terminal record untouched.
    const again = await store.cancel('job-1', date(1600));
    expect(again?.status).toBe('cancelled');
    expect(again?.claimToken).toEqual(cancelled!.claimToken);
  });

  it('pushes record changes to subscribers', async () => {
    const store = createMemoryPptaskTaskStore();
    expect(store.subscribe).toBeDefined();
    const seen: string[] = [];
    const unsubscribe = store.subscribe!((record) => seen.push(`${record.key}:${record.status}`));

    await store.submit({ key: 'job-1', providerId: 'fake', params: imageParams(), now: date(1000) });
    expect(seen).toEqual(['job-1:submitting']);
    unsubscribe();
    await store.cancel('job-1', date(1500));
    expect(seen).toEqual(['job-1:submitting']);
  });
});
