import { describe, expect, it } from "vitest";
import { createConnectionService } from "@woohaa3/agent-connections";
import { createInMemoryDocumentStore, createInMemorySecretStore } from "../../../../services/agent-connections/src/test-doubles.js";
import { sdkEngineForAdapter } from "../shared.js";

describe("旧 API 连接固定映射与部分升级重启", () => {
  it("三旧 HTTP 和原 SDK 连接各自保留，重启可重入，备份不包含 Key", async () => {
    const documents = createInMemoryDocumentStore(["sdk-agent"]).forExtension("sdk-agent")!;
    const secrets = createInMemorySecretStore();
    const create = () => createConnectionService({ documents, secrets });
    let service = create();
    const records = [];
    for (const adapterId of ["openai-responses", "anthropic-messages", "compat-chat", "codex-agent-sdk", "claude-agent-sdk"]) {
      const made = await service.create("owner", { adapterId, name: adapterId, runCategory: "http-sdk", authMode: "api-key", baseUrl: "https://legacy.example/v1", models: ["manual-model"] });
      if (!made.ok) throw new Error("create failed");
      await service.saveCredential({ owner: "owner", connectionId: made.value.connectionId, purpose: "model-api-key", secret: `private-${adapterId}` });
      records.push((await service.get("owner", made.value.connectionId))!);
    }
    const beforeSnapshot = await documents.scan("");
    const version = (adapterId: string) => { const engine = sdkEngineForAdapter(adapterId)!; return `${engine.engine}@${engine.version}:1`; };
    expect(records.slice(0, 3).map((record) => sdkEngineForAdapter(record.adapterId)?.engine)).toEqual(["codex-agent-sdk", "claude-agent-sdk", "dsh-agent-sdk"]);
    for (const record of records.slice(0, 2)) expect(await service.migrateRuntime!("owner", record.connectionId, version(record.adapterId), () => true)).toMatchObject({ ok: true, value: { changed: true } });
    service = create();
    for (const [index, record] of records.entries()) {
      const result = await service.migrateRuntime!("owner", record.connectionId, version(record.adapterId), () => true);
      expect(result).toMatchObject({ ok: true, value: { changed: index >= 2 } });
      expect(await service.get("owner", record.connectionId)).toMatchObject({ owner: record.owner, connectionId: record.connectionId, adapterId: record.adapterId, baseUrl: record.baseUrl, models: record.models, credentialEpoch: record.credentialEpoch, configRevision: record.configRevision + 1, runtimeVersion: version(record.adapterId) });
      expect(await service.readCredential({ owner: "owner", connectionId: record.connectionId, purpose: "model-api-key" })).toEqual({ secret: `private-${record.adapterId}` });
    }
    expect(await service.list("owner")).toHaveLength(5);
    expect(await service.list("other-owner")).toEqual([]);
    const backups = await documents.scan("runtime-migrations/");
    expect(backups.entries).toHaveLength(5);
    expect(JSON.stringify(backups)).not.toContain("private-");
    // Restore the paired document snapshot (including its pre-upgrade backup namespace).
    // Keys never changed during this fixture, so the paired secret snapshot is unchanged.
    const current = await documents.scan("");
    expect(await documents.batch(current.entries.map((entry) => {
      const before = beforeSnapshot.entries.find((candidate) => candidate.key === entry.key);
      return before ? { op: "set" as const, key: entry.key, value: before.value, expectedRevision: entry.revision } : { op: "delete" as const, key: entry.key, expectedRevision: entry.revision };
    }))).toMatchObject({ ok: true });
    service = create();
    for (const record of records) expect(await service.get("owner", record.connectionId)).toEqual(record);
    expect((await documents.scan("runtime-migrations/")).entries).toEqual([]);
    // Re-upgrade after restoring the complete matching snapshot is valid and still idempotent.
    expect(await service.migrateRuntime!("owner", records[0]!.connectionId, version(records[0]!.adapterId), () => true)).toMatchObject({ ok: true });

  });
});
