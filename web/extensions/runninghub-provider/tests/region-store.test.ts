import { describe, expect, it } from "vitest";
import type {
  ExtensionDocumentOperation,
  ExtensionDocumentStore,
  ExtensionDocumentValue
} from "@woohaa3/contracts";
import {
  createRunningHubRegionStore,
  RUNNINGHUB_REGION_DOCUMENT_KEY,
  runningHubKeyFingerprint
} from "../src/backend/region-store.js";

function fakeDocuments(options: { failWrites?: boolean; initial?: ExtensionDocumentValue } = {}): {
  store: ExtensionDocumentStore;
  read: () => ExtensionDocumentValue | undefined;
} {
  let value = options.initial;
  let revision = value === undefined ? 0 : 1;
  const store: ExtensionDocumentStore = {
    owner: () => "runninghub-provider",
    async get<T extends ExtensionDocumentValue = ExtensionDocumentValue>(key: string) {
      if (value === undefined) return { found: false as const };
      return {
        found: true as const,
        document: { key, value: value as T, revision, updatedAt: new Date(0).toISOString() }
      };
    },
    async batch(operations: readonly ExtensionDocumentOperation[]) {
      if (options.failWrites) throw new Error("write failed");
      for (const operation of operations) {
        if (operation.op === "delete") {
          value = undefined;
          revision += 1;
          continue;
        }
        value = operation.value;
        revision += 1;
      }
      return { ok: true as const, revisions: { [RUNNINGHUB_REGION_DOCUMENT_KEY]: revision } };
    },
    async scan() {
      return { entries: [], nextCursor: null };
    },
    async schemaVersion() {
      return 1;
    },
    async setSchemaVersion() {
      // no-op
    }
  };
  return { store, read: () => value };
}

describe("RunningHub 区域持久化", () => {
  it("保存后同 Key 复用，换 Key 不复用旧区域", async () => {
    const documents = fakeDocuments();
    const store = createRunningHubRegionStore({ documents: documents.store, now: () => 123 });
    expect(await store.save("key-a", "cn")).toBe(true);
    expect(await store.load("key-a")).toBe("cn");
    expect(await store.load("key-b")).toBeUndefined();

    const record = documents.read() as Record<string, unknown>;
    expect(record.region).toBe("cn");
    expect(record.detectedAt).toBe(123);
    expect(record.keyFingerprint).toBe(runningHubKeyFingerprint("key-a"));
    expect(JSON.stringify(record)).not.toContain("key-a");
  });

  it("旧 Key 的记录不会套到新 Key 上", async () => {
    const documents = fakeDocuments();
    const store = createRunningHubRegionStore({ documents: documents.store });
    await store.save("old", "cn");
    expect(await store.load("new")).toBeUndefined();

    const restarted = createRunningHubRegionStore({ documents: documents.store });
    expect(await restarted.load("new")).toBeUndefined();
    expect(await restarted.load("old")).toBe("cn");
  });

  it("清除 Key 后不恢复旧区域", async () => {
    const store = createRunningHubRegionStore();
    await store.save("key-a", "cn");
    expect(await store.load("")).toBeUndefined();
  });

  it("文档存储缺失时退化为进程内缓存", async () => {
    const store = createRunningHubRegionStore({ now: () => 1 });
    expect(await store.save("key-a", "ai")).toBe(true);
    expect(await store.load("key-a")).toBe("ai");
  });

  it("损坏或旧版文档被忽略", async () => {
    const invalidRecords: ExtensionDocumentValue[] = [
      { region: "cn", keyFingerprint: runningHubKeyFingerprint("key-a"), detectedAt: 1 },
      { schemaVersion: 2, region: "cn", keyFingerprint: runningHubKeyFingerprint("key-a"), detectedAt: 1 },
      { schemaVersion: 1, region: "mars", keyFingerprint: runningHubKeyFingerprint("key-a"), detectedAt: 1 },
      { schemaVersion: 1, region: "cn", keyFingerprint: "", detectedAt: 1 }
    ];
    for (const initial of invalidRecords) {
      const store = createRunningHubRegionStore({ documents: fakeDocuments({ initial }).store });
      expect(await store.load("key-a")).toBeUndefined();
    }
  });

  it("持久化写失败只降级为内存缓存，不影响本次使用", async () => {
    const documents = fakeDocuments({ failWrites: true });
    const store = createRunningHubRegionStore({ documents: documents.store });
    expect(await store.save("key-a", "cn")).toBe(false);
    expect(await store.load("key-a")).toBe("cn");
  });

  it("用 Key 摘要判断变化，不保存明文 Key", async () => {
    const fingerprint = runningHubKeyFingerprint("  key-a  ");
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).toBe(runningHubKeyFingerprint("key-a"));
    expect(fingerprint).not.toContain("key-a");
  });
});
