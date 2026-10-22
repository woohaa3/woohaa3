/**
 * 游戏炼丹炉本站隔离预览测试
 * （change: 2026-10-10-add-game-furnace-extension，任务 8.2–8.4）。
 *
 * 只验证纯内存预览宿主：短期只读会话、按 manifest 解析、拒绝路径穿越/绝对路径/查询片段/
 * 未登记 key、会话过期与 revoke，以及响应级 CSP sandbox/nosniff/no-store。
 */
import { describe, expect, it } from "vitest";
import {
  createGamePreviewHost,
  PREVIEW_HTML_HEADERS,
  readSourcePackageForPreview,
  type GamePreviewHost
} from "../src/preview.js";
import { encodeSourcePackage, type GamePackageManifest } from "../src/package.js";

const HTML = "<!doctype html><html><body><script>1</script></body></html>";

function manifest(overrides: Partial<GamePackageManifest> = {}): GamePackageManifest {
  return {
    schemaVersion: 1,
    buildId: "build-1",
    title: "t",
    controlsSummary: "",
    entry: "index.html",
    policyVersion: "game-furnace/v1",
    inputHash: "ih",
    sourceHash: "sh",
    dependencyAssetIds: ["asset-1"],
    resources: [{ resourceId: "res-hero", path: "assets/res-hero.png", assetId: "asset-1", contentType: "image/png", usage: "used" }],
    ...overrides
  };
}

function hostWithSession(now?: () => number): { host: GamePreviewHost; sessionId: string } {
  const host = createGamePreviewHost(now);
  const resources = new Map([["asset-1", { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" }]]);
  const session = host.registerSession({ projectKey: "canvas:node", manifest: manifest(), html: HTML, resources });
  return { host, sessionId: session.sessionId };
}

describe("预览会话隔离（任务 8.1/8.3）", () => {
  it("响应级 CSP sandbox + nosniff + no-store；入口不可 same-origin/导航", () => {
    const { host, sessionId } = hostWithSession();
    const entry = host.resolve(sessionId, "index.html");
    expect(entry).not.toBeNull();
    expect(entry!.contentType).toBe("text/html; charset=utf-8");
    expect(entry!.headers["Content-Security-Policy"]).toContain("sandbox allow-scripts");
    expect(entry!.headers["Content-Security-Policy"]).toContain("connect-src 'none'");
    expect(entry!.headers["Content-Security-Policy"]).toContain("frame-src 'none'");
    expect(entry!.headers["Content-Security-Policy"]).toContain("object-src 'none'");
    expect(entry!.headers["Content-Security-Policy"]).toContain("base-uri 'none'");
    expect(entry!.headers["Content-Security-Policy"]).toContain("form-action 'none'");
    expect(entry!.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(entry!.headers["Cache-Control"]).toBe("no-store");
    expect(PREVIEW_HTML_HEADERS["Referrer-Policy"]).toBe("no-referrer");
  });

  it("按 manifest 提供已登记资源，且资源响应也 nosniff/no-store", () => {
    const { host, sessionId } = hostWithSession();
    const asset = host.resolve(sessionId, "assets/res-hero.png");
    expect(asset).not.toBeNull();
    expect(asset!.contentType).toBe("image/png");
    expect(Array.from(asset!.bytes)).toEqual([1, 2, 3]);
    expect(asset!.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(asset!.headers["Cache-Control"]).toBe("no-store");
  });

  it("拒绝路径穿越、绝对路径、查询/片段、反斜杠与未登记 key", () => {
    const { host, sessionId } = hostWithSession();
    for (const path of ["../secret", "assets/../secret", "/index.html", "index.html?x=1", "index.html#f", "assets\\res-hero.png", "assets/unknown.png", "", "other.html"]) {
      expect(host.resolve(sessionId, path)).toBeNull();
    }
  });

  it("未知/伪造 session 拒绝", () => {
    const { host } = hostWithSession();
    expect(host.resolve("gfp-deadbeef", "index.html")).toBeNull();
    expect(host.resolve("", "index.html")).toBeNull();
  });
});

describe("预览会话生命周期（任务 8.1/8.7）", () => {
  it("会话过期后解析失败并清理", () => {
    let clock = 1_000_000;
    const { host, sessionId } = hostWithSession(() => clock);
    expect(host.resolve(sessionId, "index.html")).not.toBeNull();
    clock += 31 * 60 * 1000; // 超过默认 30 分钟 TTL
    expect(host.resolve(sessionId, "index.html")).toBeNull();
    expect(host.describe(sessionId)).toBeNull();
  });

  it("revoke 立即失效；dispose 清空全部会话", () => {
    const { host, sessionId } = hostWithSession();
    host.revoke(sessionId);
    expect(host.resolve(sessionId, "index.html")).toBeNull();
    const second = host.registerSession({ projectKey: "canvas:node", manifest: manifest(), html: HTML, resources: new Map() });
    host.dispose();
    expect(host.resolve(second.sessionId, "index.html")).toBeNull();
  });
});

describe("工作区预览组装（任务 8.6）", () => {
  it("describe 返回入口 HTML 与 data URL 资源（不写 canonical）", () => {
    const { host, sessionId } = hostWithSession();
    const described = host.describe(sessionId);
    expect(described).not.toBeNull();
    expect(described!.html).toBe(HTML);
    expect(described!.assets).toEqual([{ path: "assets/res-hero.png", dataUrl: "data:image/png;base64,AQID" }]);
  });
});

describe("源码包重建（任务 7.4/8.1）", () => {
  it("从源码包字节重建 html 与 manifest；非法字节返回 null", () => {
    const bytes = encodeSourcePackage({ schemaVersion: 1, entry: "index.html", html: HTML, manifest: manifest() });
    const rebuilt = readSourcePackageForPreview(bytes);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt!.html).toBe(HTML);
    expect(rebuilt!.manifest.buildId).toBe("build-1");
    expect(readSourcePackageForPreview(new TextEncoder().encode("not json"))).toBeNull();
  });
});
