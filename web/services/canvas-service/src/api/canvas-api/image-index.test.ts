/**
 * 跨画布图片列表（图库「全部画布」）。
 *
 * 覆盖：只收 ready 图片、排除视频海报、扫描失败的画布跳过、缓存窗口、
 * 分页与按创建时间倒序。投影是唯一数据源（结构化仓库里没有资产），所以这里只用假投影。
 */
import { describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas, type StoredAsset } from "@woohaa3/contracts";
import { createCanvasImageIndex, imagesOf } from "./image-index.js";

const NOW = "2026-11-02T00:00:00.000Z";

function asset(id: string, patch: Partial<StoredAsset> = {}): StoredAsset {
  return {
    id,
    title: id,
    mediaKind: "image",
    source: "uploaded",
    status: "ready",
    url: `/api/media/${id}`,
    createdAt: NOW,
    ...patch
  };
}

function canvas(id: string, title: string, assets: StoredAsset[]): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas(id, NOW);
  return { ...base, title, assets };
}

describe("imagesOf", () => {
  it("只收 ready 的图片，排除视频与视频海报", () => {
    const c = canvas("c1", "客厅", [
      asset("a"),
      asset("v", { mediaKind: "video" }),
      asset("pending", { status: "generating" }),
      asset("poster", { provenance: { taskKind: "video-generation", outputIndex: 1 } })
    ]);
    expect(imagesOf(c, "客厅").map((i) => i.id)).toEqual(["a"]);
  });

  it("带上画布身份与标题", () => {
    const [item] = imagesOf(canvas("c1", "客厅", [asset("a", { isFavorite: true })]), "客厅");
    expect(item).toMatchObject({ canvasId: "c1", canvasTitle: "客厅", isFavorite: true, url: "/api/media/a" });
  });

  it("带回完整资产：别的画布要靠它把这张图放进自己的画布", () => {
    const source = asset("a", { metadata: { storageKey: `sha256-${"a".repeat(64)}`, checksum: "a".repeat(64), contentType: "image/png", size: 3 } });
    const [item] = imagesOf(canvas("c1", "客厅", [source]), "客厅");
    // 资产原样带出（含 metadata），前端跨画布放置时直接写回，不需要再请求一次
    expect(item!.asset).toEqual(source);
    expect(item!.asset.metadata?.storageKey).toBe(`sha256-${"a".repeat(64)}`);
  });

  it("没有 url 的资产不算（拿不到地址就展示不了）", () => {
    const c = canvas("c1", "x", [asset("a", { url: undefined })]);
    expect(imagesOf(c, "x")).toEqual([]);
  });
});

describe("createCanvasImageIndex", () => {
  const deps = (overrides: Partial<Parameters<typeof createCanvasImageIndex>[0]> = {}) => {
    const published = new Map<string, ServerCanvas | null>([
      ["c1", canvas("c1", "客厅", [asset("a1", { createdAt: "2026-11-01T00:00:00.000Z" }), asset("a2")])],
      ["c2", canvas("c2", "卧室", [asset("b1", { createdAt: "2026-11-03T00:00:00.000Z", source: "generated" })])],
      ["remote-only", null]
    ]);
    return {
      listCanvases: vi.fn(async () => ({
        items: [
          { id: "c1", title: "客厅" },
          { id: "c2", title: "卧室" },
          { id: "remote-only", title: "远端" }
        ],
        total: 3
      })),
      loadPublished: vi.fn(async (id: string) => published.get(id) ?? null),
      cacheTtlMs: 0,
      ...overrides
    };
  };

  it("把所有画布的图片合成一份，按创建时间倒序", async () => {
    const index = createCanvasImageIndex(deps());
    const page = await index.list({ offset: 0, limit: 100 });
    expect(page.items.map((i) => i.id)).toEqual(["b1", "a2", "a1"]);
    expect(page.total).toBe(3);
    // 如实反映：扫描 3 张（含读不到投影的那张），没有截断
    expect(page.scannedCanvases).toBe(3);
    expect(page.truncated).toBe(false);
  });

  it("只存在于远端、读不到投影的画布直接跳过，不报错", async () => {
    const index = createCanvasImageIndex(deps());
    expect((await index.list({ offset: 0, limit: 100 })).items).toHaveLength(3);
  });

  it("单张画布读取抛错不影响整份列表", async () => {
    const d = deps();
    d.loadPublished = vi.fn(async (id: string) => {
      if (id === "c1") throw new Error("boom");
      if (id === "remote-only") return null;
      return canvas("c2", "卧室", [asset("b1")]);
    });
    const page = await createCanvasImageIndex(d).list({ offset: 0, limit: 100 });
    expect(page.items.map((i) => i.id)).toEqual(["b1"]);
  });

  it("分页作用在合并结果上", async () => {
    const index = createCanvasImageIndex(deps());
    const first = await index.list({ offset: 0, limit: 2 });
    const second = await index.list({ offset: 2, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(second.total).toBe(3);
    // 分页只切结果：扫描数与截断标记在每一页都一样
    expect(first.scannedCanvases).toBe(second.scannedCanvases);
    expect(first.truncated).toBe(false);
  });

  it("缓存窗口内不重复读投影，过期后重读", async () => {
    let t = 0;
    const d = deps({ cacheTtlMs: 1000, now: () => t });
    const index = createCanvasImageIndex(d);
    await index.list({ offset: 0, limit: 100 });
    const calls = (d.loadPublished as ReturnType<typeof vi.fn>).mock.calls.length;
    await index.list({ offset: 0, limit: 100 });
    expect((d.loadPublished as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);

    t = 2000;
    await index.list({ offset: 0, limit: 100 });
    expect((d.loadPublished as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(calls);
  });
});

describe("跨画布图片：如实报告与授权过滤", () => {
  const deps = (overrides: Partial<Record<string, unknown>> = {}) => ({
    listCanvases: vi.fn(async () => ({
      items: [
        { id: "c1", title: "客厅" },
        { id: "c2", title: "卧室" },
        { id: "c3", title: "书房" }
      ],
      total: 3
    })),
    loadPublished: vi.fn(async (id: string) => canvas(id, id, [asset(`${id}-a`)])),
    cacheTtlMs: 0,
    ...overrides
  });

  it("只列授权集合里的画布", async () => {
    const index = createCanvasImageIndex(deps());
    const page = await index.list({ offset: 0, limit: 100, canvasIds: ["c1", "c3"] });
    expect(page.items.map((i) => i.canvasId).sort()).toEqual(["c1", "c3"]);
    // 扫描数只算真正走到的画布
    expect(page.scannedCanvases).toBe(2);
  });

  it("目录比扫描上限多时标记 truncated", async () => {
    const index = createCanvasImageIndex(
      deps({ listCanvases: vi.fn(async () => ({ items: [{ id: "c1", title: "客厅" }], total: 500 })) })
    );
    const page = await index.list({ offset: 0, limit: 100 });
    expect(page.truncated).toBe(true);
    expect(page.scannedCanvases).toBe(1);
  });

  it("不同授权集合不共用缓存", async () => {
    const d = deps({ cacheTtlMs: 60_000 });
    const index = createCanvasImageIndex(d);
    const full = await index.list({ offset: 0, limit: 100 });
    const limited = await index.list({ offset: 0, limit: 100, canvasIds: ["c1"] });
    expect(full.items).toHaveLength(3);
    expect(limited.items).toHaveLength(1);
  });
});
