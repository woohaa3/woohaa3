import type { PptaskJobFilter, PptaskJobRecord } from '../core/types.ts';

export function matchesFilter(record: PptaskJobRecord, filter?: PptaskJobFilter): boolean {
  if (!filter) return true;
  if (filter.providerId && record.providerId !== filter.providerId) return false;
  if (filter.modelId && record.modelId !== filter.modelId) return false;
  if (filter.states && !filter.states.includes(record.state)) return false;
  return true;
}

export function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
