import { describe, expect, it } from "vitest";
import { createLocalInstanceScope, devPrincipalIdFromEnv } from "./access.js";

describe("本地单实例访问作用域", () => {
  it("固定 owner 兼容历史 dev-admin 数据，credential owner 保持原 AAD 口径", () => {
    expect(devPrincipalIdFromEnv({})).toBe("dev-admin");
    expect(createLocalInstanceScope({})).toEqual({
      kind: "instance",
      id: "instance:local",
      ownerId: "dev-admin",
      credentialOwnerId: "principal:dev-admin"
    });
  });

  it("显式开发主体覆盖 owner，但仍是实例作用域而不是登录用户", () => {
    const scope = createLocalInstanceScope({ WOOHAA3_MCP_DEVELOPMENT_PRINCIPAL: " local-tester " });
    expect(scope).toMatchObject({ kind: "instance", ownerId: "local-tester", credentialOwnerId: "principal:local-tester" });
  });
});
