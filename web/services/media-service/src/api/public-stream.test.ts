import { createServer, type Server } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { MediaObjectNotFoundError, type MediaStorage } from "@woohaa3/contracts";
import { createMediaRequestHandler } from "./public-handler.js";

const KEY = `sha256-${"a".repeat(64)}`;
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function serve(overrides: Partial<MediaStorage> = {}) {
  const get = vi.fn(() => { throw new Error("不应下载完整对象"); });
  const openRead = vi.fn(async (_key: string, range?: { start: number; end: number }, _scope?: unknown) => {
    const bytes = Buffer.from("abcdef").subarray(range?.start ?? 0, (range?.end ?? 5) + 1);
    return { bytes: (async function* () { yield bytes; })(), cancel: vi.fn() };
  });
  const storage: MediaStorage = {
    put: async () => {}, exists: async () => true, get, openRead,
    stat: async () => ({ size: 6, contentType: "video/mp4" }), ...overrides
  };
  const handler = createMediaRequestHandler({ storage });
  const server = createServer((req, res) => { void handler(req, res); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/media/${KEY}`, get, openRead };
}

it.each([
  ["bytes=1-3", "bcd", { start: 1, end: 3 }],
  ["bytes=2-", "cdef", { start: 2, end: 5 }],
  ["bytes=-2", "ef", { start: 4, end: 5 }],
  ["bytes=4-100", "ef", { start: 4, end: 5 }]
])("将 %s 直接下推到存储，不读取完整对象", async (header, text, range) => {
  const { url, get, openRead } = await serve();
  const response = await fetch(url, { headers: { range: header } });
  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe(`bytes ${range.start}-${range.end}/6`);
  expect(response.headers.get("content-length")).toBe(String(text.length));
  expect(await response.text()).toBe(text);
  expect(openRead).toHaveBeenCalledWith(KEY, range, undefined);
  expect(get).not.toHaveBeenCalled();
});

it("canvas 查询参数作为作用域下推到 openRead", async () => {
  const { url, get, openRead } = await serve();
  const response = await fetch(url + "?canvas=canvas-1", { headers: { range: "bytes=1-3" } });
  expect(response.status).toBe(206);
  expect(await response.text()).toBe("bcd");
  expect(openRead).toHaveBeenCalledWith(KEY, { start: 1, end: 3 }, { canvasId: "canvas-1" });
  expect(get).not.toHaveBeenCalled();
});

it("首段立即返回；一个慢视频不会挡住另一个视频", async () => {
  const slow = new PassThrough();
  const cancel = vi.fn(() => slow.destroy());
  let reads = 0;
  const { url } = await serve({ openRead: async () => {
    if (++reads === 1) return { bytes: slow, cancel };
    return { bytes: (async function* () { yield Buffer.from("abcdef"); })(), cancel: () => {} };
  } });
  const pending = fetch(url, { headers: { range: "bytes=0-" } });
  slow.write("ab");
  const first = await pending;
  const reader = first.body!.getReader();
  expect(Buffer.from((await reader.read()).value!).toString()).toBe("ab");
  const second = await fetch(url);
  expect(await second.text()).toBe("abcdef");
  slow.end("cdef");
  expect(Buffer.from((await reader.read()).value!).toString()).toBe("cdef");
  expect((await reader.read()).done).toBe(true);
});

it("浏览器取消预取时停止上游视频流", async () => {
  const source = new PassThrough();
  const cancel = vi.fn(() => source.destroy());
  const { url } = await serve({ openRead: async () => ({ bytes: source, cancel }) });
  const pending = fetch(url);
  source.write("ab");
  const response = await pending;
  await response.body!.cancel();
  await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  expect(source.destroyed).toBe(true);
});

it.each(["bytes=9-", "bytes=3-1", "bytes=0-1,3-4"])("无效区间 %s 不启动下载", async range => {
  const { url, get, openRead } = await serve();
  const response = await fetch(url, { headers: { range } });
  expect(response.status).toBe(416);
  expect(response.headers.get("content-range")).toBe("bytes */6");
  expect(openRead).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});

it("HEAD 和不存在对象只读取 metadata", async () => {
  const { url, get, openRead } = await serve();
  const head = await fetch(url, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe("6");
  expect(openRead).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
  const missing = await serve({ stat: async () => { throw new MediaObjectNotFoundError(KEY); } });
  expect((await fetch(missing.url)).status).toBe(404);
  expect(missing.openRead).not.toHaveBeenCalled();
});

it("上游中途断流时终止响应，不把错误 JSON 拼入视频", async () => {
  const source = new PassThrough();
  const { url } = await serve({ openRead: async () => ({ bytes: source, cancel: () => source.destroy() }) });
  const pending = fetch(url);
  source.write("ab");
  const response = await pending;
  source.destroy(new Error("存储连接断开"));
  await expect(response.arrayBuffer()).rejects.toThrow();
});
