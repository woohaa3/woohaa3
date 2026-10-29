/**
 * 节点媒体纹理同步测试（change: replace-godot-canvas-runtime-with-bevy）。
 *
 * 覆盖：ready 资产上传、按 URL 去重、未就绪/缺失资产不上传、迟到解码丢弃。
 */
import { describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { createTextureSync, TEXTURE_MAX_DIMENSION } from "./texture-sync.js";
import type { BevyRuntime } from "./bevy-runtime.js";
import { IMAGE_RETRY_DELAYS_MS, ImageLoadError } from "./image-load.js";

function canvas(withAsset: boolean, nodeType: "image" | "video" = "image"): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  return {
    ...base,
    revision: 1,
    document: {
      ...base.document,
      nodes: [{ id: "n1", type: nodeType, position: { x: 0, y: 0 } }]
    },
    nodeData: { n1: { outputAssetId: "asset-1" } },
    assets: withAsset
      ? [{ id: "asset-1", title: "t", mediaKind: nodeType, source: "generated", status: "ready", url: "/api/media/sha256-x", createdAt: "2026-09-26T00:00:00.000Z" }]
      : []
  };
}

function fakeImage(width = 100, height = 60): HTMLImageElement {
  return { width, height } as HTMLImageElement;
}

function fakeCanvasContext() {
  const calls: string[] = [];
  const context = {
    fillStyle: "",
    fillRect: () => calls.push("fillRect"),
    drawImage: () => calls.push("drawImage"),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4)
    })
  };
  return { context, calls };
}

function runtimeRecorder() {
  const uploaded: Array<{ id: string; width: number; height: number }> = [];
  const runtime = {
    setTexture: (id: string, width: number, height: number) => uploaded.push({ id, width, height })
  } as unknown as BevyRuntime;
  return { runtime, uploaded };
}

describe("createTextureSync", () => {
  it("合并同批图片解码与上传通知，但不推迟纹理上传和加载状态", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { context } = fakeCanvasContext();
    const { runtime, uploaded } = runtimeRecorder();
    const current = canvas(true);
    const sync = createTextureSync({
      runtime, getCanvas: () => current, onChange,
      createCanvas: () => ({ width: 0, height: 0, getContext: () => context }),
      loadImage: async () => fakeImage()
    });
    try {
      sync.sync();
      expect(sync.isLoading?.("n1")).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      sync.sync();
      expect(uploaded).toHaveLength(1);
      expect(sync.isLoading?.("n1")).toBe(false);
      expect(onChange).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(80);
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      sync.dispose();
      vi.useRealTimers();
    }
  });

  it("坏图片持续失败不阻断其他资源；未上传不标记可用，手动重试可恢复", async () => {
    const { context } = fakeCanvasContext();
    const current = canvas(true);
    current.document.nodes.push({ id: "n2", type: "image", position: { x: 300, y: 0 } });
    current.nodeData.n2 = { outputAssetId: "asset-1" };
    let bad = true;
    let retryVersion = 0;
    const setTexture = vi.fn((id: string) => { if (id === "n1" && bad) throw "Invalid texture"; });
    const runtime = { setTexture, retryVersion: () => retryVersion } as unknown as BevyRuntime;
    const sync = createTextureSync({ runtime, getCanvas: () => current, loadImage: async () => fakeImage(),
      createCanvas: () => ({ width: 0, height: 0, getContext: () => context }) });
    sync.sync();
    await new Promise(resolve => setTimeout(resolve, 0));
    for (let frame = 0; frame < 3; frame++) expect(() => sync.sync()).not.toThrow();
    expect(setTexture.mock.calls.map(call => call[0])).toEqual(["n1", "n2"]);
    expect([...sync.textureNodeIds()]).toEqual(["n2"]);
    expect(sync.isLoading?.("n1")).toBe(false);
    bad = false; retryVersion++;
    sync.sync();
    expect([...sync.textureNodeIds()].sort()).toEqual(["n1", "n2"]);
    sync.dispose();
  });

  it("聚焦升级失败且卡片解码迟到时仍上传回退；退出重传原图", async () => {
    const { context } = fakeCanvasContext();
    const setTexture = vi.fn((_id: string, width: number) => { if (width > 2048) throw "Invalid texture"; });
    let override: { nodeId: string; width: number; height: number; pixels: Uint8Array } | null = {
      nodeId: "n1", width: 4096, height: 1, pixels: new Uint8Array(4096 * 4) };
    const sync = createTextureSync({ runtime: { setTexture } as unknown as BevyRuntime,
      getCanvas: () => canvas(true), getFocusTexture: () => override,
      loadImage: async () => fakeImage(), createCanvas: () => ({ width: 0, height: 0, getContext: () => context }) });
    sync.sync();
    expect(sync.textureNodeIds().size).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 0));
    sync.sync(); sync.sync();
    expect(setTexture.mock.calls.map(call => call[1])).toEqual([4096, 100]);
    expect([...sync.textureNodeIds()]).toEqual(["n1"]);
    override = null; sync.sync();
    expect(setTexture.mock.calls.map(call => call[1])).toEqual([4096, 100, 100]);
    sync.dispose();
  });

  it("图片从解码到纹理上传都显示加载，失败/换源/删除不留下过期提示", async () => {
    const { context } = fakeCanvasContext();
    const requests: Array<{ resolve: (image: HTMLImageElement) => void; reject: () => void }> = [];
    let current = canvas(true);
    const sync = createTextureSync({
      runtime: runtimeRecorder().runtime,
      getCanvas: () => current,
      createCanvas: () => ({ width: 0, height: 0, getContext: () => context }),
      loadImage: () => new Promise((resolve, reject) => requests.push({ resolve, reject: () => reject(new Error("decode")) }))
    });
    sync.sync();
    expect(sync.isLoading?.("n1")).toBe(true);
    current = { ...current, assets: current.assets.map(asset => ({ ...asset, url: "/api/media/new" })) };
    sync.sync();
    requests[0].reject();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sync.isLoading?.("n1")).toBe(true);
    requests[1].resolve(fakeImage());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sync.isLoading?.("n1")).toBe(true);
    sync.sync();
    expect(sync.isLoading?.("n1")).toBe(false);
    current = { ...current, assets: current.assets.map(asset => ({ ...asset, url: "/api/media/bad" })) };
    sync.sync();
    requests[2].reject();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sync.isLoading?.("n1")).toBe(false);
    current = { ...current, assets: current.assets.map(asset => ({ ...asset, url: "/api/media/deleted" })) };
    sync.sync();
    expect(sync.isLoading?.("n1")).toBe(true);
    current = canvas(false);
    sync.sync();
    requests[3].resolve(fakeImage());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sync.isLoading?.("n1")).toBe(false);
    sync.dispose();
  });

  it("上传幽灵节点本地预览 URL（object URL）", async () => {
    (globalThis as unknown as { document: unknown }).document = {
      createElement: () => {
        const { context } = fakeCanvasContext();
        return { width: 0, height: 0, getContext: () => context };
      }
    };
    // 画布无节点；预览 URL 由 ghost 提供。
    let previews = new Map<string, string>([["ghost-1", "blob:local/preview"]]);
    const { runtime, uploaded } = runtimeRecorder();
    const sync = createTextureSync({
      runtime,
      getCanvas: () => canvas(false),
      getPreviewUrls: () => previews,
      loadImage: async () => fakeImage(80, 40)
    });
    sync.sync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    sync.sync();
    expect(uploaded).toEqual([{ id: "ghost-1", width: 80, height: 40 }]);
    // 移除预览后不再有该纹理。
    previews = new Map();
    sync.sync();
    expect(uploaded).toHaveLength(1);
    sync.dispose();
  });

  it("uploads a ready image asset once", async () => {
    (globalThis as unknown as { document: unknown }).document = {
      createElement: () => {
        const { context } = fakeCanvasContext();
        return { width: 0, height: 0, getContext: () => context };
      }
    };
    let current = canvas(true);
    const urls: string[] = [];
    const { runtime, uploaded } = runtimeRecorder();
    const sync = createTextureSync({
      runtime,
      getCanvas: () => current,
      loadImage: async (url) => { urls.push(url); return fakeImage(100, 60); }
    });
    sync.sync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    sync.sync();
    // 画布作用域纹理按当前画布读媒体（带 ?canvas= 提示）。
    expect(urls).toEqual(["/api/media/sha256-x?canvas=c1"]);
    // 纹理尺寸保持图片自身比例（100x60），不填充、不裁剪。
    expect(uploaded).toEqual([{ id: "n1", width: 100, height: 60 }]);
    sync.dispose();
  });

  it("纹理最长边不超过上限且保持比例（不填充）", async () => {
    (globalThis as unknown as { document: unknown }).document = {
      createElement: () => {
        const { context } = fakeCanvasContext();
        return { width: 0, height: 0, getContext: () => context };
      }
    };
    let current = canvas(true);
    const { runtime, uploaded } = runtimeRecorder();
    // 4000x2000 → 缩放到最长边 1024，比例仍为 2:1。
    const sync = createTextureSync({ runtime, getCanvas: () => current, loadImage: async () => fakeImage(4000, 2000) });
    sync.sync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    sync.sync();
    const [upload] = uploaded;
    expect(upload.width).toBe(TEXTURE_MAX_DIMENSION);
    expect(upload.width / upload.height).toBeCloseTo(2, 2);
    sync.dispose();
  });

  it("does not upload when the asset is missing", async () => {
    let current = canvas(false);
    const { runtime, uploaded } = runtimeRecorder();
    const sync = createTextureSync({ runtime, getCanvas: () => current, loadImage: async () => fakeImage() });
    sync.sync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(uploaded).toHaveLength(0);
    sync.dispose();
  });

  it("drops a late decode after the node is removed", async () => {
    (globalThis as unknown as { document: unknown }).document = {
      createElement: () => {
        const { context } = fakeCanvasContext();
        return { width: 0, height: 0, getContext: () => context };
      }
    };
    let resolveDecode: (image: HTMLImageElement) => void = () => undefined;
    const loadImage = () => new Promise<HTMLImageElement>((resolve) => { resolveDecode = resolve; });
    let current = canvas(true);
    const { runtime, uploaded } = runtimeRecorder();
    const sync = createTextureSync({ runtime, getCanvas: () => current, loadImage });
    sync.sync();
    // 解码完成前移除节点。
    current = canvas(false);
    sync.sync();
    resolveDecode(fakeImage());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(uploaded).toHaveLength(0);
    sync.dispose();
  });

  it("视频节点不再由图片路径解码（交由 video-frame-session 负责）", async () => {
    (globalThis as unknown as { document: unknown }).document = {
      createElement: () => {
        const { context } = fakeCanvasContext();
        return { width: 0, height: 0, getContext: () => context };
      }
    };
    const base = canvas(true, "video");
    const withPoster: ServerCanvas = {
      ...base,
      assets: base.assets.map((asset) => ({ ...asset, mediaKind: "video", posterUrl: "/api/media/sha256-poster" }))
    };
    const urls: string[] = [];
    const { runtime, uploaded } = runtimeRecorder();
    const sync = createTextureSync({
      runtime,
      getCanvas: () => withPoster,
      loadImage: async (url) => {
        urls.push(url);
        return fakeImage();
      }
    });
    sync.sync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    sync.sync();
    // 视频画面由视频会话上传；此处不应对 video 节点做图片解码。
    expect(urls).toEqual([]);
    expect(uploaded).toEqual([]);
    sync.dispose();
  });
});

it("细节整批上传/去重，失败清理旧区域，重建与重试重传，退出清空",()=>{
  const failed=vi.fn();
  let details:import('./focus-details.js').ImageFocusDetails|null={nodeId:'n1',width:4096,height:3000,onUploadFailure:failed,tiles:[{x:0,y:0,width:1,height:1,pixels:new Uint8Array(4)}]};
  let generation=0,retry=0;
  const upload=vi.fn();
  const runtime={setTexture:vi.fn(),setImageFocusDetails:upload,generation:()=>generation,retryVersion:()=>retry} as unknown as BevyRuntime;
  const sync=createTextureSync({runtime,getCanvas:()=>canvas(false),getFocusDetails:()=>details});
  sync.sync();expect(upload.mock.calls).toEqual([[details]]);sync.sync();expect(upload).toHaveBeenCalledTimes(1);
  generation++;sync.sync();expect(upload).toHaveBeenCalledTimes(2);
  upload.mockImplementationOnce(()=>{throw new Error('upload failed');});
  details={...details!};sync.sync();expect(upload.mock.calls.slice(-2)).toEqual([[details],[null]]);
  expect(failed).toHaveBeenCalledOnce();
  const count=upload.mock.calls.length;sync.sync();expect(upload).toHaveBeenCalledTimes(count);
  retry++;sync.sync();expect(upload).toHaveBeenCalledTimes(count+1);
  details=null;sync.sync();expect(upload).toHaveBeenLastCalledWith(null);
  sync.dispose();expect(upload).toHaveBeenLastCalledWith(null);
});

it("传输失败按有界退避自动重试，健康素材不会被一次重启永久钉成错误", async () => {
  vi.useFakeTimers();
  try {
    const { context } = fakeCanvasContext();
    (globalThis as unknown as { document: unknown }).document = {
      createElement: () => ({ width: 0, height: 0, getContext: () => context })
    };
    const reported: Array<{ key: string }> = [];
    const cleared: string[] = [];
    const { runtime, uploaded } = runtimeRecorder();
    const runtimeWithIssues = Object.assign(runtime, {
      reportRuntimeIssue: (issue: { key: string }) => reported.push(issue),
      clearRuntimeIssue: (key: string) => cleared.push(key)
    }) as unknown as BevyRuntime;
    let attempts = 0;
    const sync = createTextureSync({
      runtime: runtimeWithIssues,
      getCanvas: () => canvas(true),
      loadImage: async () => {
        attempts += 1;
        // 前两次是媒体服务重启期的 502，之后恢复。
        if (attempts <= 2) throw new ImageLoadError("图片加载失败（HTTP 502）。", true);
        return fakeImage(100, 60);
      }
    });
    sync.sync();
    await vi.advanceTimersByTimeAsync(0);
    // 第一次失败不报错、不放弃：转入退避重试，卡片保持加载中。
    expect(reported).toHaveLength(0);
    expect(sync.isLoading?.("n1")).toBe(true);
    await vi.advanceTimersByTimeAsync(IMAGE_RETRY_DELAYS_MS[0]);
    expect(attempts).toBe(2);
    expect(reported).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(IMAGE_RETRY_DELAYS_MS[1]);
    expect(attempts).toBe(3);
    // 解码成功后由下一次 sync 完成上传（与既有路径一致）。
    sync.sync();
    // 恢复后照常上传，并且错误摘要被清掉（不会残留一条过期错误）。
    expect(uploaded).toEqual([{ id: "n1", width: 100, height: 60 }]);
    expect(reported).toHaveLength(0);
    expect(cleared).toContain("decode:image:n1");
    sync.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it("内容失败不自动重试，只在明确重试时重新解码", async () => {
  vi.useFakeTimers();
  try {
    const { context } = fakeCanvasContext();
    (globalThis as unknown as { document: unknown }).document = {
      createElement: () => ({ width: 0, height: 0, getContext: () => context })
    };
    const reported: Array<{ key: string }> = [];
    let retry = 0;
    const runtime = Object.assign(runtimeRecorder().runtime, {
      reportRuntimeIssue: (issue: { key: string }) => reported.push(issue),
      retryVersion: () => retry
    }) as unknown as BevyRuntime;
    let attempts = 0;
    const sync = createTextureSync({
      runtime,
      getCanvas: () => canvas(true),
      loadImage: async () => { attempts += 1; throw new ImageLoadError("图片加载失败（HTTP 404）。", false); }
    });
    sync.sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(reported.map(issue => issue.key)).toEqual(["decode:image:n1"]);
    // 退避窗口全部走完也不再尝试：内容失败不会被当成抖动。
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toBe(1);
    retry += 1;
    sync.sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(2);
    sync.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it("退避期间删除节点不会再对该内容重试", async () => {
  vi.useFakeTimers();
  try {
    const { context } = fakeCanvasContext();
    (globalThis as unknown as { document: unknown }).document = {
      createElement: () => ({ width: 0, height: 0, getContext: () => context })
    };
    let attempts = 0;
    let current = canvas(true);
    const sync = createTextureSync({
      runtime: runtimeRecorder().runtime,
      getCanvas: () => current,
      loadImage: async () => { attempts += 1; throw new ImageLoadError("图片加载失败（HTTP 503）。", true); }
    });
    sync.sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    current = canvas(false);
    sync.sync();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toBe(1);
    sync.dispose();
  } finally {
    vi.useRealTimers();
  }
});
