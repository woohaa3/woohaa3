/**
 * bootstrap `storage` 槽位接进画布存储的装配契约
 * （change: 2026-10-15-scan-bootstrap-slots-as-extension-directories，任务 3.3/4.2）。
 *
 * 存储槽位已经解析出配置与仓库；画布服务必须**只借**它们，不再要求同名环境变量。
 * 这里验证：只给 `storageConfig` + 注入仓库（环境里没有 `WOOHAA3_CANVAS_STORAGE_BACKEND`）
 * 时画布服务仍进入 ready，且用的是注入的仓库实例。
 */
import { describe, expect, it } from "vitest";
import { InMemoryCanvasRepository } from "./storage/core/index.js";
import { InMemoryYjsDocumentRepository, createInMemoryWriterLock } from "./sync/index.js";
import { createCanvasService } from "./composition.js";

const fakeMediaClient = {
  async verify() {
    return { exists: true, matches: true };
  }
};

const fakeTaskClient = {
  async submit(): Promise<never> {
    throw new Error("not used");
  },
  async cancel() {},
  async status() {
    return null;
  },
  async history() {
    return { items: [], cursor: 0 };
  },
  async canvasActivity() {
    return { active: [], recent: [], cursor: 0 };
  },
  async canvasActivitySince() {
    return { items: [], cursor: 0 };
  },
  async canvasActivityChanges() {
    return { items: [], cursor: 0 };
  }
};

describe("storage 槽位注入画布存储", () => {
  it("只有 storageConfig + 注入仓库（无同名环境变量）时进入 ready 并使用注入仓库", async () => {
    const repository = new InMemoryCanvasRepository();
    const service = await createCanvasService({
      // 环境里没有任何画布存储变量：配置只来自槽位。
      env: {},
      storageConfig: { backend: "sqlite", sqlitePath: ":memory:", limits: {} },
      repository,
      yjsRepository: new InMemoryYjsDocumentRepository(),
      writerLock: createInMemoryWriterLock(),
      mediaClient: fakeMediaClient,
      taskClient: fakeTaskClient,
      logger: () => undefined
    });
    try {
      await expect(service.readiness()).resolves.toEqual({ ready: true });

      const created = await service.composition?.service.createCanvas({ title: "slot-canvas" });
      expect(created?.id).toBeTruthy();
      const stored = await repository.getCanvas(created!.id);
      expect(stored?.title).toBe("slot-canvas");
    } finally {
      await service.close();
    }
  });

  it("没有 storageConfig 也没有环境变量时画布存储不可用（不回退）", async () => {
    const service = await createCanvasService({
      env: {},
      enableCanvasStorage: true,
      repository: new InMemoryCanvasRepository(),
      yjsRepository: new InMemoryYjsDocumentRepository(),
      writerLock: createInMemoryWriterLock(),
      mediaClient: fakeMediaClient,
      taskClient: fakeTaskClient,
      logger: () => undefined
    });
    try {
      await expect(service.readiness()).resolves.toMatchObject({ ready: false });
    } finally {
      await service.close();
    }
  });
});
