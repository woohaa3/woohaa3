import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createReloadingHandler, RELOADING_RETRY_AFTER_MS } from "./swap-reloading-route.js";
import { beginSwap, clearSwaps, endSwap, isSwapping } from "./swap-registry.js";

function fakeResponse() {
  const captured = { status: 0, headers: {} as Record<string, string>, body: "" };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
      return this;
    },
    end(body?: string) {
      captured.body = body ?? "";
      return this;
    }
  } as unknown as ServerResponse;
  return { res, captured };
}

const req = (url: string) => ({ url }) as IncomingMessage;

afterEach(() => clearSwaps());

describe("换版窗口拦截", () => {
  it("换版中：该扩展的 API 路由返回 503 extension-reloading 与 Retry-After", async () => {
    beginSwap("demo");
    const { res, captured } = fakeResponse();
    const handled = await createReloadingHandler()(req("/api/extensions/demo/refresh"), res);
    expect(handled).toBe(true);
    expect(captured.status).toBe(503);
    expect(captured.headers["retry-after"]).toBe(String(RELOADING_RETRY_AFTER_MS / 1000));
    const body = JSON.parse(captured.body);
    expect(body.code).toBe("extension-reloading");
    expect(body.retryAfterMs).toBe(RELOADING_RETRY_AFTER_MS);
  });

  it("不在换版中：交下游（不拦截）", async () => {
    const { res, captured } = fakeResponse();
    const handled = await createReloadingHandler()(req("/api/extensions/demo/refresh"), res);
    expect(handled).toBe(false);
    expect(captured.status).toBe(0);
  });

  it("换版结束后恢复正常：不再返回 503", async () => {
    beginSwap("demo");
    expect(isSwapping("demo")).toBe(true);
    endSwap("demo");
    expect(isSwapping("demo")).toBe(false);
    const { res } = fakeResponse();
    expect(await createReloadingHandler()(req("/api/extensions/demo/refresh"), res)).toBe(false);
  });

  it("只拦该扩展自己：别的扩展换版不影响它", async () => {
    beginSwap("other");
    const { res } = fakeResponse();
    expect(await createReloadingHandler()(req("/api/extensions/demo/refresh"), res)).toBe(false);
  });

  it("非扩展路径与管理路由交下游", async () => {
    beginSwap("demo");
    const handler = createReloadingHandler();
    for (const url of ["/api/providers", "/api/settings", "/api/extensions", "/api/extensions/install"]) {
      const { res } = fakeResponse();
      expect(await handler(req(url), res), url).toBe(false);
    }
  });

  it("换版窗口可嵌套复用同一 id 的登记语义（Set 语义：重复 begin 不叠加）", () => {
    beginSwap("demo");
    beginSwap("demo");
    endSwap("demo");
    expect(isSwapping("demo")).toBe(false);
  });
});
