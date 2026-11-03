import { describe, expect, it } from "vitest";
import { assertPublicHttpsUrl, createGuardedFetch } from "../src/guarded-fetch.js";

/**
 * 受控下载 / 受控上传的 SSRF 防护（C 方向收敛后：只保留与进程边界无关的这一层）。
 *
 * 白名单（`allowedHosts` / `permissions.network`）随 Extension Host 子进程一起删除，
 * 原先覆盖它的用例也一并移除；这里的断言都走对外入口 `assertPublicHttpsUrl`。
 */
describe("出网 SSRF 防护", () => {
  it("拒绝回环 / 私网 / 链路本地 / 云元数据地址", () => {
    for (const address of [
      "https://127.0.0.1/x",
      "https://10.1.2.3/x",
      "https://172.16.0.1/x",
      "https://192.168.1.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://100.64.0.1/x",
      "https://0.0.0.0/x",
      "https://224.0.0.1/x",
      "https://[::1]/x",
      "https://[::]/x",
      "https://[fd00::1]/x",
      "https://[fe80::1]/x",
      "https://[::ffff:127.0.0.1]/x",
      "https://[::ffff:7f00:1]/x"
    ]) {
      expect(() => assertPublicHttpsUrl(address), address).toThrow(/拒绝/);
    }
  });

  it("放行公网地址", () => {
    for (const address of [
      "https://8.8.8.8/x",
      "https://172.32.0.1/x",
      "https://[2001:4860:4860::8888]/x",
      "https://[::ffff:8.8.8.8]/x",
      "https://api.example.com/x"
    ]) {
      expect(() => assertPublicHttpsUrl(address)).not.toThrow();
    }
  });

  it("拒绝本机 / mDNS 主机名与非 https 协议", () => {
    expect(() => assertPublicHttpsUrl("https://localhost:8080/x")).toThrow(/本机/);
    expect(() => assertPublicHttpsUrl("https://printer.local/x")).toThrow(/本机/);
    expect(() => assertPublicHttpsUrl("https://app.localhost/x")).toThrow(/本机/);
    expect(() => assertPublicHttpsUrl("http://api.example.com/x")).toThrow(/https/);
    expect(() => assertPublicHttpsUrl("file:///etc/passwd")).toThrow();
    // 超范围八位组在 URL 解析阶段就被判非法，同样不会发出请求。
    expect(() => assertPublicHttpsUrl("https://999.1.1.1/x")).toThrow();
  });

  it("受控下载在请求前就挡住私网目标（不发请求）", async () => {
    let called = 0;
    const guarded = createGuardedFetch({
      baseUrl: "https://queue.example.com",
      maxBytes: 1024,
      timeoutMs: 1000,
      fetchImpl: (async () => {
        called += 1;
        return new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } });
      }) as typeof fetch
    });
    await expect(guarded("https://169.254.169.254/latest/meta-data")).rejects.toThrow(/私网/);
    expect(called).toBe(0);
  });
});
