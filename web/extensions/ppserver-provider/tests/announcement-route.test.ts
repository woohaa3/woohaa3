import { describe, expect, it, vi } from "vitest";
import { ANNOUNCEMENT_URL, fetchAnnouncement } from "../src/announcement-route.js";

/**
 * 公告索引转发的判定。
 *
 * 公告是官网上的一个 JSON 索引。几条判定决定了用户看到的是
 * 「公告 / 没有公告 / 暂时读不到」三种里的哪一种，而三种不能混：
 * - 404 是「没发布」，不是出错；
 * - 网络错误与 5xx 是「读不到」，**不能**当成没有公告 —— 用户会以为平台没发过任何消息；
 * - 发布的人把 JSON 写坏了，要让它**看得见**（502），不能静默当成没有公告；
 * - 回 200 的 HTML 兜底页**不能**被当成内容。
 */

function reply(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return vi.fn(async () =>
    new Response(body, {
      status: init.status ?? 200,
      headers: { "content-type": "application/json", ...init.headers },
    }),
  ) as unknown as typeof fetch;
}

const INDEX = JSON.stringify({
  items: [{ id: "a", title: "第一条", body: "正文", date: "2026-11-07" }],
});

describe("公告索引转发", () => {
  it("取到索引，JSON 原样透传，并带上修改时间", async () => {
    const fetchImpl = reply(INDEX, {
      headers: { "last-modified": "Sat, 07 Nov 2026 09:00:00 GMT", etag: '"abc"' },
    });

    const result = await fetchAnnouncement(fetchImpl);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      data: { items: [{ id: "a", title: "第一条", body: "正文", date: "2026-11-07" }] },
      lastModified: "Sat, 07 Nov 2026 09:00:00 GMT",
      etag: '"abc"',
    });
  });

  it("只请求那一个固定地址，且不带任何凭据", async () => {
    const fetchImpl = reply(INDEX);
    await fetchAnnouncement(fetchImpl);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(ANNOUNCEMENT_URL);
    // 新目录，不是 PS 插件读的那个单行文件
    expect(url).toContain("/gonggao/desktop/");
    expect(url).not.toMatch(/gonggao\.txt/);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-tenant-id")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    // 不跟随重定向：origin 写死，跳到别处不是我们要的东西
    expect(init.redirect).toBe("error");
  });

  it("404 当作没有公告(data: null)，不是错误", async () => {
    const result = await fetchAnnouncement(reply("not found", { status: 404 }));
    expect(result).toEqual({ status: 200, body: { data: null } });
  });

  it("空文件当作没有公告，不是错误", async () => {
    expect(await fetchAnnouncement(reply("  \n"))).toEqual({ status: 200, body: { data: null } });
  });

  it("5xx 是读不到(502)，不能当成没有公告", async () => {
    const result = await fetchAnnouncement(reply("boom", { status: 500 }));
    expect(result.status).toBe(502);
  });

  it("网络错误是读不到(502)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await fetchAnnouncement(fetchImpl);

    expect(result.status).toBe(502);
    expect((result.body as { message: string }).message).toContain("ECONNREFUSED");
  });

  it("JSON 写坏了是 502，不是没有公告 —— 要让发布的人看得见", async () => {
    // 末尾多一个逗号、少一个引号……手写 JSON 最常见的错。静默吞掉的话，
    // 所有用户都只会看到「暂时没有公告」，没人知道是发布出了问题
    const result = await fetchAnnouncement(reply('{ "items": [ { "id": "a", } ] }'));

    expect(result.status).toBe(502);
    expect((result.body as { message: string }).message).toContain("JSON");
  });

  it("200 的 HTML 兜底页不当内容 —— 整页源码不能进来", async () => {
    const fetchImpl = reply("<!doctype html><html>…</html>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    });

    expect((await fetchAnnouncement(fetchImpl)).status).toBe(502);
  });

  it("nginx 没给 .json 配类型、回 text/plain 时也认", async () => {
    const result = await fetchAnnouncement(
      reply(INDEX, { headers: { "content-type": "text/plain" } }),
    );
    expect(result.status).toBe(200);
  });

  it("过长的内容拒绝，声明长度与实际长度都要看", async () => {
    const big = JSON.stringify({ items: [{ id: "x", title: "字".repeat(30_000) }] }); // 约 90 KB
    expect((await fetchAnnouncement(reply(big))).status).toBe(502);

    // 声明的长度超限，不用等读完
    const declared = reply("{}", { headers: { "content-length": String(1024 * 1024) } });
    expect((await fetchAnnouncement(declared)).status).toBe(502);
  });
});
