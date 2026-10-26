/**
 * 应用插件共享契约 codec 测试
 * （change: 2026-10-04-add-backend-plugin-extensions，任务 1.1）。
 *
 * 重点验证：
 * - codec 拒绝代码位置字段（module/url/script/source/entry）与秘密字段进入公开元数据；
 * - 公开状态脱敏 helper 不泄漏配置秘密或 URL 载体；
 * - 可信清单重复 identity 稳定拒绝；生产清单不含 fixture。
 */
import { describe, expect, it } from "vitest";
import {
  APPLICATION_EXTENSION_ERROR_CODES,
  containsForbiddenExtensionKey,
  containsSensitiveExtensionKey,
  decodeApplicationExtensionChangesQuery,
  decodeApplicationExtensionConfigWrite,
  decodeApplicationExtensionMetadata,
  defineApplicationExtensionCatalog,
  findApplicationExtensionEntry,
  isApplicationExtensionChangeBatch,
  isApplicationExtensionMetadata,
  isApplicationExtensionSnapshot,
  isSecretReference,
  safeDiagnosticDetail,
  validateApplicationExtensionCatalog,
  type ApplicationExtensionMetadata,
  type ApplicationExtensionTrustedEntry
} from "../index.js";

const VALID_METADATA: ApplicationExtensionMetadata = {
  extensionId: "sample-site-extension",
  name: "样例站点插件",
  description: "用于测试的前后端扩展样例。",
  version: "1.0.0",
  managementScope: "site",
  host: "task",
  configSchema: { schemaId: "sample-site-config", schemaVersion: 1 },
  dependencies: [{ id: "task-runtime", required: true }],
  capabilities: [
    { id: "sample.capability", kind: "capability", description: "一个 typed capability" },
    { id: "sample.action", kind: "handler", description: "一个受控 handler", auth: "authenticated" }
  ]
};

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("应用插件元数据 codec（任务 1.1）", () => {
  it("接受合法可信元数据并往返保持字段集稳定", () => {
    const decoded = decodeApplicationExtensionMetadata(VALID_METADATA);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value).toEqual(VALID_METADATA);
    expect(roundTrip(decoded.value)).toEqual(VALID_METADATA);
    expect(isApplicationExtensionMetadata(decoded.value)).toBe(true);
  });

  it("拒绝代码位置字段，不产生副作用", () => {
    for (const key of ["module", "moduleUrl", "url", "script", "source", "entry", "entrypoint"]) {
      const decoded = decodeApplicationExtensionMetadata({ ...VALID_METADATA, [key]: "https://evil.example/x.js" });
      expect(decoded.ok, key).toBe(false);
      if (!decoded.ok) expect(decoded.code).toBe("malformed-request");
    }
    expect(containsForbiddenExtensionKey({ nested: { script: "x" } })).toBe(true);
    expect(containsForbiddenExtensionKey(VALID_METADATA)).toBe(false);
  });

  it("拒绝未知 host / managementScope / schema 版本类型", () => {
    expect(decodeApplicationExtensionMetadata({ ...VALID_METADATA, host: "canvas" }).ok).toBe(false);
    expect(decodeApplicationExtensionMetadata({ ...VALID_METADATA, host: "application" }).ok).toBe(true);
    expect(decodeApplicationExtensionMetadata({ ...VALID_METADATA, host: "task" }).ok).toBe(true);
    expect(decodeApplicationExtensionMetadata({ ...VALID_METADATA, host: "backend" }).ok).toBe(true);
    expect(decodeApplicationExtensionMetadata({ ...VALID_METADATA, managementScope: "browser" }).ok).toBe(false);
    expect(
      decodeApplicationExtensionMetadata({
        ...VALID_METADATA,
        configSchema: { schemaId: "s", schemaVersion: "1" }
      }).ok
    ).toBe(false);
  });

  it("拒绝重复 dependency / capability id", () => {
    expect(
      decodeApplicationExtensionMetadata({
        ...VALID_METADATA,
        dependencies: [
          { id: "a", required: true },
          { id: "a", required: false }
        ]
      }).ok
    ).toBe(false);
    expect(
      decodeApplicationExtensionMetadata({
        ...VALID_METADATA,
        capabilities: [
          { id: "dup", kind: "capability", description: "x" },
          { id: "dup", kind: "handler", description: "y" }
        ]
      }).ok
    ).toBe(false);
  });
});

describe("可信清单校验（任务 1.1/1.2）", () => {
  const trusted: ApplicationExtensionTrustedEntry = {
    ...VALID_METADATA,
    frontendEntry: true,
    backendHosts: ["task"],
    configScope: "site"
  };

  it("清单查找按 extensionId 命中，未登记条目返回 undefined", () => {
    // 生产站点目录来自扩展目录扫描（每个扩展自己的 `extension.json`），契约层不再内置清单；
    // 这里用本地 fixture 验证查找语义。
    const fixtureCatalog = defineApplicationExtensionCatalog([trusted]);
    expect(findApplicationExtensionEntry(fixtureCatalog, trusted.extensionId)).toMatchObject({
      frontendEntry: true,
      backendHosts: ["task"],
      configScope: "site"
    });
    expect(findApplicationExtensionEntry(fixtureCatalog, "not-registered")).toBeUndefined();
  });

  it("重复 extensionId 稳定拒绝；无入口条目拒绝", () => {
    expect(validateApplicationExtensionCatalog([trusted, trusted]).ok).toBe(false);
    expect(
      validateApplicationExtensionCatalog([{ ...trusted, frontendEntry: false, backendHosts: [] }]).ok
    ).toBe(false);
    expect(() => defineApplicationExtensionCatalog([trusted, trusted])).toThrow();
  });

  it("错误码枚举稳定且可判定", () => {
    expect(APPLICATION_EXTENSION_ERROR_CODES).toContain("revision-conflict");
    expect(APPLICATION_EXTENSION_ERROR_CODES).toContain("unauthorized");
  });
});

describe("站点配置写入 codec（任务 1.1）", () => {
  it("接受合法写入请求", () => {
    const decoded = decodeApplicationExtensionConfigWrite({
      expectedRevision: 3,
      enabled: true,
      values: { threshold: 5, tags: ["a", "b"] },
      secretRefs: ["provider-credential"]
    });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.expectedRevision).toBe(3);
  });

  it("拒绝代码位置字段、非 JSON 值与本秘密载体引用", () => {
    expect(
      decodeApplicationExtensionConfigWrite({ expectedRevision: 0, enabled: true, moduleUrl: "x" }).ok
    ).toBe(false);
    expect(
      decodeApplicationExtensionConfigWrite({
        expectedRevision: 0,
        enabled: true,
        values: { fn: undefined }
      }).ok
    ).toBe(false);
    expect(
      decodeApplicationExtensionConfigWrite({
        expectedRevision: 0,
        enabled: true,
        secretRefs: ["https://provider.example/secret"]
      }).ok
    ).toBe(false);
    expect(isSecretReference("provider-credential")).toBe(true);
    expect(isSecretReference("data:text/plain;base64,AAAA")).toBe(false);
  });
});

describe("公开状态脱敏（任务 1.1）", () => {
  it("状态快照校验与敏感键检测", () => {
    const snapshot = {
      revision: 4,
      catalog: [{ extensionId: "sample-site-extension", name: "样例", description: "说明", version: "1.0.0" }],
      plugins: [
        {
          extensionId: "sample-site-extension",
          desiredEnabled: true,
          actualState: "active",
          configVersion: 1,
          extensionRevision: 4,
          activeWorkCount: 2,
          diagnostics: [{ code: "ok", message: "正常" }]
        }
      ]
    };
    expect(isApplicationExtensionSnapshot(snapshot)).toBe(true);
    expect(isApplicationExtensionSnapshot({ ...snapshot, revision: -1 })).toBe(false);
    expect(isApplicationExtensionChangeBatch({ revision: 4, changes: [], resyncRequired: false })).toBe(true);
  });

  it("发布目录指针（change: 2026-10-21-add-extension-marketplace-point，6.2）：href 必须对应同一 releaseId", () => {
    const releaseId = "a".repeat(64);
    const pointer = { releaseId, href: `/extension-releases/${releaseId}.json` };
    const base = { revision: 1, catalog: [], plugins: [] };
    expect(isApplicationExtensionSnapshot({ ...base, extensionRelease: pointer })).toBe(true);
    expect(isApplicationExtensionSnapshot({ ...base, extensionRelease: { releaseId, href: `/extension-releases/${"b".repeat(64)}.json` } })).toBe(false);
    expect(isApplicationExtensionSnapshot({ ...base, extensionRelease: { releaseId, href: "https://evil.example/x.json" } })).toBe(false);
    expect(isApplicationExtensionChangeBatch({ revision: 1, changes: [], resyncRequired: false, extensionRelease: pointer })).toBe(true);
    expect(isApplicationExtensionChangeBatch({ revision: 1, changes: [], resyncRequired: false, extensionRelease: { releaseId: "x", href: "/" } })).toBe(false);
  });

  it("含秘密字段的对象被检出，诊断 detail 丢弃 URL/data 载体", () => {
    expect(containsSensitiveExtensionKey({ values: { token: "x" } })).toBe(true);
    expect(containsSensitiveExtensionKey({ code: "ok", message: "m" })).toBe(false);
    expect(safeDiagnosticDetail("https://provider.example/secret")).toBeUndefined();
    expect(safeDiagnosticDetail("data:application/json;base64,AAAA")).toBeUndefined();
    expect(safeDiagnosticDetail("provider 未配置")).toBe("provider 未配置");
  });

  it("changes 游标解析拒绝非法值", () => {
    expect(decodeApplicationExtensionChangesQuery({ after: "5" })).toEqual({ ok: true, after: 5 });
    expect(decodeApplicationExtensionChangesQuery({})).toEqual({ ok: true, after: 0 });
    expect(decodeApplicationExtensionChangesQuery({ after: "-1" }).ok).toBe(false);
    expect(decodeApplicationExtensionChangesQuery({ after: "abc" }).ok).toBe(false);
  });
});
