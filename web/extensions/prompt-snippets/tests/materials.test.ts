/**
 * 片段素材候选/预览与应用测试
 * （change: add-prompt-snippet-library，任务 3.3/3.4/3.5）。
 */
import { describe, expect, it, vi } from "vitest";
import { applyCanvasCommands, createEmptyWoohaa3ServerCanvas, materializeSnippetBody, type ServerCanvas } from "@woohaa3/contracts";
import { collectMaterialCandidates, resolveMaterialPreview } from "../src/frontend/materials.js";
import type { CanvasRemoteService, MediaRemoteService } from "@woohaa3/frontend/extension-api";
import { syncSnippetMaterials, candidateMentionOptions } from "../src/frontend/sync-materials.js";

const CHECKSUM = "a".repeat(64);

function canvasWithAsset(): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  const result = applyCanvasCommands(base, [
    {
      type: "asset.upsert",
      asset: {
        id: "asset-1",
        title: "图",
        mediaKind: "image",
        source: "uploaded",
        status: "ready",
        createdAt: "2026-09-27T00:00:00.000Z",
        url: `/api/media/sha256-${CHECKSUM}`,
        metadata: { storageKey: `sha256-${CHECKSUM}`, checksum: CHECKSUM, contentType: "image/png", size: 4 }
      }
    }
  ]);
  if (!result.ok) throw new Error("fixture");
  return result.canvas;
}

function makeRemote(): CanvasRemoteService {
  return {
    resolveSnippetMaterial: vi.fn(async () => ({ ok: true, value: { storageKey: `sha256-${CHECKSUM}`, resolvable: true } }))
  } as unknown as CanvasRemoteService;
}

function makeMediaRemote(): MediaRemoteService {
  return {
    urlFor: (storageKey: string) => `/api/media/${storageKey}`,
    isAllowedUrl: (url: string) => url.startsWith("/api/media/"),
    resolveCanonicalUrl: () => `/api/media/sha256-${CHECKSUM}`
  } as unknown as MediaRemoteService;
}

describe("collectMaterialCandidates", () => {
  it("只收集 ready 媒体资产并生成局部 key", () => {
    const candidates = collectMaterialCandidates(canvasWithAsset());
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ key: "material-1", mediaKind: "image" });
    expect(candidates[0]!.material).toMatchObject({ storageKey: `sha256-${CHECKSUM}` });
    expect(candidateMentionOptions(candidates)[0]).toMatchObject({ slotId: "material-1", type: "input_image" });
  });

  it("拒绝 generating/未就绪资产", () => {
    const canvas = canvasWithAsset();
    const notReady = { ...canvas, assets: canvas.assets.map((asset) => ({ ...asset, status: "generating" as const })) };
    expect(collectMaterialCandidates(notReady)).toEqual([]);
  });
});

describe("resolveMaterialPreview", () => {
  it("当前画布内资产直接解析同源 URL", async () => {
    const preview = await resolveMaterialPreview({
      material: {
        key: "material-1",
        mediaKind: "image",
        assetId: "asset-1",
        storageKey: `sha256-${CHECKSUM}`,
        checksum: CHECKSUM,
        contentType: "image/png",
        size: 4,
        label: "图"
      },
      canvas: canvasWithAsset(),
      remote: makeRemote(),
      mediaRemote: makeMediaRemote()
    });
    expect(preview.status).toBe("ready");
    expect(preview.url).toBe(`/api/media/sha256-${CHECKSUM}`);
  });

  it("跨画布时经 resolver + mediaRemote 解析", async () => {
    const remote = makeRemote();
    const preview = await resolveMaterialPreview({
      material: {
        key: "material-1",
        mediaKind: "video",
        assetId: "elsewhere",
        storageKey: `sha256-${CHECKSUM}`,
        checksum: CHECKSUM,
        contentType: "video/mp4",
        size: 4,
        label: "视频"
      },
      canvas: canvasWithAsset(),
      remote,
      mediaRemote: makeMediaRemote()
    });
    expect(remote.resolveSnippetMaterial).toHaveBeenCalled();
    expect(preview.status).toBe("ready");
  });

  it("resolver 不可用时显示 unavailable", async () => {
    const remote = { resolveSnippetMaterial: vi.fn(async () => ({ ok: false, code: "unauthorized", error: "no" })) } as unknown as CanvasRemoteService;
    const preview = await resolveMaterialPreview({
      material: {
        key: "material-1",
        mediaKind: "video",
        assetId: "x",
        storageKey: `sha256-${CHECKSUM}`,
        checksum: CHECKSUM,
        contentType: "video/mp4",
        size: 4,
        label: "v"
      },
      canvas: canvasWithAsset(),
      remote,
      mediaRemote: makeMediaRemote()
    });
    expect(preview.status).toBe("unavailable");
  });
});

describe("syncSnippetMaterials", () => {
  it("删除 mention 同步移除 material，其它 key 保持", () => {
    const candidates = collectMaterialCandidates(canvasWithAsset());
    const body = "{{input_image:material-1:图}} 后面";
    const kept = syncSnippetMaterials({ body, materials: candidates[0]!.material ? [candidates[0]!.material] : [], candidates });
    expect(kept.materials).toHaveLength(1);
    const removed = syncSnippetMaterials({ body: "只有文本", materials: kept.materials, candidates });
    expect(removed.materials).toHaveLength(0);
  });

  it("引用未知 key 时报告 missing", () => {
    const synced = syncSnippetMaterials({
      body: "{{input_image:material-9:未知}}",
      materials: [],
      candidates: []
    });
    expect(synced.missingKeys).toEqual(["material-9"]);
  });
});

describe("应用片段与目录解耦", () => {
  it("materialize 输出是自包含字符串，不保留片段身份（删除片段不追溯修改）", () => {
    // 应用期只把片段展开成一份文本/规范 token；结果不含片段 ID，与目录生命周期无关。
    const result = materializeSnippetBody({
      body: "写实 {{input_image:material-1:图}}",
      materials: [
        {
          key: "material-1",
          mediaKind: "image",
          assetId: "a1",
          storageKey: `sha256-${CHECKSUM}`,
          checksum: CHECKSUM,
          contentType: "image/png",
          size: 4,
          label: "图"
        }
      ],
      targetMappings: []
    });
    expect(result.body).toBe("写实 @图");
    expect(result.body).not.toContain("material-1");
  });
});
