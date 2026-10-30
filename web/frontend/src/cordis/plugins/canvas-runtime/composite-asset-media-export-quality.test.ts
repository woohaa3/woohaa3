/**
 * 导出取帧的纹理上限（change: 2026-10-19-extend-film-set-for-motion-graphics，D5）。
 *
 * 交互预览仍用 1024；导出期间临时升到 2048，并让下一次取帧重新上传。
 */
import { describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  createFilmSetSnapshot,
  filmSetNodeDataFields,
  type ServerCanvas
} from "@woohaa3/contracts";
import { createCompositeAssetMediaSessions, EXPORT_TEXTURE_MAX_DIMENSION } from "./composite-asset-media-session.js";
import { TEXTURE_FALLBACK_TIER, TEXTURE_MAX_DIMENSION } from "./texture-sync.js";

const NOW = "2026-10-19T00:00:00.000Z";

/** 最小片场：一个 image 条目（资产 ready 且有同源 URL）。 */
function canvas(): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1", NOW);
  return {
    ...base,
    document: { ...base.document, nodes: [{ id: "fs", type: "composite-asset", position: { x: 0, y: 0 } }], edges: [] },
    nodeData: {
      fs: filmSetNodeDataFields(createFilmSetSnapshot({
        title: "片场",
        model: { modelScript: "scene.box({ id: 'a' });", modelScriptVersion: "woohaa-model-js-v2" },
        modelItemId: "actor",
        motionScript: "motion.model.rotate('a', { speed: 1 });",
        timeline: { duration: 4, loop: false },
        filmSetContent: {
          schemaVersion: 4,
          items: [{ id: "img", kind: "image", name: "图", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, assetId: "asset-image", aspectRatio: 2 }]
        }
      }))
    } as ServerCanvas["nodeData"],
    assets: [{
      id: "asset-image",
      title: "图",
      mediaKind: "image",
      source: "generated",
      status: "ready",
      createdAt: NOW,
      url: "/api/media/a",
      metadata: { storageKey: `sha256-${"a".repeat(64)}`, checksum: "a".repeat(64), contentType: "image/png", size: 4 }
    }]
  } as ServerCanvas;
}

/** 与 film-set 的 media-sources 投影同形：图片平面 + 稳定资产身份。 */
const sources = (serverCanvas: ServerCanvas | null) =>
  serverCanvas?.document.nodes.flatMap(node => [{
    planeId: `${node.id}::img`,
    nodeId: node.id,
    itemId: "img",
    kind: "image" as const,
    assetId: "asset-image",
    sourceIdentity: "s"
  }]) ?? [];

/** 记录每次光栅化的目标尺寸；像素缓冲按尺寸造齐。 */
function recordingFactory(sizes: Array<{ width: number; height: number }>) {
  return () => ({
    width: 1,
    height: 1,
    getContext: () => ({
      drawImage: () => undefined,
      getImageData: (_x: number, _y: number, width: number, height: number) => {
        sizes.push({ width, height });
        const buffer = new ArrayBuffer(width * height * 4);
        return { data: { buffer, byteOffset: 0, byteLength: buffer.byteLength } };
      }
    })
  });
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("片场媒体导出纹理上限（D5）", () => {
  it("导出上限取纹理硬上限，且严格高于日常交互档位", () => {
    expect(TEXTURE_MAX_DIMENSION).toBe(4096);
    expect(EXPORT_TEXTURE_MAX_DIMENSION).toBe(TEXTURE_MAX_DIMENSION);
    expect(EXPORT_TEXTURE_MAX_DIMENSION).toBeGreaterThan(TEXTURE_FALLBACK_TIER);
  });

  it("导出期间改用导出档位，退出后回到交互档位并重新上传", async () => {
    const sizes: Array<{ width: number; height: number }> = [];
    const sessions = createCompositeAssetMediaSessions({
      runtime: { retryVersion: () => 0, setModelMediaTexture: () => true } as never,
      getCanvas: () => canvas(),
      getSources: () => sources(canvas()) as never,
      createCanvas: recordingFactory(sizes) as never,
      // 一张 4096×2160 的图片：交互按兜底档 1024，导出升到硬上限 4096。
      loadImage: async () => ({ width: 4096, height: 2160 })
    });
    sessions.sync();
    await flush();
    expect(sizes.at(-1)).toEqual({ width: 1024, height: 540 });

    sessions.setExportQuality(true);
    sessions.sync();
    await flush();
    // 导出档位等于硬上限：4096×2160 原样取帧，不再降采样。
    expect(sizes.at(-1)).toEqual({ width: 4096, height: 2160 });

    sessions.setExportQuality(false);
    sessions.sync();
    await flush();
    expect(sizes.at(-1)).toEqual({ width: 1024, height: 540 });
    sessions.dispose();
  });
});
