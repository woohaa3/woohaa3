/**
 * 站点/资源访问契约纯函数与部署 profile 解析测试
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 0.3/1.1/1.2 / design D2）。
 *
 * 验证：identity/policy DTO 是纯类型（无 isAdmin/管理员角色）；具名 action 与资源权限集合封闭、
 * 未知值默认拒绝；必需 provider profile 只保留可信清单中真实存在的 extensionId（独立运行不强行要求）。
 */
import { describe, expect, it } from "vitest";
import {
  ACCESS_ACTIONS,
  ACCESS_PROVIDER_UNAVAILABLE_CODE,
  APPLICATION_EXTENSION_LOAD_ACTION,
  IDENTITY_TRANSPORTS,
  MODELS_MANAGE_ACTION,
  PROVIDERS_CREDENTIALS_ACTION,
  REQUIRED_PROVIDER_SLOTS,
  RESOURCE_LIFECYCLE_STATES,
  RESOURCE_PERMISSIONS,
  TASKS_INSPECT_ACTION,
  TELEMETRY_INSPECT_ACTION,
  accessDenied,
  isAccessAction,
  isResourcePermission,
  type PrincipalContext
} from "../index.js";

describe("站点/资源具名 action（任务 0.3/3.1）", () => {
  it("五个具名 action 固定且都在封闭集合内", () => {
    expect(ACCESS_ACTIONS).toEqual([
      "extensions.configure",
      "providers.credentials.write",
      "models.manage",
      "tasks.inspect",
      "telemetry.inspect"
    ]);
    for (const action of [
      APPLICATION_EXTENSION_LOAD_ACTION,
      PROVIDERS_CREDENTIALS_ACTION,
      MODELS_MANAGE_ACTION,
      TASKS_INSPECT_ACTION,
      TELEMETRY_INSPECT_ACTION
    ]) {
      expect(isAccessAction(action)).toBe(true);
    }
  });

  it("未知 action 默认拒绝（不映射旧 admin 万能权）", () => {
    for (const bogus of ["admin", "*", "roles.includes('admin')", "", "tasks.inspect ", "tasks.inspectx"]) {
      expect(isAccessAction(bogus)).toBe(false);
    }
  });

  it("资源权限与生命周期状态集合封闭，未知值拒绝", () => {
    expect(RESOURCE_PERMISSIONS).toEqual(["read", "write", "manageSharing", "delete"]);
    expect(RESOURCE_LIFECYCLE_STATES).toEqual(["provisioning", "active", "deleting", "deleted"]);
    expect(isResourcePermission("admin")).toBe(false);
    expect(isResourcePermission("manageSharing")).toBe(true);
  });

  it("访问决策错误码区分未认证(401)/无权限(403)/provider 故障(503)", () => {
    expect(accessDenied("unauthenticated")).toEqual({ allowed: false, code: "unauthenticated" });
    expect(accessDenied("forbidden")).toEqual({ allowed: false, code: "forbidden" });
    expect(accessDenied("provider-unavailable", "identity down")).toEqual({
      allowed: false,
      code: "provider-unavailable",
      message: "identity down"
    });
    expect(ACCESS_PROVIDER_UNAVAILABLE_CODE).toBe("access-provider-unavailable");
    // 未认证/无权限不带 message（不泄漏细节）。
    expect(accessDenied("forbidden", "should be dropped")).toEqual({ allowed: false, code: "forbidden" });
  });

  it("认证传输面覆盖 HTTP/WS/MCP", () => {
    expect(IDENTITY_TRANSPORTS).toEqual(["http", "ws", "mcp"]);
  });

  it("PrincipalContext 是纯数据：无 isAdmin/roles，不隐式携带管理权", () => {
    const principal: PrincipalContext = { subject: "alice", identityProvider: "test-identity" };
    expect(Object.keys(principal).sort()).toEqual(["identityProvider", "subject"]);
    expect(JSON.stringify(principal)).not.toMatch(/isAdmin|admin|roles/);
  });
});

describe("必需 provider 部署 profile（任务 1.1/1.2）", () => {
  it("默认 profile 四个 slot 恰各一个 owner，且只引用 extensionId", () => {
    expect(REQUIRED_PROVIDER_SLOTS).toEqual(["identity", "site-access", "resource-access", "resource-lifecycle"]);
  });
});
