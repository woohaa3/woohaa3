/**
 * 测试替身：扩展文档存储与秘密仓库的内存实现
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 1.3/1.4 验收）。
 *
 * 只实现契约语义（CAS、owner 隔离、加密不适用于内存），供 `@woohaa3/agent-connections`
 * 单测独立验证；不是生产实现。
 */
import type {
  ApplicationExtensionSecretStore,
  ApplicationSecretReadResult,
  ApplicationSecretWriteResult,
  ExtensionDocument,
  ExtensionDocumentBatchResult,
  ExtensionDocumentOperation,
  ExtensionDocumentRead,
  ExtensionDocumentScanPage,
  ExtensionDocumentStore,
  ExtensionDocumentValue
} from "@woohaa3/contracts";

export function createInMemoryDocumentStore(owners: string[] = []): {
  forExtension(extensionId: string): ExtensionDocumentStore | null;
  owners: Set<string>;
} {
  const ownerSet = new Set(owners);
  const spaces = new Map<
    string,
    Map<string, { value: ExtensionDocumentValue; revision: number; updatedAt: string }>
  >();

  const spaceFor = (extensionId: string) => {
    let space = spaces.get(extensionId);
    if (!space) {
      space = new Map();
      spaces.set(extensionId, space);
    }
    return space;
  };

  const storeFor = (extensionId: string): ExtensionDocumentStore => ({
    owner: () => extensionId,
    get: async <T extends ExtensionDocumentValue = ExtensionDocumentValue>(key: string): Promise<ExtensionDocumentRead<T>> => {
      const entry = spaceFor(extensionId).get(key);
      if (!entry) return { found: false };
      const document: ExtensionDocument<T> = { key, value: entry.value as T, revision: entry.revision, updatedAt: entry.updatedAt };
      return { found: true, document };
    },
    batch: async (operations: readonly ExtensionDocumentOperation[]): Promise<ExtensionDocumentBatchResult> => {
      const space = spaceFor(extensionId);
      // 先整体校验，再提交（全成或全不成）。
      const staged: Array<{ key: string; value?: ExtensionDocumentValue; revision: number }> = [];
      for (const operation of operations) {
        const current = space.get(operation.key);
        if (operation.expectedRevision !== undefined) {
          const currentRevision = current?.revision ?? null;
          if (operation.expectedRevision !== currentRevision) {
            return { ok: false, code: "revision-conflict", key: operation.key, currentRevision };
          }
        }
        if (operation.op === "set") {
          staged.push({ key: operation.key, value: operation.value, revision: (current?.revision ?? 0) + 1 });
        } else {
          staged.push({ key: operation.key, revision: 0 });
        }
      }
      const revisions: Record<string, number | null> = {};
      for (const entry of staged) {
        if (entry.value === undefined && !space.has(entry.key)) {
          revisions[entry.key] = null;
          continue;
        }
        if (entry.value === undefined) {
          space.delete(entry.key);
          revisions[entry.key] = null;
        } else {
          space.set(entry.key, { value: entry.value, revision: entry.revision, updatedAt: new Date().toISOString() });
          revisions[entry.key] = entry.revision;
        }
      }
      return { ok: true, revisions };
    },
    scan: async (prefix: string, options?: { cursor?: string; limit?: number }): Promise<ExtensionDocumentScanPage> => {
      const all = [...spaceFor(extensionId).entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
      const start = options?.cursor ? all.findIndex(([key]) => key > options.cursor!) : 0;
      const slice = all.slice(Math.max(start, 0), Math.max(start, 0) + (options?.limit ?? all.length));
      return {
        entries: slice.map(([key, entry]) => ({ key, value: entry.value, revision: entry.revision, updatedAt: entry.updatedAt })),
        nextCursor: null
      };
    },
    schemaVersion: async () => 0,
    setSchemaVersion: async () => {}
  });

  return {
    owners: ownerSet,
    forExtension(extensionId) {
      if (!ownerSet.has(extensionId)) return null;
      return storeFor(extensionId);
    }
  };
}

export function createInMemorySecretStore(initialEpoch: (owner: string) => number = () => 1): ApplicationExtensionSecretStore {
  const records = new Map<string, { value: unknown; version: number }>();
  const epochs = new Map<string, number>();
  const key = (owner: string, purpose: string) => `${owner}\u0000${purpose}`;
  const epochFor = (owner: string) => {
    if (!epochs.has(owner)) epochs.set(owner, initialEpoch(owner));
    return epochs.get(owner)!;
  };
  return {
    read: <T>(owner: string, purpose: string): ApplicationSecretReadResult<T> => {
      const entry = records.get(key(owner, purpose));
      if (!entry) return null;
      return { value: entry.value as T, version: entry.version };
    },
    write: <T>(owner: string, purpose: string, record: T, precondition: import("@woohaa3/contracts").ApplicationSecretWritePrecondition): ApplicationSecretWriteResult => {
      const current = records.get(key(owner, purpose)) ?? { value: undefined, version: 0 };
      if (precondition.version !== current.version) {
        return { ok: false, code: "version-conflict", message: "版本不匹配" };
      }
      if (precondition.epoch !== undefined && precondition.epoch !== epochFor(owner)) {
        return { ok: false, code: "epoch-invalid", message: "授权 epoch 已变化" };
      }
      const nextVersion = current.version + 1;
      records.set(key(owner, purpose), { value: record, version: nextVersion });
      return { ok: true, version: nextVersion };
    },
    clear: (owner: string, purpose: string) => {
      records.delete(key(owner, purpose));
    },
    epoch: (owner: string) => epochFor(owner),
    bumpEpoch: (owner: string) => {
      const next = epochFor(owner) + 1;
      epochs.set(owner, next);
      return next;
    },
    refresh: {
      run: async <T>(_owner: string, _key: string, task: () => Promise<T>) => task()
    }
  };
}
