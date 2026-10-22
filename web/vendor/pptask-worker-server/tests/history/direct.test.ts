import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDirectExecutionHistory, type DirectExecutionRecord } from '../../src/history/direct.js';
import { createJsonFileExecutionHistoryRepository } from '../../src/history/direct-node.js';
import { createMemoryExecutionHistoryRepository, type ExecutionHistoryRepository } from '../../src/history/repository.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function repositoryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pptask-history-'));
  directories.push(directory);
  return join(directory, 'executions.json');
}

describe('direct execution history', () => {
  it('persists records and reloads them from the JSON repository', async () => {
    const path = await repositoryPath();
    const repository = createJsonFileExecutionHistoryRepository<DirectExecutionRecord>(path);
    const first = await createDirectExecutionHistory({ repository });
    const execution = first.start({ label: 'first run' });
    execution.setRunning();
    execution.succeed({ text: 'done' });
    await first.flush();

    const second = await createDirectExecutionHistory({
      repository: createJsonFileExecutionHistoryRepository<DirectExecutionRecord>(path),
    });
    expect(await second.list()).toMatchObject([{ label: 'first run', state: 'succeeded' }]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ schemaVersion: 1 });
  });

  it('loads legacy array files', async () => {
    const path = await repositoryPath();
    const now = new Date().toISOString();
    await writeFile(path, JSON.stringify([{
      id: 'legacy', label: 'legacy record', state: 'succeeded', events: [], createdAt: now, updatedAt: now, durationMs: 0,
    }]), 'utf8');

    const history = await createDirectExecutionHistory({
      repository: createJsonFileExecutionHistoryRepository<DirectExecutionRecord>(path),
    });
    expect(await history.get('legacy')).toMatchObject({ label: 'legacy record' });
  });

  it('reports repository failures from flush', async () => {
    const repository: ExecutionHistoryRepository<DirectExecutionRecord> = {
      get: async () => undefined,
      list: async () => ({ records: [] }),
      upsert: async () => { throw new Error('disk full'); },
      delete: async () => undefined,
    };
    const history = await createDirectExecutionHistory({ repository });
    history.start({ label: 'cannot save' });
    await expect(history.flush()).rejects.toThrow('disk full');
  });

  it('caps per-record events and pages repository records', async () => {
    const now = new Date().toISOString();
    const repository = createMemoryExecutionHistoryRepository<DirectExecutionRecord>([
      { id: 'older', state: 'succeeded', events: [], createdAt: '2020-01-01T00:00:00.000Z', updatedAt: now, durationMs: 0 },
      { id: 'newer', state: 'succeeded', events: [], createdAt: '2021-01-01T00:00:00.000Z', updatedAt: now, durationMs: 0 },
    ]);
    const firstPage = await repository.list({ limit: 1 });
    expect(firstPage.records[0].id).toBe('newer');
    expect((await repository.list({ limit: 1, cursor: firstPage.nextCursor })).records[0].id).toBe('older');

    const history = await createDirectExecutionHistory({ repository, maxEventsPerRecord: 2 });
    const execution = history.start();
    execution.event('one');
    execution.event('two');
    execution.event('three');
    expect(execution.snapshot().events.map(event => event.stage)).toEqual(['two', 'three']);
  });
});
