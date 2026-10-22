import type { PptaskJobRecord } from '@sdppp/pptask';
import type { PptaskTaskRecord, PptaskTaskStore } from '../task-store/types.js';

export type PptaskTaskStoreCase = {
  name: string;
  run: (store: PptaskTaskStore) => Promise<void>;
};

function date(ms: number): Date {
  return new Date(ms);
}

function imageParams(input: unknown = { prompt: 'hi' }) {
  return { modelType: 'image' as const, modelId: 'demo', input };
}

function adoptRecord(key: string): PptaskJobRecord {
  const now = new Date(1000).toISOString();
  return {
    schemaVersion: 1,
    id: `job-${key}`,
    providerId: 'fake',
    modelType: 'image',
    modelId: 'demo',
    state: 'pending',
    input: { prompt: 'hi' },
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Framework-agnostic conformance cases for `PptaskTaskStore` implementations.
 * Each case receives a fresh store from `factory`. Database-backed stores
 * must pass every case — the scheduling layer relies on each guarantee:
 *
 * - submit/claimDue/save atomicity and fencing keep dedup and recovery sound
 * - lease expiry takeover is what revives tasks after a process crash
 * - stale-claimant rejection is what prevents double execution
 */
export function createTaskStoreConformanceCases(
  factory: () => PptaskTaskStore | Promise<PptaskTaskStore>,
): PptaskTaskStoreCase[] {
  return [
    {
      name: 'submit is idempotent on key and starts in submitting state',
      async run(store) {
        const first = await store.submit({ key: 'req-1', providerId: 'fake', params: imageParams(), ownerId: 'u1', context: { tenantId: 't1' }, now: date(1000) });
        if (!first.created) throw new Error('first submit must create');
        if (first.record.status !== 'submitting') throw new Error(`expected submitting, got ${first.record.status}`);
        if (first.record.params === undefined || first.record.context === undefined || first.record.ownerId !== 'u1') {
          throw new Error('submit must persist params, context and ownerId');
        }

        const second = await store.submit({ key: 'req-1', providerId: 'other', params: imageParams({ prompt: 'other' }), now: date(2000) });
        if (second.created) throw new Error('duplicate key must not create');
        if (second.record.providerId !== 'fake') throw new Error('duplicate submit must return the existing record');
        if (second.record.createdAt.getTime() !== date(1000).getTime()) throw new Error('duplicate submit must return the original record');
      },
    },
    {
      name: 'adopting an existing execution starts the task as queued',
      async run(store) {
        const { record } = await store.submit({
          key: 'adopt-1', providerId: 'fake', state: adoptRecord('adopt-1'), now: date(1000),
        });
        if (record.status !== 'queued') throw new Error(`expected queued, got ${record.status}`);
        if (record.state === undefined) throw new Error('adopted task must carry the engine state');
      },
    },
    {
      name: 'claims only due tasks, ordered by nextRunAt then createdAt',
      async run(store) {
        await store.submit({ key: 'future', providerId: 'fake', params: imageParams(), now: date(1000) });
        await store.submit({ key: 'immediate', providerId: 'fake', params: imageParams(), now: date(2000) });
        await store.submit({ key: 'early', providerId: 'fake', params: imageParams(), now: date(3000) });

        const future = await store.find('future');
        await store.save({ ...future!, nextRunAt: date(10_000) });
        const early = await store.find('early');
        await store.save({ ...early!, nextRunAt: date(4500) });

        const claimed = await store.claimDue({ now: date(5000), leaseUntil: date(6000) });
        if (claimed?.key !== 'immediate') throw new Error(`expected immediate, got ${claimed?.key ?? 'none'}`);
        if (claimed.status !== 'executing' || claimed.leaseUntil?.getTime() !== date(6000).getTime() || claimed.attempt !== 1) {
          throw new Error('claim must mark executing with lease and attempt');
        }
        if (!claimed.claimToken) throw new Error('claim must issue a claimToken');

        const second = await store.claimDue({ now: date(5000), leaseUntil: date(6000) });
        if (second?.key !== 'early') throw new Error(`expected early second, got ${second?.key ?? 'none'}`);

        const third = await store.claimDue({ now: date(5000), leaseUntil: date(6000) });
        if (third !== null) throw new Error('future task must not be claimed early');
      },
    },
    {
      name: 'nextWakeAt reports the earliest future deadline across retry and lease',
      async run(store) {
        await store.submit({ key: 'ready', providerId: 'fake', params: imageParams(), now: date(1000) });
        await store.submit({ key: 'later', providerId: 'fake', params: imageParams(), now: date(1000) });
        await store.submit({ key: 'sooner', providerId: 'fake', params: imageParams(), now: date(1000) });

        // No future deadlines yet: `nextWakeAt` must not invent one.
        if ((await store.nextWakeAt({ now: date(1000) })) !== null) {
          throw new Error('reachable work must not schedule a wake');
        }

        const later = await store.find('later');
        await store.save({ ...later!, nextRunAt: date(9000) });
        const sooner = await store.find('sooner');
        await store.save({ ...sooner!, nextRunAt: date(4000) });
        const due = await store.nextWakeAt({ now: date(1000) });
        if (due?.getTime() !== date(4000).getTime()) throw new Error(`expected 4000, got ${due?.toISOString()}`);

        // A delayed task that becomes due drops out of the future deadline set.
        if ((await store.nextWakeAt({ now: date(4000) }))?.getTime() !== date(9000).getTime()) {
          throw new Error('past deadlines must not be reported');
        }

        // An executing task contributes its lease deadline.
        await store.claimReady({ now: date(5000), leaseUntil: date(6000) });
        const withLease = await store.nextWakeAt({ now: date(5500) });
        if (withLease?.getTime() !== date(6000).getTime()) throw new Error(`expected lease 6000, got ${withLease?.toISOString()}`);
      },
    },
    {
      name: 'reclaims executing tasks after their lease expires',
      async run(store) {
        await store.submit({ key: 'job-1', providerId: 'fake', params: imageParams(), now: date(1000) });
        const claimed = await store.claimDue({ now: date(1000), leaseUntil: date(2000) });
        if (claimed === null) throw new Error('expected a claim');

        const leased = await store.claimDue({ now: date(1500), leaseUntil: date(2500) });
        if (leased !== null) throw new Error('unexpired lease must not be reclaimable');

        const takeover = await store.claimDue({ now: date(2001), leaseUntil: date(3000) });
        if (takeover?.key !== 'job-1' || takeover.attempt !== 2) throw new Error('expired lease must be reclaimable');
        if (takeover.claimToken === claimed!.claimToken) throw new Error('takeover must rotate the claimToken');
      },
    },
    {
      name: 'concurrent claims never return the same record',
      async run(store) {
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
        const expected = ['job-0', 'job-1', 'job-2', 'job-3', 'job-4'];
        if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new Error(`claims not disjoint: ${keys.join(',')}`);
      },
    },
    {
      name: 'heartbeat and save are fenced by the claimToken',
      async run(store) {
        await store.submit({ key: 'job-1', providerId: 'fake', params: imageParams(), now: date(1000) });
        const claimed = await store.claimDue({ now: date(1000), leaseUntil: date(2000) })!;

        const renewed = await store.heartbeat({ key: 'job-1', claimToken: claimed!.claimToken!, leaseUntil: date(3000), now: date(1500) });
        if (!renewed) throw new Error('fresh heartbeat must renew');

        const staleHeartbeat = await store.heartbeat({ key: 'job-1', claimToken: 'stale-token', leaseUntil: date(4000), now: date(1600) });
        if (staleHeartbeat) throw new Error('stale heartbeat must be rejected');

        await store.save({ ...claimed!, claimToken: 'stale-token', consecutiveFailures: 99 });
        const afterStaleSave = await store.find('job-1');
        if (afterStaleSave?.consecutiveFailures !== 0) throw new Error('stale save must be ignored');
        if (afterStaleSave?.leaseUntil?.getTime() !== date(3000).getTime()) throw new Error('stale save must not clobber the lease');

        await store.save({ ...claimed!, status: 'completed' });
        const afterFreshSave = await store.find('job-1');
        if (afterFreshSave?.status !== 'completed') throw new Error('fresh save must apply');
      },
    },
    {
      name: 'cancel rotates the token and loses to terminal writes',
      async run(store) {
        await store.submit({ key: 'job-1', providerId: 'fake', params: imageParams(), now: date(1000) });
        const claimed = await store.claimDue({ now: date(1000), leaseUntil: date(2000) })!;

        const cancelled = await store.cancel('job-1', date(1500));
        if (cancelled?.status !== 'cancelled') throw new Error('cancel must settle a non-terminal task');
        if (cancelled.claimToken === claimed!.claimToken) throw new Error('cancel must rotate the claimToken');
        if (cancelled.leaseUntil !== undefined) throw new Error('cancel must clear the lease');

        await store.save({ ...claimed!, status: 'completed' });
        if ((await store.find('job-1'))?.status !== 'cancelled') throw new Error('stale claimant must not override cancellation');

        const again = await store.cancel('job-1', date(1600));
        if (again?.status !== 'cancelled' || again.claimToken !== cancelled.claimToken) {
          throw new Error('cancel must be terminal-wins and idempotent');
        }
      },
    },
  ];
}

/** Sequential runner usable from any test framework as a single test body. */
export async function runTaskStoreConformance(
  factory: () => PptaskTaskStore | Promise<PptaskTaskStore>,
): Promise<void> {
  const failures: string[] = [];
  for (const testCase of createTaskStoreConformanceCases(factory)) {
    try {
      await testCase.run(await factory());
    } catch (error) {
      failures.push(`${testCase.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`task store conformance failed:\n- ${failures.join('\n- ')}`);
}

export type { PptaskTaskRecord, PptaskTaskStore };
