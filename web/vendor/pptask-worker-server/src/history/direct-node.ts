import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  clone,
  page,
  type ExecutionHistoryRepository,
  type ExecutionHistoryStoredRecord,
} from './repository.js';

/** JSON-backed repository for local tools. It also reads the legacy array format. */
export function createJsonFileExecutionHistoryRepository<RECORD extends ExecutionHistoryStoredRecord>(
  path: string,
): ExecutionHistoryRepository<RECORD> {
  let loaded: Promise<Map<string, RECORD>> | undefined;
  let writeQueue = Promise.resolve();
  const load = async (): Promise<Map<string, RECORD>> => {
    if (!loaded) {
      loaded = readFile(path, 'utf8').then(raw => {
        const parsed = JSON.parse(raw) as unknown;
        const values = Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === 'object' && 'records' in parsed
            ? Object.values((parsed as { records?: unknown }).records ?? {})
            : [];
        return new Map((values as RECORD[]).map(record => [record.id, clone(record)]));
      }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
        throw error;
      });
    }
    return loaded;
  };
  const persist = async (records: Map<string, RECORD>): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    const data = { schemaVersion: 1, records: Object.fromEntries(records) };
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
  };
  const mutate = async <VALUE>(action: (records: Map<string, RECORD>) => VALUE): Promise<VALUE> => {
    const operation = writeQueue.then(async () => {
      const records = await load();
      const value = action(records);
      await persist(records);
      return value;
    });
    writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  };
  return {
    async get(id) {
      return clone((await load()).get(id));
    },
    async list(options) {
      return page([...((await load()).values())].map(clone), options);
    },
    async upsert(record) {
      await mutate(records => records.set(record.id, clone(record)));
    },
    async delete(id) {
      await mutate(records => records.delete(id));
    },
  };
}
