import { describe, expect, it } from 'vitest';
import { createMemoryPptaskTaskStore } from '../src/memory-task-store.js';
import { runTaskStoreConformance, createTaskStoreConformanceCases } from '../src/conformance/task-store.js';

describe('PptaskTaskStore conformance (memory implementation)', () => {
  const cases = createTaskStoreConformanceCases(() => createMemoryPptaskTaskStore());
  for (const testCase of cases) {
    it(testCase.name, async () => {
      await testCase.run(createMemoryPptaskTaskStore());
    });
  }

  it('sequential runner passes for the reference implementation', async () => {
    await expect(runTaskStoreConformance(() => createMemoryPptaskTaskStore())).resolves.toBeUndefined();
  });
});
