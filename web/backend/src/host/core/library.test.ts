/**
 * 宿主素材库：索引层与 HTTP 面的测试。
 *
 * 守的是「不属于画布、重复保存幂等、令牌不可省略、只收 http(s)」这几条，
 * 不是媒体层本身（那是 `@woohaa3/media-service` 的测试）。
 *
 * 用真实的临时文件：这一层最容易出错的正是「路径接错了但类型没问题」。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MediaMetadata } from "@woohaa3/contracts";
import { createLibraryApi, LIBRARY_BASE_PATH } from "../../api/library-api.js";
import { createLibraryStore, type LibraryItem } from "./library-store.js";

const temps: string[] = [];

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sixi-library-"));
  temps.push(dir);
  return path.join(dir, "library.json");
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function item(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: "a".repeat(64),
    title: "示例",
    sourceUrl: "https://i.pinimg.com/originals/x.png",
    url: "/api/media/ab/cd",
    storageKey: "ab/cd",
    contentType: "image/png",
    bytes: 1234,
    createdAt: 1000,
    ...overrides
  };
}

describe("素材库索引", () => {
  it("空库读出空数组", async () => {
    const store = createLibraryStore(await tempFile());
    expect(await store.list()).toEqual([]);
  });

  it("写入后能读回，并按时间倒序", async () => {
    const store = createLibraryStore(await tempFile());
    await store.put(item({ id: "a".repeat(64), createdAt: 1000 }));
    await store.put(item({ id: "b".repeat(64), createdAt: 2000 }));
    const list = await store.list();
    expect(list.map((entry) => entry.createdAt)).toEqual([2000, 1000]);
  });

  it("同一内容重复保存只有一条，且保留最早那次", async () => {
    const store = createLibraryStore(await tempFile());
    await store.put(item({ title: "第一次", createdAt: 1000 }));
    const second = await store.put(item({ title: "第二次", createdAt: 2000 }));
    expect(second.duplicated).toBe(true);
    expect(second.item.title).toBe("第一次");
    expect(await store.list()).toHaveLength(1);
  });

  it("删除不存在的 id 返回 false", async () => {
    const store = createLibraryStore(await tempFile());
    expect(await store.remove("nope")).toBe(false);
  });

  it("索引损坏时退化为空库，而不是让素材页整个打不开", async () => {
    const file = await tempFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{not json", "utf8");
    expect(await createLibraryStore(file).list()).toEqual([]);
  });

  it("并发写入不会互相覆盖", async () => {
    const store = createLibraryStore(await tempFile());
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => store.put(item({ id: String(index).padStart(64, "0") })))
    );
    expect(await store.list()).toHaveLength(10);
  });
});

// --- HTTP 面 ---------------------------------------------------------------

type FakeRes = ServerResponse & {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
};

/**
 * 假的 `ServerResponse`，**行为要和真实的 Node 一致**，尤其是这一条：
 * `writeHead` 之后头已经发出，再 `setHeader` 会抛 `ERR_HTTP_HEADERS_SENT`。
 *
 * 之前的替身 `setHeader` 想写就写，于是「先 writeHead 再 setHeader」的 bug 一直测不出来，
 * 真服务器上 `/ping` 直接挂起超时 —— 测试全绿、线上不能用。替身宽松，测试就等于没测。
 */
function makeRes(): FakeRes {
  const res = {
    statusCode: 0,
    body: "",
    headers: {} as Record<string, string>,
    headersSent: false,
    writableEnded: false,
    writeHead(status: number, headers?: Record<string, string | number>) {
      if (this.headersSent) throw new Error("ERR_HTTP_HEADERS_SENT: writeHead called twice");
      this.statusCode = status;
      for (const [key, value] of Object.entries(headers ?? {})) this.headers[key] = String(value);
      this.headersSent = true;
    },
    setHeader(key: string, value: string | number) {
      if (this.headersSent) throw new Error(`ERR_HTTP_HEADERS_SENT: setHeader(${key}) after writeHead`);
      this.headers[key] = String(value);
    },
    end(chunk?: string) {
      if (this.writableEnded) throw new Error("ERR_STREAM_ALREADY_FINISHED");
      // 没写过头就 end：Node 会用默认 200 隐式写头
      if (!this.headersSent) {
        this.statusCode ||= 200;
        this.headersSent = true;
      }
      if (chunk) this.body += chunk;
      this.writableEnded = true;
    }
  };
  return res as unknown as FakeRes;
}

function makeReq(method: string, url: string, body?: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body, "utf8");
    }
  };
  return req as unknown as IncomingMessage;
}

async function readJson(res: FakeRes): Promise<Record<string, unknown>> {
  return JSON.parse(res.body) as Record<string, unknown>;
}

const TOKEN = "secret-token";

function mediaReturning(metadata: Partial<MediaMetadata> = {}) {
  const full = {
    storageKey: "ab/cd",
    contentType: "image/png",
    size: 42,
    checksum: "c".repeat(64),
    ...metadata
  } as MediaMetadata;
  return {
    async importFromUrl() {
      return full;
    },
    async verify(storageKey: string, expected: Partial<Omit<MediaMetadata, "storageKey">> = {}) {
      if (storageKey !== full.storageKey) return { exists: false, matches: false };
      const matches = Object.entries(expected).every(([key, value]) => (full as Record<string, unknown>)[key] === value);
      return { exists: true, matches, metadata: full };
    }
  };
}

async function harness(options: { token?: string; media?: ReturnType<typeof mediaReturning> } = {}) {
  const store = createLibraryStore(await tempFile());
  const api = createLibraryApi({
    store,
    media: options.media ?? mediaReturning(),
    token: options.token ?? TOKEN
  });
  return { store, api };
}

describe("素材库 HTTP", () => {
  it("不管其它路径的请求", async () => {
    const { api } = await harness();
    const res = makeRes();
    expect(await api(makeReq("GET", "/api/media/x"), res)).toBe(false);
  });

  it("/ping 不需要令牌", async () => {
    const { api } = await harness();
    const res = makeRes();
    await api(makeReq("GET", `${LIBRARY_BASE_PATH}/ping`), res);
    expect(res.statusCode).toBe(200);
    expect(await readJson(res)).toMatchObject({ app: "sixi" });
  });

  it("没配令牌时写操作返回 503，绝不静默放行", async () => {
    const { api } = await harness({ token: "" });
    const res = makeRes();
    await api(
      makeReq("POST", `${LIBRARY_BASE_PATH}/import`, JSON.stringify({ url: "https://x/a.png" }), {
        "x-save-token": ""
      }),
      res
    );
    expect(res.statusCode).toBe(503);
  });

  it("令牌不对返回 401", async () => {
    const { api } = await harness();
    const res = makeRes();
    await api(
      makeReq("POST", `${LIBRARY_BASE_PATH}/import`, JSON.stringify({ url: "https://x/a.png" }), {
        "x-save-token": "wrong"
      }),
      res
    );
    expect(res.statusCode).toBe(401);
  });

  it("拒绝非 http(s) 地址", async () => {
    const { api } = await harness();
    for (const url of ["file:///C:/Windows/win.ini", "data:image/png;base64,AAAA"]) {
      const res = makeRes();
      await api(
        makeReq("POST", `${LIBRARY_BASE_PATH}/import`, JSON.stringify({ url }), { "x-save-token": TOKEN }),
        res
      );
      expect(res.statusCode).toBe(400);
    }
  });

  it("下载失败把根因带回给用户", async () => {
    const { api } = await harness({
      media: {
        async importFromUrl() {
          throw new Error("connect ETIMEDOUT");
        },
        async verify() {
          return { exists: false, matches: false };
        }
      }
    });
    const res = makeRes();
    await api(
      makeReq("POST", `${LIBRARY_BASE_PATH}/import`, JSON.stringify({ url: "https://x/a.png" }), {
        "x-save-token": TOKEN
      }),
      res
    );
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain("ETIMEDOUT");
  });

  it("保存成功后返回 201，重复保存返回 200 且不新增", async () => {
    const { api, store } = await harness();
    const send = () =>
      api(
        makeReq("POST", `${LIBRARY_BASE_PATH}/import`, JSON.stringify({ url: "https://x/a.png", title: "椅子" }), {
          "x-save-token": TOKEN
        }),
        makeRes()
      );

    const first = makeRes();
    await api(
      makeReq("POST", `${LIBRARY_BASE_PATH}/import`, JSON.stringify({ url: "https://x/a.png", title: "椅子" }), {
        "x-save-token": TOKEN
      }),
      first
    );
    expect(first.statusCode).toBe(201);

    const second = makeRes();
    await api(
      makeReq("POST", `${LIBRARY_BASE_PATH}/import`, JSON.stringify({ url: "https://x/a.png" }), {
        "x-save-token": TOKEN
      }),
      second
    );
    expect(second.statusCode).toBe(200);
    expect(await readJson(second)).toMatchObject({ duplicated: true });
    expect(await store.list()).toHaveLength(1);
    void send;
  });

  it("列表按时间倒序并带总数", async () => {
    const { api, store } = await harness();
    await store.put(item({ id: "a".repeat(64), createdAt: 1 }));
    await store.put(item({ id: "b".repeat(64), createdAt: 2 }));
    const res = makeRes();
    await api(makeReq("GET", LIBRARY_BASE_PATH), res);
    const body = await readJson(res);
    expect(body.total).toBe(2);
    expect((body.items as LibraryItem[]).map((entry) => entry.createdAt)).toEqual([2, 1]);
  });

  it("删除需要令牌", async () => {
    const { api, store } = await harness();
    await store.put(item());
    const blocked = makeRes();
    await api(makeReq("DELETE", `${LIBRARY_BASE_PATH}/${"a".repeat(64)}`), blocked);
    expect(blocked.statusCode).toBe(401);

    const ok = makeRes();
    await api(makeReq("DELETE", `${LIBRARY_BASE_PATH}/${"a".repeat(64)}`, undefined, { "x-save-token": TOKEN }), ok);
    expect(ok.statusCode).toBe(200);
    expect(await store.list()).toHaveLength(0);
  });

  it("只对扩展来源回 CORS 头", async () => {
    const { api } = await harness();
    const ext = makeRes();
    await api(makeReq("GET", `${LIBRARY_BASE_PATH}/ping`, undefined, { origin: "chrome-extension://abc" }), ext);
    expect(ext.headers["Access-Control-Allow-Origin"]).toBe("chrome-extension://abc");

    const web = makeRes();
    await api(makeReq("GET", `${LIBRARY_BASE_PATH}/ping`, undefined, { origin: "https://evil.example" }), web);
    expect(web.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });
});

describe("素材库 register 与同源鉴权", () => {
  const SAME_ORIGIN = { origin: "http://127.0.0.1:5184", host: "127.0.0.1:5184" };

  const register = (api: ReturnType<typeof createLibraryApi>, body: unknown, headers: Record<string, string>) => {
    const res = makeRes();
    return api(makeReq("POST", `${LIBRARY_BASE_PATH}/register`, JSON.stringify(body), headers), res).then(() => res);
  };

  it("应用自己的页面（同源且 Host 是回环）不需要令牌就能登记已上传的图片", async () => {
    const { api, store } = await harness({ token: "" });
    const res = await register(api, { storageKey: "ab/cd", title: "椅子" }, SAME_ORIGIN);
    expect(res.statusCode).toBe(201);
    const [saved] = await store.list();
    expect(saved).toMatchObject({ id: "c".repeat(64), title: "椅子", url: "/api/media/ab/cd" });
  });

  it("重复登记同一个对象返回 200 且不新增", async () => {
    const { api, store } = await harness({ token: "" });
    await register(api, { storageKey: "ab/cd" }, SAME_ORIGIN);
    const again = await register(api, { storageKey: "ab/cd" }, SAME_ORIGIN);
    expect(again.statusCode).toBe(200);
    expect(await store.list()).toHaveLength(1);
  });

  it("DNS 重绑定：攻击页的 Origin 与 Host 是同一个外部域名，即使「同源」也必须拒绝", async () => {
    const { api } = await harness({ token: "" });
    const res = await register(api, { storageKey: "ab/cd" }, { origin: "http://evil.example:5184", host: "evil.example:5184" });
    // 没配置令牌又不是回环同源 → 503，而不是放行
    expect(res.statusCode).toBe(503);
  });

  it("跨源请求（Origin 与 Host 不一致）不能靠同源通过，只能靠令牌", async () => {
    const { api } = await harness();
    const foreign = { origin: "https://evil.example", host: "127.0.0.1:5184" };
    expect((await register(api, { storageKey: "ab/cd" }, foreign)).statusCode).toBe(401);
    expect((await register(api, { storageKey: "ab/cd" }, { ...foreign, "x-save-token": TOKEN })).statusCode).toBe(201);
  });

  it("扩展来源（chrome-extension://）不同源，仍然要令牌", async () => {
    const { api } = await harness();
    const ext = { origin: "chrome-extension://abc", host: "127.0.0.1:5184" };
    expect((await register(api, { storageKey: "ab/cd" }, ext)).statusCode).toBe(401);
  });

  it("没有 Origin 也没有令牌（curl / 本机其它进程）一律拒绝", async () => {
    const { api } = await harness({ token: "" });
    expect((await register(api, { storageKey: "ab/cd" }, {})).statusCode).toBe(503);
  });

  it("经 x-forwarded-host 转发时按转发的 Host 判同源（dev 代理 / ingress）", async () => {
    const { api } = await harness({ token: "" });
    const res = await register(
      api,
      { storageKey: "ab/cd" },
      { origin: "http://127.0.0.1:5184", host: "127.0.0.1:5191", "x-forwarded-host": "127.0.0.1:5184" }
    );
    expect(res.statusCode).toBe(201);
  });

  it("媒体对象不存在 → 404；声明与实际不一致 → 409；不是图片 → 415", async () => {
    const { api } = await harness({ token: "" });
    expect((await register(api, { storageKey: "no/such" }, SAME_ORIGIN)).statusCode).toBe(404);
    expect((await register(api, { storageKey: "ab/cd", checksum: "f".repeat(64) }, SAME_ORIGIN)).statusCode).toBe(409);

    const video = await harness({ token: "", media: mediaReturning({ contentType: "video/mp4" }) });
    expect((await register(video.api, { storageKey: "ab/cd" }, SAME_ORIGIN)).statusCode).toBe(415);
  });

  it("不信任客户端自报的 contentType：以核验返回的 metadata 为准", async () => {
    const { api, store } = await harness({ token: "" });
    // 客户端谎称是 png 之外的类型会因不一致被 409 拦下；一致时入库的字段来自核验结果
    const res = await register(api, { storageKey: "ab/cd", contentType: "image/png", size: 42 }, SAME_ORIGIN);
    expect(res.statusCode).toBe(201);
    expect((await store.list())[0]).toMatchObject({ contentType: "image/png", bytes: 42 });
  });

  it("缺 storageKey / 非法 sourceUrl：前者 400，后者被丢弃而不是存下去", async () => {
    const { api, store } = await harness({ token: "" });
    expect((await register(api, {}, SAME_ORIGIN)).statusCode).toBe(400);
    await register(api, { storageKey: "ab/cd", sourceUrl: "file:///C:/Windows/win.ini" }, SAME_ORIGIN);
    expect((await store.list())[0]?.sourceUrl).toBe("");
  });

  it("旧的 import 仍然要令牌：同源页面能走 register，但 import 的鉴权规则同样适用", async () => {
    // import 与 register 共用 authorize：令牌或同源回环二选一
    const { api } = await harness({ token: "" });
    const res = makeRes();
    await api(makeReq("POST", `${LIBRARY_BASE_PATH}/import`, JSON.stringify({ url: "https://x/a.png" }), {}), res);
    expect(res.statusCode).toBe(503);
  });
});

describe("真实 http.Server（替身测不出的那一类问题）", () => {
  async function withServer<T>(token: string, run: (base: string) => Promise<T>): Promise<T> {
    const { createServer } = await import("node:http");
    const store = createLibraryStore(await tempFile());
    const api = createLibraryApi({ store, media: mediaReturning(), token });
    const server = createServer((req, res) => {
      void api(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      return await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it("/ping 带 Content-Type 与 JSON body，而不是空响应或挂起", async () => {
    await withServer(TOKEN, async (base) => {
      const response = await fetch(`${base}${LIBRARY_BASE_PATH}/ping`, { signal: AbortSignal.timeout(3000) });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toMatchObject({ app: "sixi" });
    });
  });

  it("列表、错误响应也都是带头的 JSON", async () => {
    await withServer(TOKEN, async (base) => {
      const list = await fetch(`${base}${LIBRARY_BASE_PATH}`, { signal: AbortSignal.timeout(3000) });
      expect(list.headers.get("content-type")).toContain("application/json");
      expect(await list.json()).toEqual({ items: [], total: 0 });

      const denied = await fetch(`${base}${LIBRARY_BASE_PATH}/import`, {
        method: "POST",
        body: "{}",
        signal: AbortSignal.timeout(3000)
      });
      expect(denied.status).toBe(401);
      expect(denied.headers.get("content-type")).toContain("application/json");
      expect(await denied.json()).toEqual({ error: "令牌不对" });
    });
  });

  it("CORS 预检：扩展来源拿到允许头，204 且没有 body", async () => {
    await withServer(TOKEN, async (base) => {
      const response = await fetch(`${base}${LIBRARY_BASE_PATH}/import`, {
        method: "OPTIONS",
        headers: { Origin: "chrome-extension://abc" },
        signal: AbortSignal.timeout(3000)
      });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("chrome-extension://abc");
      expect(response.headers.get("access-control-allow-headers")).toContain("X-Save-Token");
    });
  });

  it("同源回环登记：真实请求头（Origin 与 Host）走通 register", async () => {
    await withServer("", async (base) => {
      const origin = new URL(base).origin;
      const response = await fetch(`${base}${LIBRARY_BASE_PATH}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ storageKey: "ab/cd", title: "椅子" }),
        signal: AbortSignal.timeout(3000)
      });
      expect(response.status).toBe(201);
      expect(((await response.json()) as { item: { title: string } }).item.title).toBe("椅子");
    });
  });
});
