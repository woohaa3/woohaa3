/**
 * 提示词库的数据面测试：解码、筛选、收藏与草稿合并。
 *
 * 都是纯函数，不联网、不碰 DOM（收藏那条用内存 localStorage 替身）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeSnapshot,
  fetchPromptLibrary,
  filterPrompts,
  mergePromptText,
  readFavorites,
  writeFavorites,
  type PromptEntry
} from "./prompt-library.js";

const entry = (patch: Partial<PromptEntry> = {}): PromptEntry => ({
  id: "p1",
  title: "3D 操作轴测图",
  text: "生成一张轴测视角的室内操作图",
  category: "室内设计",
  tags: ["室内", "轴测"],
  createdAt: "",
  updatedAt: "",
  ...patch
});

describe("decodeSnapshot", () => {
  it("接受后端快照并保留字段", () => {
    const decoded = decodeSnapshot({
      version: "1.0",
      categories: ["室内设计", "建筑"],
      prompts: [entry(), entry({ id: "p2" })],
      fetchedAt: 123
    });
    expect(decoded).not.toBeNull();
    expect(decoded!.prompts).toHaveLength(2);
    expect(decoded!.categories).toEqual(["室内设计", "建筑"]);
    expect(decoded!.fetchedAt).toBe(123);
  });

  it("丢掉没有 id 或正文为空的条目，但不让整包失败", () => {
    const decoded = decodeSnapshot({
      categories: [],
      prompts: [entry(), { id: "", text: "x" }, { id: "p3", text: "   " }, 42]
    });
    expect(decoded?.prompts.map((p) => p.id)).toEqual(["p1"]);
  });

  it("分类表缺项时用条目里出现过的补上", () => {
    const decoded = decodeSnapshot({
      categories: ["建筑"],
      prompts: [entry({ category: "景观" }), entry({ id: "p2", category: "建筑" })]
    });
    expect(decoded?.categories).toEqual(["建筑", "景观"]);
  });

  it("非图片 data URI 不当作缩略图", () => {
    const decoded = decodeSnapshot({
      categories: [],
      prompts: [entry({ imageUrl: "data:text/plain;base64,AAA" })]
    });
    expect(decoded?.prompts[0]?.imageUrl).toBeUndefined();
  });

  it("结构不对时返回 null", () => {
    expect(decodeSnapshot(null)).toBeNull();
    expect(decodeSnapshot({ prompts: "nope" })).toBeNull();
  });
});

describe("filterPrompts", () => {
  const list = [
    entry(),
    entry({ id: "p2", title: "室内海报", text: "设计一张海报", category: "建筑设计", tags: ["海报"] }),
    entry({ id: "p3", title: "门厅", text: "留白与光线", category: "室内设计", tags: [] })
  ];

  it("关键词命中标题、正文或标签", () => {
    expect(filterPrompts(list, { keyword: "海报" }).map((p) => p.id)).toEqual(["p2"]);
    expect(filterPrompts(list, { keyword: "光线" }).map((p) => p.id)).toEqual(["p3"]);
    expect(filterPrompts(list, { keyword: "轴测" }).map((p) => p.id)).toEqual(["p1"]);
  });

  it("关键词与分类同时生效", () => {
    expect(filterPrompts(list, { keyword: "室内", category: "室内设计" }).map((p) => p.id)).toEqual(["p1"]);
  });

  it("空关键词返回该分类全部", () => {
    expect(filterPrompts(list, { category: "建筑设计" }).map((p) => p.id)).toEqual(["p2"]);
    expect(filterPrompts(list)).toHaveLength(3);
  });

  it("忽略大小写与首尾空格", () => {
    const latin = [entry({ title: "MasterPlan", text: "" })];
    expect(filterPrompts(latin, { keyword: "  master " })).toHaveLength(1);
  });
});

describe("mergePromptText", () => {
  it("空草稿直接写入", () => {
    expect(mergePromptText("", "  一段提示词 \n")).toBe("一段提示词");
  });

  it("非空草稿追加在换行之后，不覆盖原名", () => {
    expect(mergePromptText("我想要的:", "一段提示词")).toBe("我想要的:\n一段提示词");
  });

  it("去掉草稿尾部空白后再拼，避免多出空行", () => {
    expect(mergePromptText("已有内容\n\n", "新内容")).toBe("已有内容\n新内容");
  });

  it("空提示词不改动草稿", () => {
    expect(mergePromptText("原文", "   ")).toBe("原文");
  });
});

describe("收藏", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    // 只实现读写两个方法；其余方法用不到。
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: () => null,
      length: 0
    } as Storage;
  });
  afterEach(() => {
    store.clear();
  });

  it("写入后能读回", () => {
    expect(writeFavorites(new Set(["a", "b"]))).toBe(true);
    expect(readFavorites()).toEqual(new Set(["a", "b"]));
  });

  it("存储里是没有预料到的内容时返回空集，不抛错", () => {
    store.set("woohaa.prompt-library.favorites.v1", "{not json");
    expect(readFavorites()).toEqual(new Set());
    store.set("woohaa.prompt-library.favorites.v1", JSON.stringify([1, "ok"]));
    expect(readFavorites()).toEqual(new Set(["ok"]));
  });

  it("存储写入失败时返回 false", () => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      }
    } as unknown as Storage;
    expect(writeFavorites(new Set(["a"]))).toBe(false);
  });
});

describe("fetchPromptLibrary", () => {
  it("把后端错误原文带出来，而不是一句笼统的加载失败", async () => {
    const result = await fetchPromptLibrary(async () => ({
      ok: false,
      status: 502,
      json: async () => ({ error: "提示词库加载失败：上游返回 HTTP 403" })
    }) as Response);
    expect(result).toEqual({ ok: false, error: "提示词库加载失败：上游返回 HTTP 403" });
  });

  it("非 JSON 错误响应也能给出可读原因", async () => {
    const result = await fetchPromptLibrary(async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("bad json");
      }
    }) as unknown as Response);
    expect(result).toEqual({ ok: false, error: "提示词库加载失败（HTTP 500）" });
  });

  it("网络异常时说明是连不上服务", async () => {
    const result = await fetchPromptLibrary(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(result).toEqual({ ok: false, error: "无法连接提示词库服务" });
  });

  it("成功时返回解码后的快照", async () => {
    const result = await fetchPromptLibrary(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ categories: [], prompts: [entry()] })
    }) as Response);
    expect(result.ok && result.snapshot.prompts).toHaveLength(1);
  });
});
