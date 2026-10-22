/**
 * 片场媒体源解码身份缓存回归
 * （change: 2026-10-13-optimize-composite-asset-media-decode，任务 1.1–1.3 / 2.1）。
 *
 * 每帧热路径（拖动 → syncCompositeAssetMedia → registry.mediaSources → filmSetMediaSources）此前
 * 逐帧无缓存重解 `nodeData`。此处用可计数的解码 mock 证明：内容对象身份不变只解码一次，对象被替换
 * 或内容变化后重新解码，且失败内容幂等可诊断。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@woohaa3/contracts", async importOriginal => {
  const actual = await importOriginal<typeof import("@woohaa3/contracts")>();
  return { ...actual, decodeFilmSetNodeData: vi.fn(actual.decodeFilmSetNodeData) };
});

import {
  createEmptyWoohaa3ServerCanvas, createFilmSetSnapshot, decodeFilmSetNodeData, filmSetNodeDataFields,
  type BevyAnimationPlayback, type ServerCanvas
} from "@woohaa3/contracts";
import { filmSetMediaSources } from "../src/frontend/media-sources.js";
import { createCompositeAssetMediaSessions } from "../../../frontend/src/cordis/plugins/canvas-runtime/composite-asset-media-session.js";
import type { BevyRuntime } from "../../../frontend/src/cordis/plugins/canvas-runtime/bevy-runtime.js";

const decode = vi.mocked(decodeFilmSetNodeData);
const NOW = "2026-10-08T00:00:00.000Z";

function filmSetData(title = "片场"): ServerCanvas["nodeData"][string] {
  return filmSetNodeDataFields(createFilmSetSnapshot({
    title,
    timeline: { duration: 0, loop: false },
    filmSetContent: {
      schemaVersion: 3,
      items: [
        { id: "img", kind: "image", name: "图", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, assetId: "asset-image", aspectRatio: 2 },
        { id: "vid", kind: "video", name: "视", localTransform: { offset: { x: 3, y: 0, z: 0 }, scale: 1, yaw: 0 }, assetId: "asset-video", aspectRatio: 1.5 }
      ]
    }
  })) as unknown as ServerCanvas["nodeData"][string];
}

function canvasWith(nodeId: string, data: ServerCanvas["nodeData"][string]): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("c1", NOW);
  canvas.document.nodes = [{ id: nodeId, type: "composite-asset", position: { x: 0, y: 0 } }];
  canvas.nodeData = { [nodeId]: data } as ServerCanvas["nodeData"];
  canvas.assets = [
    { id: "asset-image", title: "图", mediaKind: "image", source: "generated", status: "ready", createdAt: NOW, url: "/api/media/a", metadata: { storageKey: `sha256-${"a".repeat(64)}`, checksum: "a".repeat(64), contentType: "image/png", size: 4 } },
    { id: "asset-video", title: "视", mediaKind: "video", source: "generated", status: "ready", createdAt: NOW, url: "/api/media/b", metadata: { storageKey: `sha256-${"b".repeat(64)}`, checksum: "b".repeat(64), contentType: "video/mp4", size: 8 } }
  ];
  return canvas;
}

beforeEach(() => { decode.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("片场媒体源解码身份缓存", () => {
  it("同一 nodeData 对象连续解析只解码一次且输出一致（拖动热路径）", () => {
    const data = filmSetData();
    const first = filmSetMediaSources("fs", data, null);
    const second = filmSetMediaSources("fs", data, null);
    const third = filmSetMediaSources("fs", data, null);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(first.map(source => source.planeId)).toEqual(["fs::img", "fs::vid"]);
  });

  it("替换 nodeData 对象后重新解码并反映新内容，不返回旧对象缓存", () => {
    const first = filmSetData("旧片场");
    filmSetMediaSources("fs", first, null);
    const replacement = filmSetData("新片场");
    const sources = filmSetMediaSources("fs", replacement, null);
    expect(decode).toHaveBeenCalledTimes(2);
    const changed = decode.mock.results[1]!.value;
    expect(changed.ok && changed.value.title).toBe("新片场");
    expect(sources.map(source => source.planeId)).toEqual(["fs::img", "fs::vid"]);
  });

  it("不同节点与不同画布的 nodeData 互不串味", () => {
    // 不同节点：各自 nodeData 独立缓存。
    const a = filmSetData();
    const b = filmSetData();
    filmSetMediaSources("n1", a, null);
    filmSetMediaSources("n2", b, null);
    filmSetMediaSources("n1", a, null);
    expect(decode).toHaveBeenCalledTimes(2);
    expect(filmSetMediaSources("n1", a, null).every(source => source.nodeId === "n1")).toBe(true);
    // 同一 nodeId、不同画布（不同 nodeData 对象）：不命中对方的缓存。
    const canvasA = canvasWith("fs", filmSetData());
    const canvasB = canvasWith("fs", filmSetData());
    filmSetMediaSources("fs", canvasA.nodeData.fs!, null);
    filmSetMediaSources("fs", canvasB.nodeData.fs!, null);
    filmSetMediaSources("fs", canvasA.nodeData.fs!, null);
    expect(decode).toHaveBeenCalledTimes(4);
  });

  it("不可读内容幂等返回空、不抛错、不逐帧增长；内容变化后重新评估", () => {
    const invalid = { modelScript: "顶层模型字段被拒绝" } as unknown as ServerCanvas["nodeData"][string];
    expect(filmSetMediaSources("fs", invalid, null)).toEqual([]);
    expect(filmSetMediaSources("fs", invalid, null)).toEqual([]);
    expect(decode).toHaveBeenCalledTimes(1);
    // 内容变化（新对象）→ 重新评估，仍旧空但重新解码一次。
    const stillInvalid = { modelScript: "仍然非法" } as unknown as ServerCanvas["nodeData"][string];
    expect(filmSetMediaSources("fs", stillInvalid, null)).toEqual([]);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it("播放头变化不破坏内容缓存：相同 nodeData 逐帧同步只解码一次", () => {
    const data = filmSetData();
    const canvas = canvasWith("fs", data);
    const setModelMediaTexture = vi.fn();
    const sessions = createCompositeAssetMediaSessions({
      runtime: { setModelMediaTexture } as unknown as BevyRuntime,
      getCanvas: () => canvas,
      getSources: () => canvas.document.nodes.flatMap(node => filmSetMediaSources(node.id, canvas.nodeData[node.id]!, null)),
      createVideo: () => ({ src: "", muted: false, loop: false, playsInline: false, preload: "", crossOrigin: null, currentTime: 0, duration: 5, videoWidth: 320, videoHeight: 240, play() {}, pause() {}, load() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {}, seekTo(t: number) { this.currentTime = t; } }),
      loadImage: async () => ({ width: 200, height: 100 }),
      createCanvas: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: () => undefined, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) }) }),
      minUploadIntervalMs: 0
    });
    sessions.sync();
    sessions.sync();
    sessions.sync();
    const playback: BevyAnimationPlayback | null = { nodeId: "fs", clipId: null, sourceIdentity: "edit", generation: 1 } as unknown as BevyAnimationPlayback;
    filmSetMediaSources("fs", canvas.nodeData.fs!, playback);
    expect(decode).toHaveBeenCalledTimes(1);
    sessions.dispose();
  });

  it("未变化内容不重复做整包预算序列化（utf8Bytes/TextEncoder）；内容变化后才重做", () => {
    // 先行构建数据，避免 createFilmSetSnapshot 自身的编码计入。
    const data = filmSetData();
    let encodeCalls = 0;
    class CountingTextEncoder extends TextEncoder {
      encode(input?: string) { encodeCalls += 1; return super.encode(input); }
    }
    vi.stubGlobal("TextEncoder", CountingTextEncoder);
    filmSetMediaSources("fs", data, null);
    const afterFirst = encodeCalls;
    expect(afterFirst).toBeGreaterThan(0);
    // 连续帧（相同对象身份）：预算校验随缓存复用，不再产生任何额外编码。
    filmSetMediaSources("fs", data, null);
    filmSetMediaSources("fs", data, null);
    expect(encodeCalls).toBe(afterFirst);
    // 内容变化：重新解码并重做预算校验。
    filmSetMediaSources("fs", filmSetData(), null);
    expect(encodeCalls).toBeGreaterThan(afterFirst);
  });

  it("重复解析的结论稳定：合法内容结果深度相等，非法内容同样稳定拒绝", () => {
    const data = filmSetData();
    expect(filmSetMediaSources("fs", data, null)).toEqual(filmSetMediaSources("fs", data, null));
    const invalid = { modelScript: "非法" } as unknown as ServerCanvas["nodeData"][string];
    expect(filmSetMediaSources("fs", invalid, null)).toEqual([]);
    expect(filmSetMediaSources("fs", invalid, null)).toEqual([]);
  });
});
