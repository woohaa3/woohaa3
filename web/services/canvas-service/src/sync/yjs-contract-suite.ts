/**
 * 可复用 Yjs adapter contract suite（任务 3.1 / 3.4）。
 *
 * 一个函数把「所有 Yjs 存储 adapter 必须一致的行为」表达成断言；in-memory、SQLite、
 * Mongo 实现都跑同一套测试，避免真实数据库各自漂移出不同的 CAS/幂等/压缩语义。
 *
 * 不是 vitest test 文件（不被 `*.test.ts` 匹配），由各 adapter 的测试 import。
 */
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { YJS_CANVAS_FORMAT_VERSION } from "@woohaa3/contracts/canvas-yjs";
import type { YjsCommandRecord, YjsDocumentRepository } from "./yjs-repository.js";

export type YjsContractSuiteApi = {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
  expect: <T>(actual: T) => ContractExpectation;
};

/** 断言面；`not` 用于否定断言，其余是 suite 实际用到的方法。 */
export type ContractExpectation = {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeNull(): void;
  toBeTruthy(): void;
  toBeUndefined(): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeLessThanOrEqual(expected: number): void;
  toMatchObject(expected: object): void;
  toContain(expected: unknown): void;
  not: {
    toBeNull(): void;
    toContain(expected: unknown): void;
    toBe(expected: unknown): void;
  };
  rejects: { toThrow(error?: unknown): Promise<void> };
};

export type YjsContractHarness = {
  /** 每次调用返回一个**互相隔离**的干净仓库。 */
  createRepository: () => Promise<YjsDocumentRepository> | YjsDocumentRepository;
  /**
   * 可选：验证 adapter 的「重启」语义（关闭后重开同一存储仍能读到数据）。
   * 不提供时跳过重启恢复测试。
   */
  reopen?: (repository: YjsDocumentRepository) => Promise<YjsDocumentRepository> | YjsDocumentRepository;
};

const NOW = "2026-09-23T00:00:00.000Z";
const CANVAS = "canvas-contract";

function emptyProjection(): ServerCanvas {
  return createEmptyWoohaa3ServerCanvas(CANVAS, NOW);
}

function command(overrides: Partial<YjsCommandRecord> = {}): YjsCommandRecord {
  return {
    commandId: "cmd-1",
    payloadHash: "a".repeat(64),
    revision: 1,
    changed: true,
    actorId: "actor",
    createdAt: NOW,
    ...overrides
  };
}

/** update 字节可以是任意内容（contract 层不解析 Yjs；真实 adapter 只存 bytes）。 */
function bytes(seed: number): Uint8Array {
  return new Uint8Array([seed, seed + 1, seed + 2]);
}

export async function seedDocument(
  repository: YjsDocumentRepository,
  options: { canvasId?: string; projection?: ServerCanvas } = {}
): Promise<void> {
  const canvasId = options.canvasId ?? CANVAS;
  await repository.createYjsDocument({
    canvasId,
    formatVersion: YJS_CANVAS_FORMAT_VERSION,
    roomEpoch: "epoch-1",
    checkpoint: bytes(0),
    projection: options.projection ?? emptyProjection(),
    revision: 0,
    createdAt: NOW
  });
}

export function registerYjsRepositoryContract(api: YjsContractSuiteApi, harness: YjsContractHarness): void {
  const { describe, it, expect } = api;

  describe("YjsDocumentRepository contract", () => {
    it("loadYjsState 对不存在的文档返回 null", async () => {
      const repository = await harness.createRepository();
      expect(await repository.loadYjsState("missing")).toBeNull();
    });

    it("createYjsDocument 后可加载 checkpoint、format 与 projection", async () => {
      const repository = await harness.createRepository();
      await seedDocument(repository);
      const state = await repository.loadYjsState(CANVAS);
      expect(state).not.toBeNull();
      if (!state) return;
      expect(state.formatVersion).toBe(YJS_CANVAS_FORMAT_VERSION);
      expect(state.roomEpoch).toBe("epoch-1");
      expect(state.storageSeq).toBe(0);
      expect(state.projection?.id).toBe(CANVAS);
    });

    it("commitYjsCommand 追加 update、推进 seq 并更新 projection", async () => {
      const repository = await harness.createRepository();
      await seedDocument(repository);
      const result = await repository.commitYjsCommand({
        canvasId: CANVAS,
        expectedStorageSeq: 0,
        update: bytes(1),
        revision: 1,
        updatedAt: NOW,
        projection: { ...emptyProjection(), revision: 1, title: "A" },
        command: command()
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.storageSeq).toBe(1);
      expect(result.duplicate).toBe(false);

      const state = await repository.loadYjsState(CANVAS);
      expect(state?.storageSeq).toBe(1);
      expect(state?.updates.length).toBe(1);
      expect(state?.updates[0].seq).toBe(1);
      expect(state?.projection?.title).toBe("A");
    });

    it("storageSeq 不匹配时拒绝（CAS）", async () => {
      const repository = await harness.createRepository();
      await seedDocument(repository);
      await repository.commitYjsCommand({
        canvasId: CANVAS,
        expectedStorageSeq: 0,
        update: bytes(1),
        revision: 1,
        updatedAt: NOW,
        projection: emptyProjection(),
        command: command()
      });
      const stale = await repository.commitYjsCommand({
        canvasId: CANVAS,
        expectedStorageSeq: 0,
        update: bytes(2),
        revision: 2,
        updatedAt: NOW,
        projection: emptyProjection(),
        command: command({ commandId: "cmd-2", payloadHash: "b".repeat(64) })
      });
      expect(stale.ok).toBe(false);
      if (stale.ok) return;
      expect(stale.code).toBe("storage-seq-conflict");
      expect(await repository.loadYjsState(CANVAS).then((state) => state?.storageSeq)).toBe(1);
    });

    it("相同 commandId + payload 重试返回首次结果且不重复追加", async () => {
      const repository = await harness.createRepository();
      await seedDocument(repository);
      const commit = {
        canvasId: CANVAS,
        expectedStorageSeq: 0,
        update: bytes(1),
        revision: 1,
        updatedAt: NOW,
        projection: emptyProjection(),
        command: command()
      };
      const first = await repository.commitYjsCommand(commit);
      // 响应丢失后重试：客户端带着**旧的** expectedStorageSeq。
      const retry = await repository.commitYjsCommand(commit);
      expect(first.ok).toBe(true);
      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.duplicate).toBe(true);
      expect(retry.revision).toBe(1);
      const state = await repository.loadYjsState(CANVAS);
      expect(state?.updates.length).toBe(1);
    });

    it("相同 commandId + 不同 payload 稳定拒绝", async () => {
      const repository = await harness.createRepository();
      await seedDocument(repository);
      await repository.commitYjsCommand({
        canvasId: CANVAS,
        expectedStorageSeq: 0,
        update: bytes(1),
        revision: 1,
        updatedAt: NOW,
        projection: emptyProjection(),
        command: command()
      });
      const reused = await repository.commitYjsCommand({
        canvasId: CANVAS,
        expectedStorageSeq: 1,
        update: bytes(2),
        revision: 2,
        updatedAt: NOW,
        projection: emptyProjection(),
        command: command({ payloadHash: "c".repeat(64) })
      });
      expect(reused.ok).toBe(false);
      if (reused.ok) return;
      expect(reused.code).toBe("command-id-reused");
    });

    it("getCommandRecord 返回已提交记录", async () => {
      const repository = await harness.createRepository();
      await seedDocument(repository);
      await repository.commitYjsCommand({
        canvasId: CANVAS,
        expectedStorageSeq: 0,
        update: bytes(1),
        revision: 4,
        updatedAt: NOW,
        projection: emptyProjection(),
        command: command({ revision: 4 })
      });
      const record = await repository.getCommandRecord(CANVAS, "cmd-1");
      expect(record?.revision).toBe(4);
      expect(await repository.getCommandRecord(CANVAS, "unknown")).toBeNull();
    });

    it("no-op 命令仍写幂等记录，但不影响 update 语义", async () => {
      const repository = await harness.createRepository();
      await seedDocument(repository);
      const result = await repository.commitYjsCommand({
        canvasId: CANVAS,
        expectedStorageSeq: 0,
        update: new Uint8Array(0),
        revision: 0,
        updatedAt: NOW,
        projection: emptyProjection(),
        command: command({ changed: false, revision: 0 })
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.revision).toBe(0);
      expect(await repository.getCommandRecord(CANVAS, "cmd-1")).not.toBeNull();
    });

    it("replaceCheckpoint 只删除 cutoff 内 updates，保留之后与幂等记录", async () => {
      const repository = await harness.createRepository();
      await seedDocument(repository);
      for (let index = 1; index <= 4; index += 1) {
        await repository.commitYjsCommand({
          canvasId: CANVAS,
          expectedStorageSeq: index - 1,
          update: bytes(index),
          revision: index,
          updatedAt: NOW,
          projection: emptyProjection(),
          command: command({ commandId: `cmd-${index}`, payloadHash: `${index}`.repeat(64).slice(0, 64) })
        });
      }
      await repository.replaceCheckpoint({
        canvasId: CANVAS,
        cutoffSeq: 2,
        checkpoint: bytes(9),
        updatedAt: NOW
      });
      const state = await repository.loadYjsState(CANVAS);
      expect(state?.checkpointSeq).toBe(2);
      // seq 3、4 保留。
      expect(state?.updates.map((entry) => entry.seq)).toEqual([3, 4]);
      // 幂等记录不随压缩删除。
      expect(await repository.getCommandRecord(CANVAS, "cmd-1")).not.toBeNull();
      expect(await repository.getCommandRecord(CANVAS, "cmd-4")).not.toBeNull();
      // storageSeq 不因压缩变化（恢复顺序与压缩解耦）。
      expect(state?.storageSeq).toBe(4);
    });

    it("deleteYjsDocument 清空文档与记录", async () => {
      const repository = await harness.createRepository();
      await seedDocument(repository);
      await repository.deleteYjsDocument(CANVAS);
      expect(await repository.loadYjsState(CANVAS)).toBeNull();
      expect(await repository.getCommandRecord(CANVAS, "cmd-1")).toBeNull();
    });

    it("health 报告稳定 backend id", async () => {
      const repository = await harness.createRepository();
      const health = await repository.health();
      expect(health.ok).toBe(true);
      expect(typeof health.backend).toBe("string");
    });

    if (harness.reopen) {
      it("重启后 checkpoint、updates、seq 与幂等记录保持", async () => {
        const first = await harness.createRepository();
        await seedDocument(first);
        const result = await first.commitYjsCommand({
          canvasId: CANVAS,
          expectedStorageSeq: 0,
          update: bytes(1),
          revision: 1,
          updatedAt: NOW,
          projection: { ...emptyProjection(), revision: 1 },
          command: command()
        });
        expect(result.ok).toBe(true);

        const reopened = await harness.reopen!(first);
        const state = await reopened.loadYjsState(CANVAS);
        expect(state?.storageSeq).toBe(1);
        expect(state?.updates.length).toBe(1);
        expect(await reopened.getCommandRecord(CANVAS, "cmd-1")).not.toBeNull();
      });
    }
  });
}
