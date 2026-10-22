/**
 * 统一授权端口：导入目标 ACL 前置判定
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 5.9）。
 */
import { describe, expect, it, vi } from "vitest";
import type { PrincipalContext } from "@woohaa3/contracts";
import { composeImportedFirstCanvasAccess, importedPermissionFor } from "./import-access-port.js";
import type { CanvasAccessPort } from "./access-port.js";

const principal: PrincipalContext = { subject: "creator-1", identityProvider: "test-identity" };

function fallbackPort(allowed: boolean): CanvasAccessPort {
  return { authorize: vi.fn(async () => (allowed ? { allowed: true } as const : { allowed: false as const, code: "forbidden" as const, message: "企业策略拒绝" })) };
}

describe("composeImportedFirstCanvasAccess", () => {
  it("导入目标允许：由导入 ACL 决定，不查企业策略", async () => {
    const fallback = fallbackPort(false);
    const port = composeImportedFirstCanvasAccess({ imported: () => () => true, fallback });
    await expect(port.authorize({ principal, canvasId: "c1", permission: "read" })).resolves.toEqual({ allowed: true });
    expect(fallback.authorize).not.toHaveBeenCalled();
  });

  it("导入目标拒绝：返回 forbidden，不回退企业策略（不因企业 ACL 而放行）", async () => {
    const fallback = fallbackPort(true);
    const port = composeImportedFirstCanvasAccess({ imported: () => () => false, fallback });
    await expect(port.authorize({ principal, canvasId: "c1", permission: "write" })).resolves.toMatchObject({ allowed: false, code: "forbidden" });
    expect(fallback.authorize).not.toHaveBeenCalled();
  });

  it("非导入目标（null）：交回企业策略", async () => {
    const fallback = fallbackPort(true);
    const port = composeImportedFirstCanvasAccess({ imported: () => () => null, fallback });
    await expect(port.authorize({ principal, canvasId: "native", permission: "read" })).resolves.toEqual({ allowed: true });
    expect(fallback.authorize).toHaveBeenCalledTimes(1);
  });

  it("未挂载导入解析器：直接走企业策略", async () => {
    const fallback = fallbackPort(false);
    const port = composeImportedFirstCanvasAccess({ imported: () => null, fallback });
    await expect(port.authorize({ principal, canvasId: "native", permission: "read" })).resolves.toMatchObject({ allowed: false, code: "forbidden" });
  });

  it("导入解析器故障：fail closed（provider-unavailable），不落企业策略", async () => {
    const fallback = fallbackPort(true);
    const port = composeImportedFirstCanvasAccess({
      imported: () => () => { throw new Error("store down"); },
      fallback
    });
    await expect(port.authorize({ principal, canvasId: "c1", permission: "read" })).resolves.toMatchObject({
      allowed: false,
      code: "provider-unavailable"
    });
    expect(fallback.authorize).not.toHaveBeenCalled();
  });

  it("manageSharing/delete 归一到 write（导入 ACL 只区分读写）", () => {
    expect(importedPermissionFor("read")).toBe("read");
    expect(importedPermissionFor("write")).toBe("write");
    expect(importedPermissionFor("manageSharing")).toBe("write");
    expect(importedPermissionFor("delete")).toBe("write");
  });
});
