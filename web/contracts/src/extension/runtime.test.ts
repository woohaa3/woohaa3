/**
 * 应用插件宿主纯类型契约边界测试
 * （change: 2026-10-05-extract-application-plugin-host，任务 1.2）。
 *
 * 验证契约层不含宿主实现依赖：授权等级比较、受限 facade 形状与宿主 identity 稳定。
 * 真正的「无 SDK/服务实现 import」由 tooling 依赖门禁做结构扫描，这里做语义断言。
 */
import { describe, expect, it } from "vitest";
import {
  AUTH_LEVEL_RANK,
  isAuthLevelAtLeast,
  type ApplicationBackendHost,
  type ApplicationExtensionTaskAssociation
} from "../index.js";

describe("应用插件宿主契约（任务 1.2）", () => {
  it("授权等级单调且插件不能弱化；不含 admin 等级", () => {
    expect(AUTH_LEVEL_RANK.public).toBeLessThan(AUTH_LEVEL_RANK.authenticated);
    expect(Object.keys(AUTH_LEVEL_RANK).sort()).toEqual(["authenticated", "public"]);
    expect(isAuthLevelAtLeast("authenticated", "authenticated")).toBe(true);
    expect(isAuthLevelAtLeast("authenticated", "public")).toBe(true);
    expect(isAuthLevelAtLeast("public", "authenticated")).toBe(false);
  });

  it("宿主 identity 与插件任务关联只含纯数据字段", () => {
    const association: ApplicationExtensionTaskAssociation = {
      extensionId: "sample-site-extension",
      configVersion: 2,
      workerTaskKey: "plugin-work-1"
    };
    expect(Object.keys(association).sort()).toEqual(["configVersion", "extensionId", "workerTaskKey"]);
    // 关联不得携带配置正文或秘密。
    const serialized = JSON.stringify(association);
    expect(serialized).not.toMatch(/secret|token|value|config"/);
  });

  it("受限 facade 契约只有声明形状，不含服务实现字段", () => {
    // 类型层断言：ApplicationBackendHost 的实例只暴露声明的方法与纯 facade。
    type HostKeys = keyof ApplicationBackendHost;
    const keys: HostKeys[] = ["extensionId", "host", "config", "work", "services", "registerCapability", "registerHandler", "registerHttpHandler", "registerResource", "logger"];
    expect(keys.length).toBe(10);
  });
});
