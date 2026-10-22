/**
 * 身份主体命名空间测试
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 2.6/5.8）。
 *
 * 覆盖：未解析时 namespace 为 null；记录主体后命名空间稳定；匿名/未登录标记 resolved 且
 * namespace 为 null；相同 identity 幂等不重复广播。
 */
import { describe, expect, it } from "vitest";
import { createIdentitySubjectService } from "./identity-subject.js";

describe("createIdentitySubjectService", () => {
  it("未解析时 namespace 为 null 且 resolved=false", () => {
    const service = createIdentitySubjectService();
    expect(service.getSnapshot()).toEqual({ resolved: false, identity: null });
    expect(service.namespace()).toBeNull();
  });

  it("记录主体后命名空间为 providerId:subject", () => {
    const service = createIdentitySubjectService();
    service.set({ providerId: "test-identity", subject: "alice" });
    expect(service.namespace()).toBe("test-identity:alice");
    expect(service.getSnapshot()).toEqual({ resolved: true, identity: { providerId: "test-identity", subject: "alice" } });
  });

  it("切换主体更新命名空间（账号切换隔离）", () => {
    const service = createIdentitySubjectService();
    service.set({ providerId: "test-identity", subject: "alice" });
    service.set({ providerId: "test-identity", subject: "bob" });
    expect(service.namespace()).toBe("test-identity:bob");
  });

  it("匿名/未登录标记 resolved 且 namespace 为 null", () => {
    const service = createIdentitySubjectService();
    service.set(null);
    expect(service.getSnapshot()).toEqual({ resolved: true, identity: null });
    expect(service.namespace()).toBeNull();
  });

  it("相同 identity 幂等，不重复通知", () => {
    const service = createIdentitySubjectService();
    let notifications = 0;
    service.subscribe(() => (notifications += 1));
    service.set({ providerId: "p", subject: "a" });
    service.set({ providerId: "p", subject: "a" });
    expect(notifications).toBe(1);
    service.set({ providerId: "p", subject: "b" });
    expect(notifications).toBe(2);
  });
});
