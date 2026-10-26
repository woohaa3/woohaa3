/**
 * 子进程出网守卫（任务 5.3）。每个用例安装后 uninstall，避免污染同进程其他测试。
 * 目标都是不可路由或本机地址，且在守卫拦截时不会真正建连（拦截发生在建连之前）。
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionNetworkDeniedError, installNetworkGuard, type NetworkGuard, type NetworkViolation } from "./network-guard.js";

let guard: NetworkGuard | null = null;
afterEach(() => {
  guard?.uninstall();
  guard = null;
});

function install(allowedHosts: string[], options: { lockdown?: boolean } = {}) {
  const violations: NetworkViolation[] = [];
  guard = installNetworkGuard({ allowedHosts, onViolation: (violation) => violations.push(violation), ...options });
  return violations;
}

const denied = (error: unknown) => error instanceof ExtensionNetworkDeniedError && (error as ExtensionNetworkDeniedError).code === "EXTENSION_NETWORK_DENIED";

describe("出网守卫", () => {
  it("fetch：白名单外拒绝并上报；白名单内放行到下层（本机 HTTP 服务）", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const violations = install(["api.example.com"]);
      await expect(fetch("https://evil.example.net/x")).rejects.toSatisfy(denied);
      expect(violations[0]).toMatchObject({ host: "evil.example.net", via: "fetch", reason: "not-allowed" });
      // 白名单里写了 127.0.0.1 也不行：私网字面量一律拒绝。
      guard?.uninstall();
      install([`127.0.0.1:${port}`]);
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toSatisfy(denied);
    } finally {
      server.close();
    }
  });

  it("空白名单禁止一切出网（fetch / http / https / net / tls / dns）", async () => {
    install([]);
    await expect(fetch("https://api.example.com/")).rejects.toSatisfy(denied);
    expect(() => http.get("http://api.example.com/")).toThrow(ExtensionNetworkDeniedError);
    expect(() => https.request({ hostname: "api.example.com", port: 443 })).toThrow(ExtensionNetworkDeniedError);
    expect(() => net.connect(443, "api.example.com")).toThrow(ExtensionNetworkDeniedError);
    expect(() => net.createConnection({ host: "api.example.com", port: 80 })).toThrow(ExtensionNetworkDeniedError);
    expect(() => tls.connect({ host: "api.example.com", port: 443 })).toThrow(ExtensionNetworkDeniedError);
    expect(() => dns.lookup("api.example.com", () => undefined)).toThrow(ExtensionNetworkDeniedError);
    await expect(dns.promises.lookup("api.example.com")).rejects.toSatisfy(denied);
  });

  it("四类入口都被拦截：http(s)、net、tls、dns（白名单外主机）", () => {
    const violations = install(["api.example.com"]);
    expect(() => http.request({ host: "other.example.com", port: 80 })).toThrow(ExtensionNetworkDeniedError);
    expect(() => https.get("https://other.example.com/")).toThrow(ExtensionNetworkDeniedError);
    expect(() => net.connect({ host: "10.0.0.5", port: 22 })).toThrow(ExtensionNetworkDeniedError);
    expect(() => tls.connect(443, "other.example.com")).toThrow(ExtensionNetworkDeniedError);
    expect(() => dns.resolve4("other.example.com", () => undefined)).toThrow(ExtensionNetworkDeniedError);
    expect(new Set(violations.map((violation) => violation.via.split(".")[0]))).toEqual(new Set(["http", "https", "net", "dns"]));
  });

  it("Unix 套接字与 http socketPath 一律拒绝", () => {
    install(["api.example.com"]);
    expect(() => net.connect({ path: "/var/run/docker.sock" })).toThrow(ExtensionNetworkDeniedError);
    expect(() => http.request({ socketPath: "/var/run/docker.sock", path: "/" })).toThrow(ExtensionNetworkDeniedError);
  });

  it("白名单内域名解析到私网地址：建连被拒（DNS 重绑定）", async () => {
    install(["rebind.example.com"]);
    const socket = new net.Socket();
    const error = await new Promise<unknown>((resolve) => {
      socket.once("error", resolve);
      // 用户自带 lookup 模拟恶意解析：守卫包裹后检查结果。
      socket.connect({ host: "rebind.example.com", port: 80, lookup: ((_h: string, _o: unknown, cb: (e: null, a: string, f: number) => void) => cb(null, "127.0.0.1", 4)) as never });
    });
    socket.destroy();
    expect(denied(error)).toBe(true);
  });

  it("白名单内的公网目标交给下层（不在守卫层失败）", () => {
    install(["api.example.com"]);
    const socket = net.connect({ host: "api.example.com", port: 443, lookup: ((_h: string, _o: unknown, cb: (e: Error) => void) => cb(new Error("lookup-stub"))) as never });
    socket.on("error", () => undefined);
    socket.destroy();
    expect(true).toBe(true);
  });

  it("lockdown：child_process / worker_threads 被禁用，uninstall 后恢复", async () => {
    install([], { lockdown: true });
    const childProcess = await import("node:child_process");
    expect(() => childProcess.spawn("true")).toThrow(/不允许使用/);
    const workers = await import("node:worker_threads");
    expect(() => new workers.Worker("")).toThrow(/不允许使用/);
    guard?.uninstall();
    guard = null;
    expect(childProcess.spawn).not.toThrow;
    expect((await import("node:child_process")).spawn.name).not.toBe("blocked");
  });

  it("重复安装抛错", () => {
    install([]);
    expect(() => installNetworkGuard({ allowedHosts: [] })).toThrow(/已安装/);
  });
});
