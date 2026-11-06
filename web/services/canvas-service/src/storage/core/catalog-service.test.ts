/**
 * Canvas Catalog Service 单测
 * （change: 2026-09-29-add-multi-canvas-workspace，任务 1.3 / design D4）。
 *
 * 覆盖：Yjs document 不存在（结构化摘要）、projection 覆盖权威字段、projection 损坏、
 * repository/reader 失败、分页语义。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { InMemoryCanvasRepository } from "./in-memory-repository.js";
import { CanvasCatalogService, type CanvasPublishedReader } from "./catalog-service.js";
import { CanvasStorageError } from "./errors.js";
import { InMemoryYjsDocumentRepository } from "../../sync/in-memory-yjs-repository.js";
import { createPublishedReader } from "../../sync/published-reader.js";

const NOW = "2026-09-29T00:00:00.000Z";

async function seedRepository(): Promise<InMemoryCanvasRepository> {
  const repository = new InMemoryCanvasRepository();
  await repository.createCanvas(createEmptyWoohaa3ServerCanvas("canvas-a", NOW));
  await repository.createCanvas(
    { ...createEmptyWoohaa3ServerCanvas("canvas-b", NOW), title: "结构化旧标题" }
  );
  return repository;
}

function projection(canvasId: string, overrides: Partial<ServerCanvas> = {}): ServerCanvas {
  return {
    ...createEmptyWoohaa3ServerCanvas(canvasId, NOW),
    title: "Yjs 新标题",
    revision: 7,
    updatedAt: "2026-09-29T01:00:00.000Z",
    ...overrides
  };
}

describe("CanvasCatalogService", () => {
  it("Yjs document 不存在时使用结构化摘要", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    const catalog = new CanvasCatalogService({ repository, published: createPublishedReader(yjs) });

    const page = await catalog.listCanvases();
    const b = page.items.find((item) => item.id === "canvas-b");
    expect(b).toMatchObject({ title: "结构化旧标题", revision: 1 });
  });

  it("projection 存在时覆盖 title/revision/updatedAt/nodeCount/assetCount，id/createdAt 保持结构化", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    const structuredCreatedAt = "2026-09-29T00:00:00.000Z";
    const withNodes = projection("canvas-b");
    withNodes.document.nodes.push({ id: "n1", type: "text", position: { x: 0, y: 0 } });
    withNodes.assets.push({
      id: "a1",
      title: "asset",
      mediaKind: "image",
      source: "uploaded",
      status: "ready",
      createdAt: NOW
    });
    withNodes.revision = 9;
    await yjs.createYjsDocument({
      canvasId: "canvas-b",
      formatVersion: "1",
      roomEpoch: "epoch",
      checkpoint: new Uint8Array(),
      projection: withNodes,
      revision: withNodes.revision,
      createdAt: NOW
    });
    const catalog = new CanvasCatalogService({ repository, published: createPublishedReader(yjs) });

    const page = await catalog.listCanvases();
    const b = page.items.find((item) => item.id === "canvas-b")!;
    expect(b).toMatchObject({
      id: "canvas-b",
      createdAt: structuredCreatedAt,
      title: "Yjs 新标题",
      revision: 9,
      updatedAt: withNodes.updatedAt,
      nodeCount: 1,
      assetCount: 1
    });
  });

  it("按 id 读取时返回 published projection，而不是结构化旧快照", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    const published = projection("canvas-b");
    published.title = "Yjs 打开标题";
    published.revision = 11;
    published.document.nodes.push({ id: "n1", type: "text", position: { x: 0, y: 0 } });
    await yjs.createYjsDocument({
      canvasId: "canvas-b",
      formatVersion: "1",
      roomEpoch: "epoch",
      checkpoint: new Uint8Array(),
      projection: published,
      revision: published.revision,
      createdAt: NOW
    });
    const catalog = new CanvasCatalogService({ repository, published: createPublishedReader(yjs) });

    await expect(catalog.getCanvas("canvas-b")).resolves.toMatchObject({
      title: "Yjs 打开标题",
      revision: 11,
      document: { nodes: [{ id: "n1" }] }
    });
  });

  it("尚未 bootstrap 时按 id 回退到结构化画布", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    const catalog = new CanvasCatalogService({ repository, published: createPublishedReader(yjs) });

    await expect(catalog.getCanvas("canvas-b")).resolves.toMatchObject({
      title: "结构化旧标题",
      revision: 1,
      document: { nodes: [] }
    });
  });

  it("结构化画布也不存在时按稳定错误码失败", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    const catalog = new CanvasCatalogService({ repository, published: createPublishedReader(yjs) });

    await expect(catalog.getCanvas("missing")).rejects.toMatchObject({ code: "CANVAS_NOT_FOUND" });
  });

  it("projection 损坏时失败，不回退结构化标题", async () => {
    const repository = await seedRepository();
    const broken: CanvasPublishedReader = {
      loadPublished: async () => ({ id: "canvas-b", revision: 2 } as unknown as ServerCanvas)
    };
    const catalog = new CanvasCatalogService({ repository, published: broken });

    await expect(catalog.listCanvases()).rejects.toBeInstanceOf(CanvasStorageError);
  });

  it("reader 读取失败向上抛出，不静默回退", async () => {
    const repository = await seedRepository();
    const failing: CanvasPublishedReader = {
      loadPublished: async () => {
        throw new Error("db down");
      }
    };
    const catalog = new CanvasCatalogService({ repository, published: failing });
    await expect(catalog.listCanvases()).rejects.toThrow("db down");
  });

  it("分页保留结构化 total/offset/limit 与稳定顺序", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    const catalog = new CanvasCatalogService({ repository, published: createPublishedReader(yjs) });

    const page = await catalog.listCanvases({ offset: 0, limit: 1 });
    expect(page.total).toBe(2);
    expect(page.offset).toBe(0);
    expect(page.limit).toBe(1);
    expect(page.items).toHaveLength(1);
  });
});

/**
 * 目录是 provider 式的：本机存储永远在，远端来源接入后**两者都生效**。
 *
 * 这组用例锁定"合并"的三条规则：并集、去重、来源与同步状态标注。
 */
describe("CanvasCatalogService 多来源合并", () => {
  const remoteEntry = (id: string, updatedAt: string, title = "远端标题") => ({
    id,
    title,
    revision: 3,
    updatedAt
  });

  it("本地与远端取并集，同一个 id 只出现一次且以本地内容为准", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    const catalog = new CanvasCatalogService({
      repository,
      published: createPublishedReader(yjs),
      remoteSources: [
        {
          id: "remote:test",
          label: "远端 test",
          // canvas-a 两边都有；canvas-r 只在远端。
          list: async () => [remoteEntry("canvas-a", "2026-09-30T00:00:00.000Z"), remoteEntry("canvas-r", "2026-09-30T01:00:00.000Z")]
        }
      ]
    });

    const page = await catalog.listCanvases({ limit: 10 });
    expect(page.items.map((item) => item.id)).toEqual(["canvas-r", "canvas-a", "canvas-b"]);
    expect(page.total).toBe(3);

    const shared = page.items.find((item) => item.id === "canvas-a")!;
    expect(shared.sources).toEqual(["local", "remote"]);
    // 两边都有时内容以本地为准：远端那版标题不能盖掉本机的结构化标题。
    expect(shared.title).not.toBe("远端标题");

    const remoteOnly = page.items.find((item) => item.id === "canvas-r")!;
    expect(remoteOnly.sources).toEqual(["remote"]);
    expect(remoteOnly.sync).toBe("remote-only");
  });

  /**
   * 2026-10-26 现场：宿主重启后房间先于扩展会话就绪建好，解析拿不到凭据，之后没有任何
   * 重试。此时远端列得到这张画布、归属记录也在，但本机没有链路——目录此前回落成
   * 「已同步」，界面把整条上传链路的缺失藏了起来。
   */
  it("属于远端但没有上游链路：标成 unlinked，不回落成已同步", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    const catalog = new CanvasCatalogService({
      repository,
      published: createPublishedReader(yjs),
      remoteSources: [{ id: "remote:test", label: "远端 test", list: async () => [remoteEntry("canvas-a", "2026-09-30T00:00:00.000Z")] }],
      isRemoteOwned: (canvasId) => canvasId === "canvas-a"
    });

    const page = await catalog.listCanvases({ limit: 10 });
    const shared = page.items.find((item) => item.id === "canvas-a")!;
    expect(shared.sources).toEqual(["local", "remote"]);
    expect(shared.sync).toBe("unlinked");
  });

  it("只在远端存在：保持仅远端，不因没有链路报未连接（本机没有待推送内容）", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    const catalog = new CanvasCatalogService({
      repository,
      published: createPublishedReader(yjs),
      remoteSources: [{ id: "remote:test", label: "远端 test", list: async () => [remoteEntry("canvas-only-remote", "2026-09-30T00:00:00.000Z")] }],
      isRemoteOwned: () => true
    });

    const page = await catalog.listCanvases({ limit: 10 });
    expect(page.items.find((item) => item.id === "canvas-only-remote")!.sync).toBe("remote-only");
  });

  it("远端列得到但不是归属记录的一部分：结论保持不变（旧行为）", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    const catalog = new CanvasCatalogService({
      repository,
      published: createPublishedReader(yjs),
      remoteSources: [{ id: "remote:test", label: "远端 test", list: async () => [remoteEntry("canvas-a", "2026-09-30T00:00:00.000Z")] }],
      isRemoteOwned: () => false
    });

    const page = await catalog.listCanvases({ limit: 10 });
    expect(page.items.find((item) => item.id === "canvas-a")!.sync).toBe("synced");
  });

  it("链路状态优先于归属推断：有链路时按链路报", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    const catalog = new CanvasCatalogService({
      repository,
      published: createPublishedReader(yjs),
      remoteSources: [{ id: "remote:test", label: "远端 test", list: async () => [remoteEntry("canvas-a", "2026-09-30T00:00:00.000Z")] }],
      isRemoteOwned: () => true,
      syncStateOf: (canvasId) => (canvasId === "canvas-a" ? "syncing" : undefined)
    });

    const page = await catalog.listCanvases({ limit: 10 });
    expect(page.items.find((item) => item.id === "canvas-a")!.sync).toBe("syncing");
  });

  it("来源故障不影响本地部分", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    const catalog = new CanvasCatalogService({
      repository,
      published: createPublishedReader(yjs),
      remoteSources: [{ id: "remote:broken", label: "远端 broken", list: async () => { throw new Error("unreachable"); } }]
    });
    const page = await catalog.listCanvases({ limit: 10 });
    expect(page.items.map((item) => item.id).sort()).toEqual(["canvas-a", "canvas-b"]);
    expect(page.total).toBe(2);
  });

  it("同步状态来自上游链路，纯本地条目不再标成 local-only 以外的值", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    const catalog = new CanvasCatalogService({
      repository,
      published: createPublishedReader(yjs),
      remoteSources: [{ id: "remote:test", label: "远端", list: async () => [] }],
      syncStateOf: (canvasId) => (canvasId === "canvas-a" ? "synced" : "offline")
    });
    const page = await catalog.listCanvases({ limit: 10 });
    expect(page.items.find((item) => item.id === "canvas-a")!.sync).toBe("synced");
    expect(page.items.find((item) => item.id === "canvas-b")!.sync).toBe("offline");
    expect(page.items.find((item) => item.id === "canvas-a")!.sources).toEqual(["local"]);
  });

  it("白名单在合并之后仍生效，total 不把无权限画布算进去", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    const catalog = new CanvasCatalogService({
      repository,
      published: createPublishedReader(yjs),
      remoteSources: [{ id: "remote:test", label: "远端", list: async () => [remoteEntry("canvas-r", "2026-09-30T01:00:00.000Z")] }]
    });
    const page = await catalog.listCanvases({ ids: ["canvas-b"], limit: 10 });
    expect(page.items.map((item) => item.id)).toEqual(["canvas-b"]);
    expect(page.total).toBe(1);
  });

  it("remoteSummary 能按 id 找到只在远端存在的画布", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    const catalog = new CanvasCatalogService({
      repository,
      published: createPublishedReader(yjs),
      remoteSources: [{ id: "remote:test", label: "远端", list: async () => [remoteEntry("canvas-r", "2026-09-30T01:00:00.000Z")] }]
    });
    expect(await catalog.remoteSummary("canvas-r")).toMatchObject({ id: "canvas-r", title: "远端标题" });
    expect(await catalog.remoteSummary("canvas-missing")).toBeNull();
  });

  it("remoteSummary 优先按 id 问来源：链接画布不在列表里也能返回摘要", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    let listCalls = 0;
    const catalog = new CanvasCatalogService({
      repository,
      published: createPublishedReader(yjs),
      remoteSources: [
        {
          id: "remote:test",
          label: "远端",
          list: async () => {
            listCalls += 1;
            return [remoteEntry("canvas-r", "2026-09-30T01:00:00.000Z")];
          },
          // 链接分享的画布不会出现在任何人的目录里，只能按 id 拿到。
          get: async (canvasId) =>
            canvasId === "canvas-linked" ? remoteEntry("canvas-linked", "2026-09-30T02:00:00.000Z", "链接来的") : null
        }
      ]
    });

    expect(await catalog.remoteSummary("canvas-linked")).toMatchObject({ id: "canvas-linked", title: "链接来的" });
    // 有 get 就以它为准：按 id 打开不该顺带触发一次全量目录列举。
    expect(listCalls).toBe(0);
    // 来源说没有这张就是没有，同样不回落列表（否则每次打开都要多列一次目录）。
    expect(await catalog.remoteSummary("canvas-missing")).toBeNull();
    expect(listCalls).toBe(0);
  });

  it("按 id 取失败回退列表扫描，不把来源故障当成「画布不存在」", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    const catalog = new CanvasCatalogService({
      repository,
      published: createPublishedReader(yjs),
      remoteSources: [
        {
          id: "remote:test",
          label: "远端",
          list: async () => [remoteEntry("canvas-r", "2026-09-30T01:00:00.000Z")],
          get: async () => {
            throw new Error("unreachable");
          }
        }
      ]
    });
    // get 抛错时回退到 list：来源抖动不该让一张按 id 可见的画布变成「不存在」。
    expect(await catalog.remoteSummary("canvas-r")).toMatchObject({ id: "canvas-r" });
    expect(await catalog.remoteSummary("canvas-missing")).toBeNull();
  });
});

describe("远端画布落地后进入本机目录", () => {
  /**
   * 结构化目录（`canvases` 表）与 Yjs 文档是两张独立的表：从远端 seed 下来只建 Yjs
   * 文档的话，画布不会出现在"我的画布"里，命令提交也会找不到画布行。room 在 seed
   * 之后调用 `ensureCanvasRow` 补上这一行。
   */
  it("ensureCanvasRow 幂等：补行后出现在目录，重复调用不改 revision", async () => {
    const repository = new InMemoryCanvasRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    const pulled = {
      ...createEmptyWoohaa3ServerCanvas("canvas-remote", NOW),
      title: "远端来的",
      revision: 5
    };
    await repository.ensureCanvasRow?.(pulled);
    const catalog = new CanvasCatalogService({ repository, published: createPublishedReader(yjs) });
    let page = await catalog.listCanvases({ limit: 10 });
    expect(page.items.map((item) => item.id)).toEqual(["canvas-remote"]);

    // 再次执行（重连/重复 seed）不能把 revision 或内容改掉。
    await repository.ensureCanvasRow?.({ ...pulled, title: "远端改名了", revision: 9 });
    page = await catalog.listCanvases({ limit: 10 });
    const item = page.items[0]!;
    expect(item.id).toBe("canvas-remote");
    // 标题跟随远端；revision 保持首次落地时的值，不被后来的 9 覆盖
    //（内容与 revision 以本机 Yjs 文档为准，远端摘要只是标题来源）。
    expect(item.title).toBe("远端改名了");
    expect(item.revision).toBe(5);
  });
});

describe("远端来源延迟解析（后登录也能看到远端画布）", () => {
  it("构造时没有来源，之后接上来源，下一次列举就能看到远端画布", async () => {
    // 真实故障形状：宿主先装载 canvas、后激活扩展并登录。构造那一刻 ctx.get("application")
    // 还不存在，来源列表是空的；若把结果存进实例，目录会永远停在纯本地——用户看到的是
    // "已经接上服务端了，但服务端上已有的画布一张都不出现"。
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    let sources: Array<{ id: string; label: string; list: () => Promise<Array<{ id: string; title: string; revision: number; updatedAt: string }>> }> = [];
    const catalog = new CanvasCatalogService({
      repository,
      published: createPublishedReader(yjs),
      remoteSources: () => sources
    });

    // 登录之前：只有本地两张。
    let page = await catalog.listCanvases({ limit: 10 });
    expect(page.items.map((item) => item.id).sort()).toEqual(["canvas-a", "canvas-b"]);
    expect(catalog.remoteSourceLabels()).toEqual([]);

    // 登录 / 扩展激活之后：来源出现。
    sources = [
      {
        id: "remote:remote-server",
        label: "远端 canvas.example.com",
        list: async () => [
          { id: "canvas-remote", title: "远端已有的", revision: 0, updatedAt: "2026-09-29T02:00:00.000Z" }
        ]
      }
    ];

    page = await catalog.listCanvases({ limit: 10 });
    expect(page.items.map((item) => item.id).sort()).toEqual(["canvas-a", "canvas-b", "canvas-remote"]);
    expect(catalog.remoteSourceLabels()).toEqual(["远端 canvas.example.com"]);
    // 只在远端的那张要能被认出来（界面据此显示"仅远端"）。
    expect(page.items.find((item) => item.id === "canvas-remote")?.sources).toEqual(["remote"]);
  });

  it("来源断开后，下一次列举就回到纯本地", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    let sources = [
      {
        id: "remote:remote-server",
        label: "远端",
        list: async () => [{ id: "canvas-remote", title: "远端", revision: 0, updatedAt: NOW }]
      }
    ];
    const catalog = new CanvasCatalogService({
      repository,
      published: createPublishedReader(yjs),
      remoteSources: () => sources
    });
    expect((await catalog.listCanvases({ limit: 10 })).items.map((item) => item.id)).toContain("canvas-remote");

    sources = [];
    const page = await catalog.listCanvases({ limit: 10 });
    expect(page.items.map((item) => item.id).sort()).toEqual(["canvas-a", "canvas-b"]);
  });

  it("数组形态仍然可用（调用方不必都改成函数）", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    const catalog = new CanvasCatalogService({
      repository,
      published: createPublishedReader(yjs),
      remoteSources: [
        { id: "remote:x", label: "X", list: async () => [{ id: "canvas-r", title: "R", revision: 0, updatedAt: NOW }] }
      ]
    });
    expect((await catalog.listCanvases({ limit: 10 })).items.map((item) => item.id)).toContain("canvas-r");
  });
});

describe("内容权限（进画布即判定）", () => {
  const REMOTE_ACCESS = { canRead: true, canWrite: false } as const;

  it("来源给了权限：accessOf 原样返回；目录合并也带上 access", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    const catalog = new CanvasCatalogService({
      repository,
      published: createPublishedReader(yjs),
      remoteSources: [
        {
          id: "remote:x",
          label: "X",
          list: async () => [{ id: "canvas-b", title: "B", revision: 0, updatedAt: NOW, access: REMOTE_ACCESS }],
          access: async (canvasId) => (canvasId === "canvas-b" ? REMOTE_ACCESS : null)
        }
      ]
    });
    expect(await catalog.accessOf("canvas-b")).toEqual(REMOTE_ACCESS);
    const item = (await catalog.listCanvases({ limit: 10 })).items.find((entry) => entry.id === "canvas-b");
    // 两边都有时内容以本地为准，但**权限只能来自远端**。
    expect(item?.access).toEqual(REMOTE_ACCESS);
  });

  it("来源没答案 + 画布属于远端：判为没有访问权限（远端刻意用 not_found 隐藏不可见画布）", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    const catalog = new CanvasCatalogService({
      repository,
      published: createPublishedReader(yjs),
      remoteSources: [{ id: "remote:x", label: "X", list: async () => [], access: async () => null }],
      isRemoteOwned: (canvasId) => canvasId === "canvas-a"
    });
    expect(await catalog.accessOf("canvas-a")).toEqual({ canRead: false, canWrite: false });
  });

  it("来源没答案 + 纯本地画布：返回 null（未知按可写，纯本地画布不能被判只读）", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    const catalog = new CanvasCatalogService({
      repository,
      published: createPublishedReader(yjs),
      remoteSources: [{ id: "remote:x", label: "X", list: async () => [], access: async () => null }],
      isRemoteOwned: () => false
    });
    expect(await catalog.accessOf("canvas-a")).toBeNull();
  });

  it("来源抛错时退化为未知，不让权限读取拖垮打开画布", async () => {
    const repository = await seedRepository();
    const yjs = new InMemoryYjsDocumentRepository();
    const catalog = new CanvasCatalogService({
      repository,
      published: createPublishedReader(yjs),
      remoteSources: [
        {
          id: "remote:x",
          label: "X",
          list: async () => {
            throw new Error("boom");
          },
          access: async () => {
            throw new Error("boom");
          }
        }
      ]
    });
    expect(await catalog.accessOf("canvas-a")).toBeNull();
  });
});
