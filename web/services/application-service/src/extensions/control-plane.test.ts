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
import { createSiteExtensionControlPlane, type ExtensionToggleStore, type SiteExtensionControlPlane } from "./control-plane.js";
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
  activationTimeoutMs?: number;
  suspended?: ReadonlySet<string>;
  toggles?: ExtensionToggleStore;
} = {}): { plane: SiteExtensionControlPlane; store: ReturnType<typeof createSqliteSiteExtensionConfigStore>; work: ReturnType<typeof createSqliteExtensionWorkRepository>; host: ReturnType<typeof createApplicationExtensionHost> } {
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
    ...(overrides.activationTimeoutMs ? { activationTimeoutMs: () => overrides.activationTimeoutMs! } : {}),
    ...(overrides.suspended ? { suspended: overrides.suspended } : {}),
    ...(overrides.toggles ? { toggles: overrides.toggles } : {}),
    now: () => new Date("2026-10-04T00:00:00.000Z")
  });
  return { plane, store, work, host };
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

describe("激活时限、安全模式暂停与就绪门（change: 2026-10-21-harden-extension-fault-isolation）", () => {
  it("激活挂起：超时记 failed / activation-timeout；迟到成功被立即释放", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: Array<Record<string, unknown>> = [];
    const { plane, store, host } = makePlane({
      activationTimeoutMs: 50,
      logger: (event) => events.push(event),
      definitions: [{ extensionId: "sample-site-extension", activate: async () => { await gate; } }]
    });
    const result = await plane.write({ extensionId: "sample-site-extension", expectedRevision: 0, enabled: true, values: {}, secretRefs: [], actor: "admin" });
    expect(result.ok).toBe(true);
    const status = plane.status("sample-site-extension")!;
    expect(status.actualState).toBe("failed");
    expect(status.diagnostics[0]?.code).toBe("activation-timeout");
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.activeVersions("sample-site-extension")).toEqual([]);
    expect(events.some((event) => event.event === "site-extension-late-activation-released")).toBe(true);
    expect(plane.status("sample-site-extension")!.actualState).toBe("failed");
    store.close();
  });

  it("安全模式暂停：不激活、不改写 desiredEnabled，实际状态为 suspended", async () => {
    let activations = 0;
    const { plane, store } = makePlane({
      suspended: new Set(["sample-site-extension"]),
      definitions: [{ extensionId: "sample-site-extension", activate: () => { activations += 1; } }]
    });
    store.commit({ expectedRevision: 0, extensionId: "sample-site-extension", enabled: true, values: {}, secretRefs: [], actor: "admin", now: "2026-10-04T00:00:00.000Z" });
    await plane.reconcile();
    const status = plane.status("sample-site-extension")!;
    expect(status.actualState).toBe("suspended");
    expect(status.desiredEnabled).toBe(true);
    expect(activations).toBe(0);
    // 已停用的扩展在安全模式下仍显示停用，而不是 suspended。
    const off = await plane.write({ extensionId: "sample-site-extension", expectedRevision: store.revision(), enabled: false, values: {}, secretRefs: [], actor: "admin" });
    expect(off.ok && off.status.actualState).toBe("disabled");
    store.close();
  });

  it("就绪门：必需提供者协调完后即放行，不等可选扩展激活完成", async () => {
    let releaseOptional!: () => void;
    const optionalGate = new Promise<void>((resolve) => {
      releaseOptional = resolve;
    });
    const optional: ApplicationExtensionMetadata = { ...METADATA, extensionId: "optional-ext", defaultEnabled: true };
    const required: ApplicationExtensionMetadata = { ...METADATA, extensionId: "required-ext", defaultEnabled: true };
    const { plane, store } = makePlane({
      metadata: [optional, required],
      requiredProviders: [{ extensionId: "required-ext", slot: "identity" } as never],
      definitions: [
        { extensionId: "optional-ext", activate: async () => { await optionalGate; } },
        { extensionId: "required-ext", activate: () => undefined }
      ]
    });
    const settled = plane.reconcile();
    await plane.requiredReconciled();
    expect(plane.status("required-ext")!.actualState).toBe("active");
    expect(plane.status("optional-ext")!.actualState).toBe("configuring");
    releaseOptional();
    await settled;
    expect(plane.status("optional-ext")!.actualState).toBe("active");
    store.close();
  });
});

describe("崩溃熔断 quarantined（change: 2026-10-21-isolate-extension-host-process，D7）", () => {
  const countingDefinitions = (counter: { activations: number; disposals: number }) => [
    {
      extensionId: "sample-site-extension",
      activate: () => {
        counter.activations += 1;
        return { dispose: () => void (counter.disposals += 1) };
      }
    } satisfies ApplicationBackendExtensionDefinition
  ];

  it("隔离 → 解除 → 恢复 active；desiredEnabled 不变；revision 推进且有审计；重复调用幂等", async () => {
    const counter = { activations: 0, disposals: 0 };
    const { plane, store, host } = makePlane({ definitions: countingDefinitions(counter) });
    const enabled = await plane.write({ extensionId: "sample-site-extension", expectedRevision: 0, enabled: true, values: {}, secretRefs: [], actor: "admin" });
    expect(enabled.ok && enabled.status.actualState).toBe("active");
    const before = store.revision();

    const isolated = await plane.quarantine("sample-site-extension", { code: "crash-loop", message: "5 分钟内崩溃 3 次" });
    expect(isolated).toMatchObject({ ok: true, changed: true });
    expect(isolated.ok && isolated.revision).toBeGreaterThan(before);
    const status = plane.status("sample-site-extension")!;
    expect(status).toMatchObject({ actualState: "quarantined", desiredEnabled: true });
    expect(status.diagnostics).toEqual([{ code: "crash-loop", message: "5 分钟内崩溃 3 次" }]);
    expect(host.activeVersions("sample-site-extension")).toEqual([]);
    expect(plane.changes(before).changes.map((change) => change.status.actualState)).toEqual(["quarantined"]);

    const again = await plane.quarantine("sample-site-extension");
    expect(again).toMatchObject({ ok: true, changed: false });

    const released = await plane.unquarantine("sample-site-extension", "admin:alice");
    expect(released).toMatchObject({ ok: true, changed: true });
    expect(plane.status("sample-site-extension")).toMatchObject({ actualState: "active", desiredEnabled: true });
    expect(counter.activations).toBe(2);
    const events = store.audit("sample-site-extension").map((entry) => [entry.actor, entry.summary.event]).filter(([, event]) => event);
    expect(events).toEqual([["admin:alice", "unquarantined"], ["system:extension-host", "quarantined"]]);
    expect(await plane.unquarantine("sample-site-extension")).toMatchObject({ ok: true, changed: false });
    expect(await plane.quarantine("nope")).toMatchObject({ ok: false, code: "extension-not-found" });
    store.close();
  });

  it("隔离期间的配置提交落库但不激活；解除后按新版本激活", async () => {
    const counter = { activations: 0, disposals: 0 };
    const { plane, store } = makePlane({ definitions: countingDefinitions(counter) });
    await plane.write({ extensionId: "sample-site-extension", expectedRevision: 0, enabled: true, values: { v: 1 }, secretRefs: [], actor: "admin" });
    await plane.quarantine("sample-site-extension");
    const activationsBefore = counter.activations;
    const updated = await plane.write({ extensionId: "sample-site-extension", expectedRevision: store.revision(), enabled: true, values: { v: 2 }, secretRefs: [], actor: "admin" });
    expect(updated.ok && updated.status).toMatchObject({ actualState: "quarantined", configVersion: 2 });
    await plane.reconcile();
    expect(counter.activations).toBe(activationsBefore);
    expect(plane.status("sample-site-extension")!.actualState).toBe("quarantined");

    await plane.unquarantine("sample-site-extension");
    expect(plane.status("sample-site-extension")).toMatchObject({ actualState: "active", configVersion: 2 });
    expect(counter.activations).toBe(activationsBefore + 1);
    store.close();
  });

  it("管理员停用优先显示 disabled；重新启用后仍隔离；解除后按停用保持关闭", async () => {
    const counter = { activations: 0, disposals: 0 };
    const { plane, store } = makePlane({ definitions: countingDefinitions(counter) });
    await plane.write({ extensionId: "sample-site-extension", expectedRevision: 0, enabled: true, values: {}, secretRefs: [], actor: "admin" });
    await plane.quarantine("sample-site-extension");
    const off = await plane.write({ extensionId: "sample-site-extension", expectedRevision: store.revision(), enabled: false, values: {}, secretRefs: [], actor: "admin" });
    expect(off.ok && off.status.actualState).toBe("disabled");
    const on = await plane.write({ extensionId: "sample-site-extension", expectedRevision: store.revision(), enabled: true, values: {}, secretRefs: [], actor: "admin" });
    expect(on.ok && on.status.actualState).toBe("quarantined");
    await plane.write({ extensionId: "sample-site-extension", expectedRevision: store.revision(), enabled: false, values: {}, secretRefs: [], actor: "admin" });
    const activations = counter.activations;
    await plane.unquarantine("sample-site-extension");
    expect(plane.status("sample-site-extension")).toMatchObject({ actualState: "disabled", desiredEnabled: false });
    expect(counter.activations).toBe(activations);
    store.close();
  });

  it("安全模式下 suspended 优先于 quarantined；退出安全模式（重启）后仍隔离，审计是事实源", async () => {
    const dbPath = tempDb();
    const workPath = tempDb();
    const definitions = countingDefinitions({ activations: 0, disposals: 0 });
    const first = createSiteExtensionControlPlane({
      host: createApplicationExtensionHost(),
      store: createSqliteSiteExtensionConfigStore({ path: dbPath }),
      workStore: createSqliteExtensionWorkRepository({ path: workPath }),
      metadata: metadataSource(),
      definitions
    });
    await first.write({ extensionId: "sample-site-extension", expectedRevision: 0, enabled: true, values: {}, secretRefs: [], actor: "admin" });
    await first.quarantine("sample-site-extension");

    // 重启进入安全模式：扩展被暂停，投影 suspended（安全模式下根本不装配，不会再崩溃）。
    const safeStore = createSqliteSiteExtensionConfigStore({ path: dbPath });
    const safe = createSiteExtensionControlPlane({
      host: createApplicationExtensionHost(),
      store: safeStore,
      workStore: createSqliteExtensionWorkRepository({ path: workPath }),
      metadata: metadataSource(),
      definitions,
      suspended: new Set(["sample-site-extension"])
    });
    await safe.reconcile();
    expect(safe.status("sample-site-extension")!.actualState).toBe("suspended");

    // 再次正常重启：隔离从审计恢复，不自动激活。
    const normalStore = createSqliteSiteExtensionConfigStore({ path: dbPath });
    const counter = { activations: 0, disposals: 0 };
    const normal = createSiteExtensionControlPlane({
      host: createApplicationExtensionHost(),
      store: normalStore,
      workStore: createSqliteExtensionWorkRepository({ path: workPath }),
      metadata: metadataSource(),
      definitions: countingDefinitions(counter)
    });
    await normal.reconcile();
    expect(normal.status("sample-site-extension")!.actualState).toBe("quarantined");
    expect(counter.activations).toBe(0);
    await normal.unquarantine("sample-site-extension");
    expect(normal.status("sample-site-extension")!.actualState).toBe("active");
    safeStore.close();
    normalStore.close();
  });
});

describe("运行期登记 addExtension / removeExtension（首次安装的受管后端扩展）", () => {
  const LATE: ApplicationExtensionMetadata = { ...METADATA, extensionId: "late-ext", name: "运行期扩展", defaultEnabled: true };
  const lateDefinition = (counter: { activations: number }, activate?: () => Promise<void>) =>
    ({
      extensionId: "late-ext",
      activate: async () => {
        counter.activations += 1;
        await activate?.();
      }
    }) satisfies ApplicationBackendExtensionDefinition;

  it("add：首次 defaultEnabled → 版本化提交并激活；snapshot 出现；重复 add / 启动期 id → extension-exists", async () => {
    const counter = { activations: 0 };
    const { plane, store } = makePlane();
    const before = store.revision();
    const added = await plane.addExtension({ metadata: LATE, definition: lateDefinition(counter) });
    expect(added).toMatchObject({ ok: true, status: { extensionId: "late-ext", actualState: "active", desiredEnabled: true } });
    expect(added.ok && added.revision).toBeGreaterThan(before);
    expect(counter.activations).toBe(1);
    expect(plane.snapshot().catalog.map((entry) => entry.extensionId)).toEqual(["sample-site-extension", "late-ext"]);
    expect(plane.changes(before).changes.some((change) => change.extensionId === "late-ext")).toBe(true);
    expect(await plane.addExtension({ metadata: LATE, definition: lateDefinition(counter) })).toMatchObject({ ok: false, code: "extension-exists" });
    expect(await plane.addExtension({ metadata: METADATA, definition: { extensionId: METADATA.extensionId, activate: () => undefined } })).toMatchObject({
      ok: false,
      code: "extension-exists"
    });
    expect(await plane.addExtension({ metadata: LATE, definition: { extensionId: "other", activate: () => undefined } })).toMatchObject({
      ok: false,
      code: "extension-invalid"
    });
    store.close();
  });

  it("激活失败：登记保留、状态 failed，可按配置变化重试；remove 只允许运行期扩展", async () => {
    const counter = { activations: 0 };
    let fail = true;
    const { plane, store } = makePlane();
    const added = await plane.addExtension({
      metadata: LATE,
      definition: lateDefinition(counter, async () => {
        if (fail) throw new Error("boom");
      })
    });
    expect(added.ok && added.status?.actualState).toBe("failed");
    fail = false;
    const retried = await plane.write({ extensionId: "late-ext", expectedRevision: store.revision(), enabled: true, values: { v: 2 }, secretRefs: [], actor: "admin" });
    expect(retried.ok && retried.status.actualState).toBe("active");
    expect(await plane.removeExtension(METADATA.extensionId)).toMatchObject({ ok: false, code: "extension-not-removable" });
    expect(await plane.removeExtension("nope")).toMatchObject({ ok: false, code: "extension-not-found" });
    store.close();
  });

  it("remove：有在途工作 → extension-busy；收尾后移除，实例释放、snapshot 不再有它；配置保留，重装后沿用停用", async () => {
    const counter = { activations: 0 };
    const { plane, store, host } = makePlane();
    await plane.addExtension({ metadata: LATE, definition: lateDefinition(counter) });
    const work = plane.workFacade("late-ext").admit();
    expect(work.ok).toBe(true);
    const busy = await plane.removeExtension("late-ext");
    expect(busy).toMatchObject({ ok: false, code: "extension-busy", activeWorkCount: 1 });
    // 先停用（draining），收尾后再移除。
    await plane.write({ extensionId: "late-ext", expectedRevision: store.revision(), enabled: false, values: {}, secretRefs: [], actor: "admin" });
    expect(plane.status("late-ext")!.actualState).toBe("draining");
    plane.workFacade("late-ext").resume((work as { workId: string }).workId)!.settle("succeeded");
    const before = store.revision();
    const removed = await plane.removeExtension("late-ext");
    expect(removed).toMatchObject({ ok: true });
    expect(removed.ok && removed.revision).toBeGreaterThan(before);
    expect(host.activeVersions("late-ext")).toEqual([]);
    expect(plane.status("late-ext")).toBeUndefined();
    expect(plane.snapshot().catalog.map((entry) => entry.extensionId)).toEqual(["sample-site-extension"]);
    expect(await plane.removeExtension("late-ext")).toMatchObject({ ok: false, code: "extension-not-found" });

    // 重装：沿用已保存的停用配置，不因 defaultEnabled 再次启用。
    const reinstalled = await plane.addExtension({ metadata: LATE, definition: lateDefinition(counter) });
    expect(reinstalled.ok && reinstalled.status).toMatchObject({ actualState: "disabled", desiredEnabled: false });
    store.close();
  });

  it("安全模式 / 隔离下的运行期 add 不激活；隔离记录从审计恢复", async () => {
    const counter = { activations: 0 };
    const { plane, store } = makePlane({ suspended: new Set(["late-ext"]) });
    const added = await plane.addExtension({ metadata: LATE, definition: lateDefinition(counter) });
    expect(added.ok && added.status?.actualState).toBe("suspended");
    expect(counter.activations).toBe(0);
    store.close();

    const second = makePlane();
    await second.plane.addExtension({ metadata: LATE, definition: lateDefinition(counter) });
    await second.plane.quarantine("late-ext");
    await second.plane.write({ extensionId: "late-ext", expectedRevision: second.store.revision(), enabled: false, values: {}, secretRefs: [], actor: "admin" });
    await second.plane.removeExtension("late-ext");
    const activations = counter.activations;
    // 重装后沿用停用配置；重新启用时隔离记录（审计恢复）仍生效，不激活。
    const readded = await second.plane.addExtension({ metadata: LATE, definition: lateDefinition(counter) });
    expect(readded.ok && readded.status?.actualState).toBe("disabled");
    const enabled = await second.plane.write({ extensionId: "late-ext", expectedRevision: second.store.revision(), enabled: true, values: {}, secretRefs: [], actor: "admin" });
    expect(enabled.ok && enabled.status.actualState).toBe("quarantined");
    expect(counter.activations).toBe(activations);
    second.store.close();
  });
});

/**
 * 缺省启停：生产路径是注入 `toggles`（配置文件 `extensions.<id>.enabled`）。
 *
 * 语义钉死为「缺省关」——manifest 未声明 `defaultEnabled` 时按停用处理：市场安装的扩展、
 * 以及以后忘写这个字段的内置扩展都不会被自动激活，启用必须有人显式表达。
 */
describe("缺省启停（配置文件 + manifest defaultEnabled）", () => {
  function memoryToggles(initial: Record<string, boolean> = {}) {
    const state: Record<string, boolean> = { ...initial };
    const store: ExtensionToggleStore = {
      all: () => ({ ...state }),
      async set(extensionId, enabled) {
        state[extensionId] = enabled;
        return { ok: true as const };
      }
    };
    return { store, state };
  }

  it("配置文件与 manifest 都没有值 → 停用，不产生可激活实例", async () => {
    const { store: toggles, state } = memoryToggles();
    const { plane, store } = makePlane({ toggles });
    await plane.reconcile();
    expect(plane.status(METADATA.extensionId)).toMatchObject({ desiredEnabled: false, actualState: "disabled" });
    expect(state).toEqual({});

    const enabled = await plane.write({
      extensionId: METADATA.extensionId, expectedRevision: store.revision(), enabled: true, values: {}, secretRefs: [], actor: "admin"
    });
    expect(enabled).toMatchObject({ ok: true });
    // 启停写在配置文件（toggles）里，不是 SQLite 的 desiredEnabled。
    expect(state[METADATA.extensionId]).toBe(true);
    expect(plane.status(METADATA.extensionId)).toMatchObject({ desiredEnabled: true, actualState: "active" });
    await plane.dispose();
  });

  it("manifest 显式 defaultEnabled:true 才算缺省启用，显式停用优先", async () => {
    const byDefault = memoryToggles();
    const first = makePlane({ metadata: [{ ...METADATA, defaultEnabled: true }], toggles: byDefault.store });
    await first.plane.reconcile();
    expect(first.plane.status(METADATA.extensionId)).toMatchObject({ desiredEnabled: true, actualState: "active" });
    await first.plane.dispose();

    const explicitlyOff = memoryToggles({ [METADATA.extensionId]: false });
    const second = makePlane({ metadata: [{ ...METADATA, defaultEnabled: true }], toggles: explicitlyOff.store });
    await second.plane.reconcile();
    expect(second.plane.status(METADATA.extensionId)).toMatchObject({ desiredEnabled: false, actualState: "disabled" });
    await second.plane.dispose();
  });

  it.each(["manifest", "file"])("%s 启用的无数据库配置实例保留路由，提交配置后释放基线版本", async (source) => {
    let disposals = 0;
    const toggles = memoryToggles(source === "file" ? { [METADATA.extensionId]: true } : {});
    const { plane, host, store } = makePlane({
      metadata: [{ ...METADATA, defaultEnabled: source === "manifest" }],
      toggles: toggles.store,
      definitions: [{
        extensionId: METADATA.extensionId,
        activate: (h) => {
          h.registerCapability({ id: "sample.action", value: { ok: true } });
          h.registerHandler({ route: "sample/connections", auth: "public", handle: () => ({ body: { connections: [] } }) });
          h.registerRawHttpHandler?.({ route: "connections", method: "GET", auth: "public", purpose: "read", handle: async () => undefined });
          return { dispose: () => { disposals += 1; } };
        }
      }]
    });
    const readConnections = () => host.dispatch("sample/connections", { body: null, context: { authLevel: "public" } });
    await plane.reconcile();
    expect(store.get(METADATA.extensionId)).toBeUndefined();
    expect(host.activeVersions(METADATA.extensionId)).toEqual([0]);
    expect(host.resolveCapability("sample.action")).toEqual({ ok: true });
    expect(host.resolvePublicRoute(METADATA.extensionId, "connections", "GET")).toEqual({ owned: true });
    expect((await readConnections()).body).toEqual({ connections: [] });
    await plane.reconcile();
    expect((await readConnections()).body).toEqual({ connections: [] });
    expect(host.resolvePublicRoute(METADATA.extensionId, "connections", "GET")).toEqual({ owned: true });
    expect(disposals).toBe(0);

    const written = await plane.write({
      extensionId: METADATA.extensionId, expectedRevision: store.revision(), enabled: true, values: {}, secretRefs: [], actor: "admin"
    });
    expect(written.ok).toBe(true);
    expect(host.activeVersions(METADATA.extensionId)).toEqual([1]);
    expect((await readConnections()).body).toEqual({ connections: [] });
    expect(host.resolvePublicRoute(METADATA.extensionId, "connections", "GET")).toEqual({ owned: true });
    expect(disposals).toBe(1);
    await plane.dispose();
    await host.dispose();
    expect(disposals).toBe(2);
  });

  it("配置文件停用无数据库配置的基线实例时正常释放路由", async () => {
    const toggles = memoryToggles();
    const { plane, host } = makePlane({ metadata: [{ ...METADATA, defaultEnabled: true }], toggles: toggles.store });
    await plane.reconcile();
    expect(host.resolveCapability("sample.action")).toEqual({ ok: true });
    await toggles.store.set(METADATA.extensionId, false);
    await plane.reconcile();
    expect(host.activeVersions(METADATA.extensionId)).toEqual([]);
    expect(host.resolveCapability("sample.action")).toBeUndefined();
    expect(plane.status(METADATA.extensionId)).toMatchObject({ desiredEnabled: false, actualState: "disabled" });
    await plane.dispose();
  });
});
