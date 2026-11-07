import { describe, expect, it, vi } from "vitest";
import { ANNOUNCEMENT_URL, fetchAnnouncement } from "../src/announcement-route.js";

/**
 * 公告转发的判定。
 *
 * 公告是官网上的一个静态文本。几条判定决定了用户看到的是「公告 / 没有公告 / 暂时读不到」
 * 三种里的哪一种，而三种不能混：
 * - 404 是「没发布」，不是出错；
 * - 网络错误与 5xx 是「读不到」，**不能**当成没有公告 —— 那样用户会以为平台没有任何消息；
 * - 回 200 的 HTML 兜底页**不能**被当成公告显示。
 */

function reply(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
  return vi.fn(async () =>
    new Response(body, {
      status: init.status ?? 200,
      headers: { "content-type": "text/plain", ...init.headers },
    }),
  ) as unknown as typeof fetch;
}

describe("公告转发", () => {
  it("取到文本，并带上发布时间", async () => {
    const fetchImpl = reply("四喜6.0已更新 请前往官网下载\n", {
      headers: {
        "last-modified": "Sun, 11 Oct 2026 11:15:25 GMT",
        etag: '"6acb6fcd-29"',
      },
    });

    const result = await fetchAnnouncement(fetchImpl);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      text: "四喜6.0已更新 请前往官网下载",
      lastModified: "Sun, 11 Oct 2026 11:15:25 GMT",
      etag: '"6acb6fcd-29"',
    });
  });

  it("只请求那一个固定地址，且不带任何凭据", async () => {
    const fetchImpl = reply("hi");
    await fetchAnnouncement(fetchImpl);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(ANNOUNCEMENT_URL);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-tenant-id")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    // 不跟随重定向：origin 写死，跳到别处不是我们要的东西
    expect(init.redirect).toBe("error");
  });

  it("404 当作没有公告，不是错误", async () => {
    const result = await fetchAnnouncement(reply("not found", { status: 404 }));
    expect(result).toEqual({ status: 200, body: { text: "" } });
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

  it("200 的 HTML 兜底页不当公告 —— 整页源码不能出现在界面上", async () => {
    const fetchImpl = reply("<!doctype html><html>…</html>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    });

    const result = await fetchAnnouncement(fetchImpl);

    expect(result.status).toBe(502);
  });

  it("过长的内容拒绝，声明长度与实际长度都要看", async () => {
    const big = "字".repeat(10_000); // 约 30 KB
    expect((await fetchAnnouncement(reply(big))).status).toBe(502);

    // 声明的长度超限，不用等读完
    const declared = reply("x", { headers: { "content-length": String(1024 * 1024) } });
    expect((await fetchAnnouncement(declared)).status).toBe(502);
  });

  it("空文件是没有公告(空文本)，不是错误", async () => {
    const result = await fetchAnnouncement(reply("  \n"));
    expect(result).toEqual({ status: 200, body: { text: "" } });
  });
});
