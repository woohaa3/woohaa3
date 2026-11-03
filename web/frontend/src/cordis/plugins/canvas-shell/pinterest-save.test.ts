/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasCommand } from "@woohaa3/contracts";
import {
  buildExternalAsset,
  handlePinterestSave,
  installPinterestSave,
  planPlaceOnCanvas,
  registerLibraryItem,
  reportToDesktop,
  takeBlobFromDesktop,
  type PinterestSaveDeps,
  type PinterestSaveEvent
} from "./pinterest-save.js";

type Globals = typeof globalThis & { __WOOHAA_DESKTOP__?: unknown };

const MEDIA = {
  storageKey: `sha256-${"a".repeat(64)}`,
  checksum: "a".repeat(64),
  contentType: "image/jpeg",
  size: 1234,
  url: `/api/media/sha256-${"a".repeat(64)}`,
  deduplicated: false
};

const EVENT: PinterestSaveEvent = {
  id: "blob-1",
  mode: "library",
  title: "休息室",
  sourceUrl: "https://i.pinimg.com/originals/ab/x.jpg",
  pageUrl: "https://www.pinterest.com/pin/1/"
};

function deps(overrides: Partial<PinterestSaveDeps> = {}): PinterestSaveDeps {
  return {
    takeBlob: vi.fn(async () => new File([new Uint8Array([1, 2, 3])], "pinterest", { type: "image/jpeg" })),
    upload: vi.fn(async () => ({ ok: true as const, media: MEDIA })),
    registerLibrary: vi.fn(async () => undefined),
    canvas: {
      isWritable: () => true,
      hasCanvas: () => true,
      center: () => ({ x: 100, y: 200, zoom: 1 }),
      nearby: () => 0,
      submit: vi.fn(() => ({ ok: true as const }))
    },
    ...overrides
  };
}

afterEach(() => {
  delete (globalThis as Globals).__WOOHAA_DESKTOP__;
  delete window.__sixiPinterestSave;
  vi.unstubAllGlobals();
});

describe("外部导入资产", () => {
  it("来源是 external，稳定引用来自上传结果，不是页面给的地址", () => {
    const asset = buildExternalAsset({ media: MEDIA, title: "休息室", now: "2026-11-03T00:00:00.000Z" });
    expect(asset).toMatchObject({
      mediaKind: "image",
      source: "external",
      status: "ready",
      url: MEDIA.url,
      metadata: { storageKey: MEDIA.storageKey, checksum: MEDIA.checksum, contentType: "image/jpeg", size: 1234 }
    });
    expect(asset.id).toBe(`asset-upload-${MEDIA.checksum}`);
    // 标题就是用户看到的那一个（页面给的 alt），不带文件扩展名
    expect(asset.title).toBe("休息室");
  });

  it("满足后端的资产引用校验：storageKey 是受控前缀、checksum 与 key 内嵌哈希一致", () => {
    const { metadata } = buildExternalAsset({ media: MEDIA, title: "x" });
    expect(String(metadata?.storageKey)).toMatch(/^sha256-([0-9a-f]{64})$/);
    expect(String(metadata?.storageKey)).toContain(String(metadata?.checksum));
  });

  it("没有标题时有兜底名，不会是空串", () => {
    expect(buildExternalAsset({ media: MEDIA, title: "" }).title).not.toBe("");
  });
});

describe("发送到画布的命令", () => {
  const asset = buildExternalAsset({ media: MEDIA, title: "休息室" });

  it("先写资产、再插节点，节点引用这个资产", () => {
    const commands = planPlaceOnCanvas({ asset, center: { x: 100, y: 200, zoom: 1 }, nearby: 0 });
    expect(commands[0]).toMatchObject({ type: "asset.upsert", asset: { source: "external" } });
    const insert = commands.find((command) => command.type === "node.add") as Extract<CanvasCommand, { type: "node.add" }>;
    expect(insert).toBeTruthy();
    expect(JSON.stringify(insert)).toContain(asset.id);
  });

  it("连续发送会错开摆放，不叠成一个节点", () => {
    const at = (nearby: number) =>
      JSON.stringify(planPlaceOnCanvas({ asset, center: { x: 100, y: 200, zoom: 1 }, nearby }).find((c) => c.type === "node.add"));
    expect(at(0)).not.toBe(at(1));
  });
});

describe("处理一次保存", () => {
  it("保存到素材库：取图 → 上传 → 登记，成功回报", async () => {
    const d = deps();
    const outcome = await handlePinterestSave(EVENT, d);
    expect(outcome).toEqual({ ok: true, message: "已保存到素材库" });
    expect(d.takeBlob).toHaveBeenCalledWith("blob-1");
    expect(d.registerLibrary).toHaveBeenCalledWith({
      media: MEDIA,
      title: "休息室",
      sourceUrl: EVENT.sourceUrl,
      pageUrl: EVENT.pageUrl
    });
    // 素材库不属于任何画布：不能碰画布
    expect(d.canvas.submit).not.toHaveBeenCalled();
  });

  it("保存到素材库不要求有打开的画布", async () => {
    const d = deps({ canvas: { ...deps().canvas, hasCanvas: () => false, isWritable: () => false } });
    expect((await handlePinterestSave(EVENT, d)).ok).toBe(true);
  });

  it("发送到画布：提交一批命令并回报", async () => {
    const d = deps();
    const outcome = await handlePinterestSave({ ...EVENT, mode: "canvas" }, d);
    expect(outcome).toEqual({ ok: true, message: "已发送到画布" });
    expect(d.canvas.submit).toHaveBeenCalledTimes(1);
    const [commands] = (d.canvas.submit as ReturnType<typeof vi.fn>).mock.calls[0] as [CanvasCommand[]];
    expect(commands[0]?.type).toBe("asset.upsert");
    // 发送到画布不进素材库
    expect(d.registerLibrary).not.toHaveBeenCalled();
  });

  it("没有打开的画布：在上传之前就说清楚，不白传一张图", async () => {
    const d = deps({ canvas: { ...deps().canvas, hasCanvas: () => false } });
    const outcome = await handlePinterestSave({ ...EVENT, mode: "canvas" }, d);
    expect(outcome).toEqual({ ok: false, message: "还没有打开的画布，先打开一张画布再发送" });
    expect(d.takeBlob).not.toHaveBeenCalled();
    expect(d.upload).not.toHaveBeenCalled();
  });

  it("画布只读：同样在上传之前拒绝", async () => {
    const d = deps({ canvas: { ...deps().canvas, isWritable: () => false } });
    const outcome = await handlePinterestSave({ ...EVENT, mode: "canvas" }, d);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("只读");
    expect(d.upload).not.toHaveBeenCalled();
  });

  it("暂存已过期：把原因带给用户，不继续上传", async () => {
    const d = deps({ takeBlob: vi.fn(async () => Promise.reject(new Error("图片已过期，请重新保存"))) });
    const outcome = await handlePinterestSave(EVENT, d);
    expect(outcome).toEqual({ ok: false, message: "图片已过期，请重新保存" });
    expect(d.upload).not.toHaveBeenCalled();
  });

  it("上传失败：带上原因，不登记也不放画布", async () => {
    const d = deps({ upload: vi.fn(async () => ({ ok: false as const, error: "payload-too-large" })) });
    for (const mode of ["library", "canvas"] as const) {
      const outcome = await handlePinterestSave({ ...EVENT, mode }, d);
      expect(outcome).toEqual({ ok: false, message: "上传失败：payload-too-large" });
    }
    expect(d.registerLibrary).not.toHaveBeenCalled();
    expect(d.canvas.submit).not.toHaveBeenCalled();
  });

  it("登记失败：原因直接显示（如后端核验不一致）", async () => {
    const d = deps({ registerLibrary: vi.fn(async () => Promise.reject(new Error("媒体对象与声明的信息不一致"))) });
    expect(await handlePinterestSave(EVENT, d)).toEqual({ ok: false, message: "媒体对象与声明的信息不一致" });
  });

  it("画布拒绝命令：把画布给的原因带回去", async () => {
    const d = deps({
      canvas: { ...deps().canvas, submit: vi.fn(() => ({ ok: false as const, reason: "画布同步冲突" })) }
    });
    expect(await handlePinterestSave({ ...EVENT, mode: "canvas" }, d)).toEqual({ ok: false, message: "画布同步冲突" });
  });

  it("页面给的标题不会被当成代码或路径：文件名里的危险字符被替换", async () => {
    const upload = vi.fn(async (_file: File) => ({ ok: true as const, media: MEDIA }));
    await handlePinterestSave({ ...EVENT, title: '../../evil<script>:"|?*' }, deps({ upload }));
    const name = (upload.mock.calls[0]![0] as File).name;
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
    expect(name.endsWith(".jpeg") || name.endsWith(".jpg")).toBe(true);
  });
});

describe("与桌面壳、后端的 IO", () => {
  const installDesktop = () => {
    (globalThis as Globals).__WOOHAA_DESKTOP__ = { token: "t-1", protocol: "woohaa-window-v1", platform: "windows" };
  };

  it("取图：带主窗口 token 访问原生协议，按 id 取", async () => {
    installDesktop();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2]), { headers: { "Content-Type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const file = await takeBlobFromDesktop("a b");
    expect(file.type).toBe("image/png");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://woohaa-native.localhost/pinterest-blob?id=a%20b");
    expect((init.headers as Record<string, string>)["X-Woohaa-Token"]).toBe("t-1");
  });

  it("取图失败（Rust 回 JSON）：把里面的原因抛出来", async () => {
    installDesktop();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "图片已过期或不存在" }), { status: 200, headers: { "Content-Type": "application/json" } })));
    await expect(takeBlobFromDesktop("x")).rejects.toThrow("图片已过期或不存在");
  });

  it("没有桌面壳：不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(takeBlobFromDesktop("x")).rejects.toThrow("只能在桌面端使用");
    await reportToDesktop({ ok: true, message: "x" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("回报：只发 ok 与 message 两个字段；回报本身失败不抛", async () => {
    installDesktop();
    const fetchMock = vi.fn(async () => Promise.reject(new Error("boom")));
    vi.stubGlobal("fetch", fetchMock);
    await expect(reportToDesktop({ ok: false, message: "失败了" })).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://woohaa-native.localhost/pinterest-result");
    expect(JSON.parse(init.body as string)).toEqual({ ok: false, message: "失败了" });
  });

  it("登记素材库：同源请求，不带令牌头，只带已上传对象的稳定信息", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ item: {} }), { status: 201 }));
    await registerLibraryItem(fetchMock as unknown as typeof fetch, (path) => `/app${path}`, {
      media: MEDIA,
      title: "t",
      sourceUrl: "s",
      pageUrl: "p"
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/app/api/library/register");
    expect(Object.keys(init.headers as Record<string, string>)).toEqual(["Content-Type"]);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ storageKey: MEDIA.storageKey, checksum: MEDIA.checksum, size: 1234 });
    expect(body.bytes).toBeUndefined();
  });

  it("登记素材库失败：优先用后端给的原因", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "素材库只收图片" }), { status: 415 }));
    await expect(
      registerLibraryItem(fetchMock as unknown as typeof fetch, (p) => p, { media: MEDIA, title: "", sourceUrl: "", pageUrl: "" })
    ).rejects.toThrow("素材库只收图片");
  });
});

describe("安装入口", () => {
  it("挂在 window 上给桌面壳 eval 调用，清理后撤销", () => {
    const dispose = installPinterestSave(deps());
    expect(typeof window.__sixiPinterestSave).toBe("function");
    dispose();
    expect(window.__sixiPinterestSave).toBeUndefined();
  });

  it("重复安装：先挂的清理函数只撤销自己，不会把后挂的也清掉（热重载 / 严格模式）", () => {
    const first = installPinterestSave(deps());
    const second = installPinterestSave(deps());
    first();
    expect(typeof window.__sixiPinterestSave).toBe("function");
    second();
    expect(window.__sixiPinterestSave).toBeUndefined();
  });
});
