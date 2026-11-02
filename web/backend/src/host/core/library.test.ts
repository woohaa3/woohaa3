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

function makeRes(): FakeRes {
  const res = {
    statusCode: 0,
    body: "",
    headers: {} as Record<string, string>,
    writableEnded: false,
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      Object.assign(this.headers, headers ?? {});
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value;
    },
    end(chunk?: string) {
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
  return {
    async importFromUrl() {
      return {
        storageKey: "ab/cd",
        contentType: "image/png",
        size: 42,
        checksum: "c".repeat(64),
        ...metadata
      } as MediaMetadata;
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
