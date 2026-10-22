export type ExecutionHistoryStoredRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type ExecutionHistoryListOptions = {
  cursor?: string;
  limit?: number;
};

export type ExecutionHistoryPage<RECORD> = {
  records: RECORD[];
  nextCursor?: string;
};

/** Storage boundary for history projections and application execution records. */
export type ExecutionHistoryRepository<RECORD extends ExecutionHistoryStoredRecord> = {
  get(id: string): Promise<RECORD | undefined>;
  list(options?: ExecutionHistoryListOptions): Promise<ExecutionHistoryPage<RECORD>>;
  upsert(record: RECORD): Promise<void>;
  delete(id: string): Promise<void>;
};

export function createMemoryExecutionHistoryRepository<RECORD extends ExecutionHistoryStoredRecord>(
  initial: readonly RECORD[] = [],
): ExecutionHistoryRepository<RECORD> {
  const records = new Map(initial.map(record => [record.id, clone(record)]));
  return {
    async get(id) {
      return clone(records.get(id));
    },
    async list(options) {
      return page([...records.values()].map(clone), options);
    },
    async upsert(record) {
      records.set(record.id, clone(record));
    },
    async delete(id) {
      records.delete(id);
    },
  };
}

export function page<RECORD extends ExecutionHistoryStoredRecord>(
  records: readonly RECORD[],
  options: ExecutionHistoryListOptions = {},
): ExecutionHistoryPage<RECORD> {
  const sorted = [...records].sort((left, right) => (
    right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
  ));
  const start = options.cursor
    ? Math.max(0, sorted.findIndex(record => record.id === options.cursor) + 1)
    : 0;
  const limit = Math.max(1, options.limit ?? 100);
  const values = sorted.slice(start, start + limit);
  const last = values.at(-1);
  return {
    records: values,
    ...(last && start + values.length < sorted.length ? { nextCursor: last.id } : {}),
  };
}

export function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
