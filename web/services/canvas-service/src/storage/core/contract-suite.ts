/**
 * 可复用的 adapter contract suite（任务 2.4 / 任务 1.3）。
 *
 * 一个函数把「所有 adapter 必须一致的画布存储行为」表达成断言，SQLite、Mongo 与
 * in-memory 实现都用它跑同一套测试。这样两个真实数据库不会各自漂移出不同的 CAS 或
 * 幂等语义。
 *
 * 它不是 vitest 的 test 文件（不被 `*.test.ts` 匹配），而是被各 adapter 的测试 import 的
 * 普通模块；调用方传入 `describe/it/expect`，因此不绑定具体测试框架运行时。
 */
import type { ServerCanvas } from "@woohaa3/contracts";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { CanvasApplicationService } from "./application-service.js";
import { canvasStorageErrorCode, type CanvasStorageErrorCode } from "./errors.js";
import type { CanvasRepository } from "./contracts.js";
import { DEFAULT_CANVAS_STORAGE_LIMITS } from "./application-service.js";

/** 最小测试框架契约（vitest 的 describe/it/expect 满足它）。 */
export type ContractSuiteApi = {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
  expect: <T>(actual: T) => {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeNull(): void;
    toBeTruthy(): void;
    toBeUndefined(): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toMatchObject(expected: object): void;
    toContain(expected: unknown): void;
    rejects: {
      toThrow(error?: unknown): Promise<void>;
    };
  };
};

export type AdapterContractHarness = {
  /** 每个 `it` 前调用，返回一个干净仓库。 */
  createRepository: () => Promise<CanvasRepository> | CanvasRepository;
  /** 在运行套件前建立应用服务（注入仓库与可选媒体存储）。 */
  createService?: (repository: CanvasRepository) => CanvasApplicationService;
};

const ACTOR = "actor-contract";
const NOW = "2026-09-23T00:00:00.000Z";

/**
 * 注册全套 contract 断言。`harness.createRepository` 必须在每次调用返回**互相隔离**的
 * 仓库（真实数据库实现通常每个测试用独立临时库）。
 */
export function registerCanvasRepositoryContract(
  api: ContractSuiteApi,
  harness: AdapterContractHarness
): void {
  const { describe, it, expect } = api;
  const makeService = (repository: CanvasRepository) =>
    harness.createService
      ? harness.createService(repository)
      : new CanvasApplicationService({ repository, now: () => NOW });

  describe("CanvasRepository contract", () => {
    it("creates a canvas at revision 1 and reads it back", async () => {
      const repository = await harness.createRepository();
      const service = makeService(repository);
      const created = await service.createCanvas({ canvasId: "canvas-a", title: "A" });
      expect(created.id).toBe("canvas-a");
      expect(created.revision).toBe(1);
      expect(created.document.schemaVersion).toBe("asset-canvas-v1");

      const loaded = await service.getCanvas("canvas-a");
      expect(loaded.revision).toBe(1);
      expect(loaded.title).toBe("A");
    });

    it("rejects duplicate create without overwriting", async () => {
      const repository = await harness.createRepository();
      const service = makeService(repository);
      await service.createCanvas({ canvasId: "canvas-a", title: "first" });
      await expectError(
        () => service.createCanvas({ canvasId: "canvas-a", title: "second" }),
        expect,
        "CANVAS_ALREADY_EXISTS"
      );
      const loaded = await service.getCanvas("canvas-a");
      expect(loaded.title).toBe("first");
    });

    it("returns not-found instead of an empty canvas", async () => {
      const repository = await harness.createRepository();
      const service = makeService(repository);
      await expectError(() => service.getCanvas("missing"), expect, "CANVAS_NOT_FOUND");
    });

    it("increments revision exactly once per command batch", async () => {
      const repository = await harness.createRepository();
      const service = makeService(repository);
      await service.createCanvas({ canvasId: "canvas-a" });
      const result = await service.commitCommands({
        canvasId: "canvas-a",
        expectedRevision: 1,
        operationId: "op-1",
        actorId: ACTOR,
        commands: [
          { type: "node.add", node: { id: "node-1", type: "image", position: { x: 0, y: 0 } } }
        ]
      });
      expect(result.revision).toBe(2);
      expect(result.duplicate).toBe(false);
      expect(result.canvas.document.nodes.length).toBe(1);
    });

    it("applies a batch atomically across node/asset/job fields", async () => {
      const repository = await harness.createRepository();
      const service = makeService(repository);
      await service.createCanvas({ canvasId: "canvas-a" });
      const result = await service.commitCommands({
        canvasId: "canvas-a",
        expectedRevision: 1,
        operationId: "op-multi",
        actorId: ACTOR,
        commands: [
          { type: "node.add", node: { id: "node-1", type: "image", position: { x: 0, y: 0 } } },
          { type: "nodeData.patch", nodeId: "node-1", value: { title: "n1" } },
          {
            type: "asset.upsert",
            asset: {
              id: "asset-1",
              title: "generated",
              mediaKind: "text",
              source: "generated",
              status: "ready",
              text: "hello",
              createdAt: NOW
            }
          },
          { type: "job.upsert", job: { id: "job-1", nodeId: "node-1", taskId: "task-1", status: "success", updatedAt: NOW } }
        ]
      });
      expect(result.revision).toBe(2);
      expect(result.canvas.assets.length).toBe(1);
      expect(result.canvas.jobs.length).toBe(1);
      expect(result.canvas.nodeData["node-1"]).toMatchObject({ title: "n1" });
    });

    it("rejects a batch whose later command is invalid, leaving no partial state", async () => {
      const repository = await harness.createRepository();
      const service = makeService(repository);
      await service.createCanvas({ canvasId: "canvas-a" });
      await expectError(
        () =>
          service.commitCommands({
            canvasId: "canvas-a",
            expectedRevision: 1,
            operationId: "op-bad",
            actorId: ACTOR,
            commands: [
              { type: "node.add", node: { id: "node-1", type: "image", position: { x: 0, y: 0 } } },
              { type: "edge.add", edge: { source: "node-1", target: "missing-node" } }
            ]
          }),
        expect,
        "COMMAND_REJECTED"
      );
      const loaded = await service.getCanvas("canvas-a");
      expect(loaded.revision).toBe(1);
      expect(loaded.document.nodes.length).toBe(0);
    });

    it("returns the first result for a duplicate operationId without re-applying", async () => {
      const repository = await harness.createRepository();
      const service = makeService(repository);
      await service.createCanvas({ canvasId: "canvas-a" });
      const batch = {
        canvasId: "canvas-a",
        expectedRevision: 1,
        operationId: "op-retry",
        actorId: ACTOR,
        commands: [
          { type: "node.add", node: { id: "node-1", type: "image", position: { x: 0, y: 0 } } }
        ]
      };
      const first = await service.commitCommands(batch);
      // 响应丢失后用同一 operationId 与 payload 重试：即使其后另有提交，也必须返回首次结果。
      await service.commitCommands({
        canvasId: "canvas-a",
        expectedRevision: 2,
        operationId: "op-after",
        actorId: ACTOR,
        commands: [{ type: "canvas.setTitle", title: "later" }]
      });
      const retry = await service.commitCommands(batch);
      expect(first.revision).toBe(2);
      expect(retry.revision).toBe(2);
      expect(retry.duplicate).toBe(true);
      expect(retry.canvas.title).toBe(first.canvas.title);
      const loaded = await service.getCanvas("canvas-a");
      // 其后提交仍然生效，证明幂等重试没有回滚或覆盖。
      expect(loaded.revision).toBe(3);
      expect(loaded.title).toBe("later");
      expect(loaded.document.nodes.length).toBe(1);
    });

    it("allows the same operationId on a different canvas", async () => {
      const repository = await harness.createRepository();
      const service = makeService(repository);
      await service.createCanvas({ canvasId: "canvas-a" });
      await service.createCanvas({ canvasId: "canvas-b" });
      const command = [
        { type: "node.add", node: { id: "node-1", type: "text", position: { x: 0, y: 0 } } }
      ];
      await service.commitCommands({ canvasId: "canvas-a", expectedRevision: 1, operationId: "shared-op", actorId: ACTOR, commands: command });
      const b = await service.commitCommands({ canvasId: "canvas-b", expectedRevision: 1, operationId: "shared-op", actorId: ACTOR, commands: command });
      expect(b.duplicate).toBe(false);
      expect(b.revision).toBe(2);
    });

    it("detects a concurrent revision conflict without applying commands", async () => {
      const repository = await harness.createRepository();
      const service = makeService(repository);
      await service.createCanvas({ canvasId: "canvas-a" });
      await service.commitCommands({
        canvasId: "canvas-a",
        expectedRevision: 1,
        operationId: "op-1",
        actorId: ACTOR,
        commands: [{ type: "node.add", node: { id: "node-1", type: "image", position: { x: 0, y: 0 } } }]
      });
      await expectError(
        () =>
          service.commitCommands({
            canvasId: "canvas-a",
            expectedRevision: 1,
            operationId: "op-stale",
            actorId: ACTOR,
            commands: [{ type: "node.add", node: { id: "node-2", type: "image", position: { x: 10, y: 10 } } }]
          }),
        expect,
        "REVISION_CONFLICT"
      );
      const loaded = await service.getCanvas("canvas-a");
      expect(loaded.revision).toBe(2);
      expect(loaded.document.nodes.map((node) => node.id)).toEqual(["node-1"]);
    });

    it("records an idempotent result for a no-op batch without bumping revision", async () => {
      const repository = await harness.createRepository();
      const service = makeService(repository);
      await service.createCanvas({ canvasId: "canvas-a" });
      await service.commitCommands({
        canvasId: "canvas-a",
        expectedRevision: 1,
        operationId: "op-title",
        actorId: ACTOR,
        commands: [{ type: "canvas.setTitle", title: "A" }]
      });
      const result = await service.commitCommands({
        canvasId: "canvas-a",
        expectedRevision: 2,
        operationId: "op-noop",
        actorId: ACTOR,
        commands: [{ type: "canvas.setTitle", title: "A" }]
      });
      expect(result.revision).toBe(2);
      // 无净变化：重复 retry 返回同一 revision。
      const retry = await service.commitCommands({
        canvasId: "canvas-a",
        expectedRevision: 2,
        operationId: "op-noop",
        actorId: ACTOR,
        commands: [{ type: "canvas.setTitle", title: "A" }]
      });
      expect(retry.revision).toBe(2);
      expect(retry.duplicate).toBe(true);
    });

    it("lists canvases with stable ordering and pagination", async () => {
      const repository = await harness.createRepository();
      const service = makeService(repository);
      await service.createCanvas({ canvasId: "canvas-b", title: "B" });
      await service.createCanvas({ canvasId: "canvas-a", title: "A" });
      await service.createCanvas({ canvasId: "canvas-c", title: "C" });
      const page = await service.listCanvases({ offset: 0, limit: 2 });
      expect(page.total).toBe(3);
      expect(page.items.length).toBe(2);
      // updatedAt 相同 → 以 id 升序稳定排序。
      expect(page.items.map((item) => item.id)).toEqual(["canvas-a", "canvas-b"]);
      const second = await service.listCanvases({ offset: 2, limit: 2 });
      expect(second.items.map((item) => item.id)).toEqual(["canvas-c"]);
    });

    it("deletes a canvas with the matching revision and removes its operations", async () => {
      const repository = await harness.createRepository();
      const service = makeService(repository);
      await service.createCanvas({ canvasId: "canvas-a" });
      await service.commitCommands({
        canvasId: "canvas-a",
        expectedRevision: 1,
        operationId: "op-1",
        actorId: ACTOR,
        commands: [{ type: "node.add", node: { id: "node-1", type: "image", position: { x: 0, y: 0 } } }]
      });
      await service.deleteCanvas("canvas-a", 2);
      await expectError(() => service.getCanvas("canvas-a"), expect, "CANVAS_NOT_FOUND");
      // 同一 operationId 在删除后于新建画布上可再次使用（证明 operation 记录已清理）。
      await service.createCanvas({ canvasId: "canvas-a" });
      const reused = await service.commitCommands({
        canvasId: "canvas-a",
        expectedRevision: 1,
        operationId: "op-1",
        actorId: ACTOR,
        commands: [{ type: "node.add", node: { id: "node-9", type: "text", position: { x: 0, y: 0 } } }]
      });
      expect(reused.duplicate).toBe(false);
    });

    it("rejects delete with a stale revision", async () => {
      const repository = await harness.createRepository();
      const service = makeService(repository);
      await service.createCanvas({ canvasId: "canvas-a" });
      await expectError(() => service.deleteCanvas("canvas-a", 0), expect, "REVISION_CONFLICT");
    });

    it("reports health with a stable backend id", async () => {
      const repository = await harness.createRepository();
      const health = await repository.health();
      expect(health.ok).toBe(true);
      expect(typeof health.backend).toBe("string");
    });

    it("enforces the configured command-count limit before hitting the adapter", async () => {
      const repository = await harness.createRepository();
      const service = new CanvasApplicationService({
        repository,
        now: () => NOW,
        limits: { maxCommands: 1 }
      });
      await service.createCanvas({ canvasId: "canvas-a" });
      await expectError(
        () =>
          service.commitCommands({
            canvasId: "canvas-a",
            expectedRevision: 1,
            operationId: "op-limit",
            actorId: ACTOR,
            commands: [
              { type: "node.add", node: { id: "node-1", type: "image", position: { x: 0, y: 0 } } },
              { type: "node.add", node: { id: "node-2", type: "image", position: { x: 10, y: 0 } } }
            ]
          }),
        expect,
        "LIMIT_EXCEEDED"
      );
    });

    it("keeps default limits generous relative to the fixture baseline", () => {
      expect(DEFAULT_CANVAS_STORAGE_LIMITS.maxCommands).toBeGreaterThanOrEqual(64);
      expect(DEFAULT_CANVAS_STORAGE_LIMITS.maxCanvasJsonBytes).toBeGreaterThanOrEqual(1024 * 1024);
    });
  });
}

/** 断言一个异步调用抛出指定 `CanvasStorageError` code（跨 bundle 安全，按字符串比较）。 */
export async function expectError(
  run: () => Promise<unknown>,
  expect: ContractSuiteApi["expect"],
  code: CanvasStorageErrorCode
): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) throw new Error(`期望抛出 ${code}，但调用成功`);
  const actual = canvasStorageErrorCode(thrown);
  if (actual !== code) {
    throw new Error(`期望错误码 ${code}，实际 ${actual ?? "unknown"}: ${String(thrown)}`);
  }
  expect(actual).toBe(code);
}

/** 便捷：创建空画布聚合（adapter 测试用于直接调用 `repository.createCanvas`）。 */
export function emptyCanvas(id: string): ServerCanvas {
  return createEmptyWoohaa3ServerCanvas(id, NOW);
}
