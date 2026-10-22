/**
 * 站点插件控制面测试（change: 2026-10-04-add-backend-plugin-extensions，任务 3.1）。
 *
 * 验证：并发冲突保留较新配置、prepare/校验失败保留旧配置、commit 后崩溃由 reconcile 恢复、
 * 旧版本引用与 draining（不取消工作）及审计/脱敏。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ApplicationExtensionMetadata, RequiredProviderProfiles } from "@woohaa3/contracts";
import { createSqliteSiteExtensionConfigStore } from "./config-store.js";
import { createSqliteExtensionWorkRepository } from "../repository/extension-work-repository.js";
import { createApplicationExtensionHost } from "./host.js";
import { createSiteExtensionControlPlane, type SiteExtensionControlPlane } from "./control-plane.js";
import type { ApplicationBackendExtensionDefinition } from "./contract.js";

const dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-site-plugin-"));
  dirs.push(dir);
  return path.join(dir, "plugin.sqlite");
}
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const METADATA: ApplicationExtensionMetadata = {
  extensionId: "sample-site-extension",
  name: "样例站点插件",
  description: "测试用后端扩展。",
  directory: "extensions/sample-site-extension",
  version: "1.0.0",
  managementScope: "site",
  host: "task",
  configSchema: { schemaId: "sample-site-config", schemaVersion: 1 },
  dependencies: [{ id: "task-runtime", required: true }],
  capabilities: [{ id: "sample.action", kind: "handler", description: "样例", auth: "authenticated" }]
};

function metadataSource(list: ApplicationExtensionMetadata[] = [METADATA]) {
  return {
    list: () => list,
    get: (extensionId: string) => list.find((entry) => entry.extensionId === extensionId)
  };
}

function makePlane(overrides: {
  definitions?: ApplicationBackendExtensionDefinition[];
  validateConfig?: (extensionId: string, values: Record<string, unknown>, metadata: ApplicationExtensionMetadata) => string | null;
  metadata?: ApplicationExtensionMetadata[];
  requiredProviders?: RequiredProviderProfiles;
  logger?: (event: Record<string, unknown>) => void;
} = {}): { plane: SiteExtensionControlPlane; store: ReturnType<typeof createSqliteSiteExtensionConfigStore>; work: ReturnType<typeof createSqliteExtensionWorkRepository> } {
  const store = createSqliteSiteExtensionConfigStore({ path: tempDb() });
  const work = createSqliteExtensionWorkRepository({ path: tempDb() });
  const host = createApplicationExtensionHost();
  const definitions =
    overrides.definitions ??
    [
      {
        extensionId: "sample-site-extension",
        activate: (h) => {
          h.registerCapability({ id: "sample.action", value: { ok: true } });
        }
      } satisfies ApplicationBackendExtensionDefinition
    ];
  const plane = createSiteExtensionControlPlane({
    host,
    store,
    workStore: work,
    metadata: metadataSource(overrides.metadata),
    definitions,
    ...(overrides.validateConfig ? { validateConfig: overrides.validateConfig } : {}),
    ...(overrides.requiredProviders ? { requiredProviders: overrides.requiredProviders } : {}),
    ...(overrides.logger ? { logger: overrides.logger } : {}),
    now: () => new Date("2026-10-04T00:00:00.000Z")
  });
  return { plane, store, work };
}

describe("站点配置提交（任务 3.1）", () => {
  it("停用是运行时配置：保留已存配置并立即停用，重启后保持关闭", async () => {
    const { plane, store } = makePlane();
    store.commit({ extensionId: METADATA.extensionId, expectedRevision: 0, enabled: false,
      values: { threshold: 7 }, secretRefs: ["saved-key"], actor: "legacy", now: new Date().toISOString() });
    await plane.reconcile();
    // 旧记录就是权威目标：不会被 reconciler 改写，也不会因此自动启用。
    expect(plane.status(METADATA.extensionId)).toMatchObject({ desiredEnabled: false, actualState: "disabled" });
    expect(store.get(METADATA.extensionId)).toMatchObject({ values: { threshold: 7 }, secretRefs: ["saved-key"] });
    const enabled = await plane.write({ extensionId: METADATA.extensionId, expectedRevision: store.revision(), enabled: true,
      values: { threshold: 7 }, secretRefs: ["saved-key"], actor: "admin" });
    expect(enabled).toMatchObject({ ok: true });
    expect(plane.status(METADATA.extensionId)?.actualState).toBe("active");
    const disabled = await plane.write({ extensionId: METADATA.extensionId, expectedRevision: store.revision(), enabled: false,
      values: { threshold: 7 }, secretRefs: ["saved-key"], actor: "admin" });
    expect(disabled).toMatchObject({ ok: true });
    expect(plane.status(METADATA.extensionId)).toMatchObject({ desiredEnabled: false, actualState: "disabled" });
    await plane.dispose();
  });

  it("可信默认仅首次启用，重复协调不新增配置版本，管理员停用后重启保持关闭", async () => {
    const metadata = { ...METADATA, defaultEnabled: true };
    const { plane, store, work } = makePlane({ metadata: [metadata] });
    await plane.reconcile();
    expect(plane.status(metadata.extensionId)).toMatchObject({ actualState: "active", desiredEnabled: true, configVersion: 1 });
    await plane.reconcile();
    expect(store.listVersions(metadata.extensionId)).toHaveLength(1);
    expect(store.audit(metadata.extensionId)).toMatchObject([{ actor: "system:trusted-default" }]);
    await plane.write({ extensionId: metadata.extensionId, expectedRevision: store.revision(), enabled: false,
      values: {}, secretRefs: [], actor: "admin" });
    await plane.dispose();
    const restarted = createSiteExtensionControlPlane({ host: createApplicationExtensionHost(), store, workStore: work,
      metadata: metadataSource([metadata]), definitions: [{ extensionId: metadata.extensionId, activate: () => ({}) }] });
    await restarted.reconcile();
    expect(restarted.status(metadata.extensionId)).toMatchObject({ actualState: "disabled", desiredEnabled: false, configVersion: 2 });
    expect(store.listVersions(metadata.extensionId)).toHaveLength(2);
    await restarted.dispose();
  });

  it("未配置插件状态为 unconfigured；提交后 desired/actual/configVersion/revision 正确", async () => {
    const { plane } = makePlane();
    expect(plane.status("sample-site-extension")?.actualState).toBe("unconfigured");
    expect(plane.snapshot().catalog[0].directory).toBe("extensions/sample-site-extension");
    const outcome = await plane.write({
      extensionId: "sample-site-extension",
      expectedRevision: 0,
      enabled: true,
      values: { threshold: 5 },
      secretRefs: ["cred"],
      actor: "admin@example"
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 配置提交推进 revision；随后实际状态变化也推进 revision（design D6）。
    expect(outcome.revision).toBeGreaterThanOrEqual(1);
    expect(outcome.status.desiredEnabled).toBe(true);
    expect(outcome.status.actualState).toBe("active");
    expect(outcome.status.configVersion).toBe(1);
    expect(plane.snapshot().revision).toBeGreaterThanOrEqual(outcome.revision);
  });

  it("并发使用过期 expectedRevision 返回冲突并保留较新配置", async () => {
    const { plane } = makePlane();
    await plane.write({ extensionId: "sample-site-extension", expectedRevision: 0, enabled: true, values: { v: 1 }, secretRefs: [], actor: "a" });
    const first = await plane.write({ extensionId: "sample-site-extension", expectedRevision: plane.snapshot().revision, enabled: true, values: { v: 2 }, secretRefs: [], actor: "a" });
    expect(first.ok).toBe(true);
    // 过期 revision 再次提交被拒绝。
    const stale = plane.snapshot().revision - 1;
    const conflict = await plane.write({ extensionId: "sample-site-extension", expectedRevision: stale, enabled: false, values: { v: 3 }, secretRefs: [], actor: "b" });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.code).toBe("revision-conflict");
    // 较新配置保留（v2、仍启用）。
    expect(plane.status("sample-site-extension")?.desiredEnabled).toBe(true);
    expect(plane.status("sample-site-extension")?.configVersion).toBe(2);
  });

  it("配置校验失败保留旧配置且不推进 revision", async () => {
    const { plane } = makePlane({
      validateConfig: (_extensionId, values) => (typeof values.threshold === "number" ? null : "threshold 必须是数字")
    });
    const valid = await plane.write({ extensionId: "sample-site-extension", expectedRevision: 0, enabled: true, values: { threshold: 5 }, secretRefs: [], actor: "a" });
    expect(valid.ok).toBe(true);
    const revisionAfterValid = plane.snapshot().revision;
    const invalid = await plane.write({ extensionId: "sample-site-extension", expectedRevision: revisionAfterValid, enabled: true, values: { threshold: "bad" }, secretRefs: [], actor: "a" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.code).toBe("config-invalid");
    expect(plane.snapshot().revision).toBe(revisionAfterValid);
    expect(plane.status("sample-site-extension")?.configVersion).toBe(1);
  });

  it("未知插件稳定拒绝", async () => {
    const { plane } = makePlane();
    const outcome = await plane.write({ extensionId: "nope", expectedRevision: 0, enabled: true, values: {}, secretRefs: [], actor: "a" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("extension-not-found");
    expect(plane.snapshot().revision).toBe(0);
  });

  it("必需基础提供者不能在线停用，返回稳定 required-provider（任务 1.5）", async () => {
    const required = { ...METADATA, extensionId: "test-identity" };
    const optional = { ...METADATA, extensionId: "optional-plugin" };
    const { plane } = makePlane({
      metadata: [required, optional],
      definitions: [
        { extensionId: "test-identity", activate: () => ({}) },
        { extensionId: "optional-plugin", activate: () => ({}) }
      ],
      requiredProviders: [{ slot: "identity", extensionId: "test-identity" }]
    });
    // 停用必需 provider：拒绝且不推进 revision / 不产生配置。
    const rejected = await plane.write({
      extensionId: "test-identity",
      expectedRevision: 0,
      enabled: false,
      values: {},
      secretRefs: [],
      actor: "admin"
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe("required-provider");
    expect(plane.snapshot().revision).toBe(0);
    expect(plane.status("test-identity")?.desiredEnabled).toBe(false);
    // 启用必需 provider 允许（只有停用被拒绝）。
    const enabled = await plane.write({
      extensionId: "test-identity",
      expectedRevision: 0,
      enabled: true,
      values: {},
      secretRefs: [],
      actor: "admin"
    });
    expect(enabled.ok).toBe(true);
    // 非必需插件仍可正常启停。
    await plane.write({
      extensionId: "optional-plugin",
      expectedRevision: plane.snapshot().revision,
      enabled: true,
      values: {},
      secretRefs: [],
      actor: "admin"
    });
    const disabled = await plane.write({
      extensionId: "optional-plugin",
      expectedRevision: plane.snapshot().revision,
      enabled: false,
      values: {},
      secretRefs: [],
      actor: "admin"
    });
    expect(disabled.ok).toBe(true);
  });
});

describe("commit 后崩溃与 reconcile（任务 3.1）", () => {
  it("提交后进程重启：reconcile 依据已提交版本重建实际状态", async () => {
    const dbPath = tempDb();
    const workPath = tempDb();
    const store = createSqliteSiteExtensionConfigStore({ path: dbPath });
    // 直接持久化一次「已提交但 activation 尚未完成」的配置（模拟 commit 后崩溃）。
    store.commit({ expectedRevision: 0, extensionId: "sample-site-extension", enabled: true, values: { v: 1 }, secretRefs: [], actor: "a", now: "2026-10-04T00:00:00.000Z" });
    store.close();

    // 重启：重新打开 store，reconcile 应把配置激活为 active。
    const reopened = createSqliteSiteExtensionConfigStore({ path: dbPath });
    const work = createSqliteExtensionWorkRepository({ path: workPath });
    const host = createApplicationExtensionHost();
    const plane = createSiteExtensionControlPlane({
      host,
      store: reopened,
      workStore: work,
      metadata: metadataSource(),
      definitions: [
        { extensionId: "sample-site-extension", activate: (h) => { h.registerCapability({ id: "sample.action", value: {} }); } }
      ]
    });
    expect(plane.status("sample-site-extension")?.actualState).toBe("configuring");
    await plane.reconcile();
    expect(plane.status("sample-site-extension")?.actualState).toBe("active");
    expect(plane.status("sample-site-extension")?.configVersion).toBe(1);
    reopened.close();
    work.close();
  });
});

describe("审计与脱敏（任务 3.1）", () => {
  it("审计记录操作者/版本/安全摘要且不含秘密值", async () => {
    const { plane, store } = makePlane();
    await plane.write({
      extensionId: "sample-site-extension",
      expectedRevision: 0,
      enabled: true,
      values: { threshold: 5 },
      secretRefs: ["cred"],
      actor: "admin@example"
    });
    const audit = store.audit("sample-site-extension");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: "admin@example", toRevision: 1, configVersion: 1 });
    expect(audit[0]?.summary).toEqual({ enabled: true, secretRefCount: 1, valueKeys: ["threshold"] });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("data:");
  });

  it("changes 增量在 cursor 过旧/超前时要求 resync", async () => {
    const { plane } = makePlane();
    await plane.write({ extensionId: "sample-site-extension", expectedRevision: 0, enabled: true, values: {}, secretRefs: [], actor: "a" });
    const delta = plane.changes(0);
    expect(delta.resyncRequired).toBe(false);
    expect(delta.changes.map((entry) => entry.extensionId)).toEqual(["sample-site-extension"]);
    expect(plane.changes(99).resyncRequired).toBe(true);
    expect(plane.changes(-1).resyncRequired).toBe(true);
  });
});

/**
 * 插件自报健康：activation 成功 ≠ 能力可用（生成 Provider 缺凭据时仍要装载才能预填配置）。
 * 这类「装着但用不了」的稳态报 degraded，并在补上凭据后（不重启插件）回到 active。
 */
describe("站点插件健康（degraded）", () => {
  const degradedHealth = {
    state: "degraded" as const,
    diagnostics: [{ code: "provider-credentials-missing", message: "未配置 API Key，模型当前不可执行" }]
  };

  it("已装载但能力未就绪时报 degraded 与插件诊断，恢复后回到 active", async () => {
    let healthy = false;
    const metadata = { ...METADATA, defaultEnabled: true };
    const { plane } = makePlane({
      metadata: [metadata],
      definitions: [
        {
          extensionId: metadata.extensionId,
          health: () => (healthy ? undefined : degradedHealth),
          activate: () => undefined
        }
      ]
    });
    await plane.reconcile();
    expect(plane.status(metadata.extensionId)).toMatchObject({
      actualState: "degraded",
      desiredEnabled: true,
      diagnostics: degradedHealth.diagnostics
    });
    // 健康钩子按需重读：插件没重启，补上凭据后状态自己回到 active。
    healthy = true;
    expect(plane.status(metadata.extensionId)).toMatchObject({ actualState: "active", diagnostics: [] });
  });

  it("停用或配置中时不问插件健康", async () => {
    const metadata = { ...METADATA, defaultEnabled: true };
    const { plane, store } = makePlane({
      metadata: [metadata],
      definitions: [
        { extensionId: metadata.extensionId, health: () => degradedHealth, activate: () => undefined }
      ]
    });
    await plane.reconcile();
    await plane.write({
      extensionId: metadata.extensionId,
      expectedRevision: store.revision(),
      enabled: false,
      values: {},
      secretRefs: [],
      actor: "admin"
    });
    // 停用后状态是 disabled，不被 health 覆盖成 degraded。
    expect(plane.status(metadata.extensionId)).toMatchObject({ actualState: "disabled", desiredEnabled: false });
  });

  it("health 抛错不让状态查询失败：按健康处理并记日志", async () => {
    const events: Array<Record<string, unknown>> = [];
    const metadata = { ...METADATA, defaultEnabled: true };
    const { plane } = makePlane({
      metadata: [metadata],
      logger: (event) => events.push(event),
      definitions: [
        {
          extensionId: metadata.extensionId,
          health: () => {
            throw new Error("health boom");
          },
          activate: () => undefined
        }
      ]
    });
    await plane.reconcile();
    expect(plane.status(metadata.extensionId)?.actualState).toBe("active");
    expect(events).toContainEqual(
      expect.objectContaining({ event: "site-extension-health-failed", extensionId: metadata.extensionId, message: "health boom" })
    );
  });
});
