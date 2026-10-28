import { describe, expect, it } from "vitest";
import { resolveRequestDataContext, type AccessRuntime } from "./data-scope.js";

describe("host data context", () => {
  const instance = Object.freeze({ kind: "instance" as const, id: "instance:stable", ownerId: "instance:stable", credentialOwnerId: "instance:stable" });
  it("无鉴权仅产生实例归属，即使传入身份也不伪造已登录用户", () => {
    const runtime: AccessRuntime = { enabled: false, instance };
    expect(resolveRequestDataContext(runtime, { subject: "untrusted", identityProvider: "header" })).toEqual({ dataScope: instance });
    expect(Object.isFrozen(resolveRequestDataContext(runtime))).toBe(true);
  });
  it("受控缺身份拒绝，不降级到实例；用户与 provider 空间不混用", () => {
    expect(() => resolveRequestDataContext({ enabled: true })).toThrow("需要已认证用户");
    const a = resolveRequestDataContext({ enabled: true }, { subject: "a", identityProvider: "verified" });
    const b = resolveRequestDataContext({ enabled: true }, { subject: "b", identityProvider: "verified" });
    expect(a.dataScope.id).not.toBe(b.dataScope.id);
    expect(a.dataScope.credentialOwnerId).toBe("principal:a");
    expect(a.principal?.subject).toBe("a");
  });
});
