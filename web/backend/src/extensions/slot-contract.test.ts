/**
 * storage 槽位 → 画布存储装配的桥接契约
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 1.2/4.8）。
 *
 * 连接由槽位（宿主）持有，画布领域服务只借句柄：`canvasStorageOptions` 必须透传配置与
 * 写锁，并且**屏蔽**仓库的 `close`，避免画布服务的 close 把宿主还要用的连接关掉。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { bootstrapProviders } from "@woohaa3/application-service";
import {
  InMemoryCanvasRepository,
  InMemoryYjsDocumentRepository,
  createCanvasService,
  createInMemoryWriterLock,
  type CanvasRepository
} from "@woohaa3/canvas-service";
import { borrow, canvasStorageOptions, type RuntimeStorageProvider } from "./slot-contract.js";

function fakeRepository(): { repository: CanvasRepository; close: ReturnType<typeof vi.fn>; getCanvas: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  const getCanvas = vi.fn(async () => null);
  const repository = { close, getCanvas } as unknown as CanvasRepository;
  return { repository, close, getCanvas };
}

function fakeStorage(unit: Record<string, unknown>): RuntimeStorageProvider {
  // 本测试只关心 `canvas` 单元；documents / directory 不参与，按最小替身给出。
  return {
    providerId: "sqlite-storage",
    canvas: unit as unknown as RuntimeStorageProvider["canvas"],
    documents: {} as RuntimeStorageProvider["documents"],
    readExtensionConfig: () => ({}),
    directory: {} as RuntimeStorageProvider["directory"],
    listCanvasSummaries: async () => []
  };
}

describe("canvasStorageOptions", () => {
  it("透传 storageConfig、writerLock 与可选仓库，且借用句柄不关闭宿主连接", async () => {
    const { repository, close, getCanvas } = fakeRepository();
    const yjsRepository = { close: vi.fn() };
    const writerLock = { acquire: vi.fn() };
    const nodeHistoryRepository = { close: vi.fn() };
    const editCompletionRepository = { close: vi.fn() };
    const snippetRepository = { close: vi.fn() };
    const storageConfig = { backend: "sqlite" as const, sqlitePath: "/data/canvas.sqlite", limits: {} };

    const options = canvasStorageOptions(fakeStorage({
      repository,
      yjsRepository,
      writerLock,
      storageConfig,
      nodeHistoryRepository,
      editCompletionRepository,
      snippetRepository
    }));

    expect(options.storageConfig).toBe(storageConfig);
    expect(options.writerLock).toBe(writerLock);
    expect(options.nodeHistoryRepository).toBeDefined();
    expect(options.editCompletionRepository).toBeDefined();
    expect(options.snippetRepository).toBeDefined();

    // 借用的仓库：方法照常转发，但 close 不落到宿主连接。
    await options.repository.getCanvas("canvas-1");
    expect(getCanvas).toHaveBeenCalledWith("canvas-1");
    // 仓库契约不声明 close；借用后即使调用方按可关闭资源处理也不得触达宿主连接。
    await (options.repository as { close?: () => void }).close?.();
    expect(close).not.toHaveBeenCalled();
    await (options.yjsRepository as { close?: () => void }).close?.();
    expect(yjsRepository.close).not.toHaveBeenCalled();
    await (options.nodeHistoryRepository as { close?: () => void } | undefined)?.close?.();
    expect(nodeHistoryRepository.close).not.toHaveBeenCalled();
    await (options.editCompletionRepository as { close?: () => void } | undefined)?.close?.();
    expect(editCompletionRepository.close).not.toHaveBeenCalled();
    await (options.snippetRepository as { close?: () => void } | undefined)?.close?.();
    expect(snippetRepository.close).not.toHaveBeenCalled();
  });

  it("槽位未给出可选仓库时不下发对应选项", () => {
    const options = canvasStorageOptions(fakeStorage({
      repository: fakeRepository().repository,
      yjsRepository: { close: vi.fn() },
      writerLock: { acquire: vi.fn() }
    }));
    expect(options.storageConfig).toBeUndefined();
    expect(options.nodeHistoryRepository).toBeUndefined();
    expect(options.editCompletionRepository).toBeUndefined();
    expect(options.snippetRepository).toBeUndefined();
  });
});

describe("borrow", () => {
  it("只拦截 close，其它属性保持 this 绑定", () => {
    const target = {
      value: 3,
      close: vi.fn(),
      read(this: { value: number }) {
        return this.value;
      }
    };
    const borrowed = borrow(target);
    expect(borrowed.read()).toBe(3);
    borrowed.close();
    expect(target.close).not.toHaveBeenCalled();
  });
});

describe("storage 槽位 → 画布服务（端到端）", () => {
  const mediaClient = {
    async verify() {
      return { exists: true, matches: true };
    }
  };
  const taskClient = {
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

  it("bootstrapProviders 装配的画布单元可直接启动画布服务并在其上创建画布", async () => {
    const repository = new InMemoryCanvasRepository();
    const provider: RuntimeStorageProvider = {
      providerId: "sqlite-storage",
      canvas: {
        repository,
        yjsRepository: new InMemoryYjsDocumentRepository(),
        writerLock: createInMemoryWriterLock(),
        // 画布服务的场景包存储会真的打开这个路径：写死 POSIX 绝对路径在 Windows 上
        // 是 `C:\unused\...`，目录不存在会直接 "unable to open database file"。
        storageConfig: { backend: "sqlite", sqlitePath: path.join(mkdtempSync(path.join(tmpdir(), "woohaa-slot-")), "unused.sqlite"), limits: {} }
      },
      documents: {} as RuntimeStorageProvider["documents"],
      readExtensionConfig: () => ({}),
      directory: {} as RuntimeStorageProvider["directory"],
      listCanvasSummaries: async () => []
    };

    const runtime = await bootstrapProviders<RuntimeStorageProvider>([
      { extensionId: "sqlite-storage", providers: [{ slot: "storage", requires: [], async create() { return { value: provider }; } }] }
    ]);
    expect(runtime.owners.storage).toBe("sqlite-storage");

    const service = await createCanvasService({
      env: {},
      ...canvasStorageOptions(runtime.providers.storage),
      mediaClient,
      taskClient,
      logger: () => undefined
    });
    try {
      await expect(service.readiness()).resolves.toEqual({ ready: true });
      const created = await service.composition!.service.createCanvas({ title: "from-slot" });
      expect((await repository.getCanvas(created.id))?.title).toBe("from-slot");
    } finally {
      await service.close();
      // 画布服务借用槽位连接：它的 close 不得释放宿主资源，宿主仍可继续使用。
      expect(await repository.getCanvas("missing")).toBeNull();
      await runtime.close();
    }
  });
});
