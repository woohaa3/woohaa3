/**
 * media 插件：受控下载的 DNS 解析必须由生产装配注入。
 *
 * `guardedDownload` 的字面 host 校验只挡写死的 `127.0.0.1`；一个解析到内网或云元数据
 * 的公网域名要靠 `resolveHost` 才拦得住。这个文件盯住的正是「装配有没有注入」——
 * 只测 `guardedDownload` 自身是测不出来的：测试可以自己传 `resolveHost`，装配忘了传
 * 也照样绿。
 */
import { describe, expect, it } from "vitest";
import { resolveDownloadHostForTest } from "./media.js";

describe("media 插件的下载 DNS 解析", () => {
  it("字面 IP 不查 DNS，直接回原值", async () => {
    await expect(resolveDownloadHostForTest("127.0.0.1")).resolves.toEqual(["127.0.0.1"]);
    await expect(resolveDownloadHostForTest("169.254.169.254")).resolves.toEqual(["169.254.169.254"]);
  });

  it("域名解析返回全部地址（含 IPv6）", async () => {
    const addresses = await resolveDownloadHostForTest("localhost");
    expect(addresses.length).toBeGreaterThan(0);
    // localhost 必须至少解析出一个回环地址，否则守卫根本看不到私网目标。
    expect(addresses.some((address) => address === "127.0.0.1" || address === "::1")).toBe(true);
  });

  it("解析失败向上抛错，而不是退化成「不查 DNS」", async () => {
    await expect(resolveDownloadHostForTest("this-host-must-not-resolve.invalid")).rejects.toThrow();
  });
});
