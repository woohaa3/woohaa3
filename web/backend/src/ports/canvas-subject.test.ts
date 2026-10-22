/**
 * Canvas 可信主体解析桥
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 4.8）。
 *
 * 主体只能来自统一**异步**认证器；未认证返回 null（调用方据此 fail-closed），
 * 绝不信任请求体或来路头自报的身份。
 */
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createCanvasSubjectResolver } from "./canvas-subject.js";

function request(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("createCanvasSubjectResolver", () => {
  it("认证器给出 principal 时返回其 subject", async () => {
    const authenticate = vi.fn(async () => ({ subject: "alice", identityProvider: "test-identity" }));
    const resolve = createCanvasSubjectResolver(authenticate);
    await expect(resolve(request({ "x-woohaa3-actor": "attacker" }))).resolves.toBe("alice");
    expect(authenticate).toHaveBeenCalledWith(expect.anything(), "http");
  });

  it("未认证返回 null（fail-closed）", async () => {
    const resolve = createCanvasSubjectResolver(async () => null);
    await expect(resolve(request())).resolves.toBeNull();
  });

  it("认证提供者故障上抛，不由桥下沉为匿名", async () => {
    const resolve = createCanvasSubjectResolver(async () => {
      throw new Error("identity provider unavailable");
    });
    await expect(resolve(request())).rejects.toThrow("identity provider unavailable");
  });
});
