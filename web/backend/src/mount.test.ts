/**
 * 后端挂载边界测试（change: 2026-10-15-support-configurable-app-base-path，design D4）。
 *
 * 覆盖：完整段匹配、只剥离一次、前缀外不进入业务、无尾斜杠入口 308 保留 query、
 * 非法编码 400、upgrade 不重定向。与 `web/contracts` 的单一规则实现保持一致。
 *
 * @vitest-environment node
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { applyHttpMount, applyUpgradeMount, resolveBasePathFromEnv } from "./mount.js";

type Recorded = { status?: number; headers: Record<string, string>; body: string; ended: boolean };

function fakeRes(): { res: ServerResponse; recorded: Recorded } {
  const recorded: Recorded = { headers: {}, body: "", ended: false };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      recorded.status = status;
      Object.assign(recorded.headers, headers);
      return this;
    },
    end(body?: string | Buffer) {
      recorded.body = body === undefined ? "" : String(body);
      recorded.ended = true;
    }
  } as unknown as ServerResponse;
  return { res, recorded };
}

function fakeReq(url: string): IncomingMessage {
  return { url } as IncomingMessage;
}

describe("resolveBasePathFromEnv", () => {
  it("未设置/根/多级均规范化，非法返回 error", () => {
    expect(resolveBasePathFromEnv({}).basePath).toBe("/");
    expect(resolveBasePathFromEnv({ WOOHAA3_BASE_PATH: "/canvas" }).basePath).toBe("/canvas/");
    expect(resolveBasePathFromEnv({ WOOHAA3_BASE_PATH: "/a/b" }).basePath).toBe("/a/b/");
    const bad = resolveBasePathFromEnv({ WOOHAA3_BASE_PATH: "canvas" });
    expect(bad.error).toBeTruthy();
  });
});

describe("applyHttpMount", () => {
  it("前缀内请求剥离一次并保留 query", () => {
    const req = fakeReq("/canvas/api/canvases?limit=2");
    const { res } = fakeRes();
    expect(applyHttpMount("/canvas/", req, res)).toBe(false);
    expect(req.url).toBe("/api/canvases?limit=2");
  });

  it("无尾斜杠入口 GET 以 308 重定向到规范入口并保留 query", () => {
    const req = fakeReq("/canvas?x=1");
    const { res, recorded } = fakeRes();
    expect(applyHttpMount("/canvas/", req, res)).toBe(true);
    expect(recorded.status).toBe(308);
    expect(recorded.headers.location).toBe("/canvas/?x=1");
  });

  it("前缀外请求不进入业务（404），不猜测挂载", () => {
    for (const path of ["/", "/api/canvases", "/renderer.html", "/canvas-other/"]) {
      const req = fakeReq(path);
      const { res, recorded } = fakeRes();
      expect(applyHttpMount("/canvas/", req, res)).toBe(true);
      expect(recorded.status).toBe(404);
    }
  });

  it("非法编码/穿越返回 400", () => {
    for (const path of ["/canvas/%2e%2e/outside", "/canvas/..%2foutside", "/canvas\\api"]) {
      const req = fakeReq(path);
      const { res, recorded } = fakeRes();
      expect(applyHttpMount("/canvas/", req, res)).toBe(true);
      expect(recorded.status).toBe(400);
    }
  });

  it("规范入口 /canvas/ 剥离为逻辑根", () => {
    const req = fakeReq("/canvas/");
    const { res } = fakeRes();
    expect(applyHttpMount("/canvas/", req, res)).toBe(false);
    expect(req.url).toBe("/");
  });

  it("根挂载把所有请求作为逻辑路径放行", () => {
    const req = fakeReq("/api/canvases");
    const { res } = fakeRes();
    expect(applyHttpMount("/", req, res)).toBe(false);
    expect(req.url).toBe("/api/canvases");
  });
});

describe("applyUpgradeMount", () => {
  it("前缀内 upgrade 改写为逻辑路径且不重定向", () => {
    const req = fakeReq("/canvas/api/canvases/c1/runs?token=t");
    expect(applyUpgradeMount("/canvas/", req)).toBe(true);
    expect(req.url).toBe("/api/canvases/c1/runs?token=t");
  });

  it("前缀外 upgrade 不接管（不重定向，由调用方销毁）", () => {
    const req = fakeReq("/api/canvases/c1/runs");
    expect(applyUpgradeMount("/canvas/", req)).toBe(false);
  });
});
