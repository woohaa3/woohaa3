/**
 * 生成模型运营策略测试
 * （change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 1.3/2.2/3.1 / design D2；
 *  change: 2026-10-07-remove-residual-compatibility —— 删除旧配置导入与 legacy 回退）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteGenerationModelStore } from "../extensions/generation-model-store.js";
import { resolveGenerationModels } from "../extensions/generation-model-index.js";

const dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-gen-model-"));
  dirs.push(dir);
  return path.join(dir, "models.sqlite");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("生成模型策略存储（任务 1.3/2.2/3.1）", () => {
  it("未知 identity 提交被拒且保留旧版本；版本冲突不修改状态", () => {
    const store = createSqliteGenerationModelStore({ path: tempDb() });
    const invalid = store.commit({ expectedRevision: 0, models: [{ modelKey: "ghost", enabled: true }], knownModelKeys: new Set(["a"]) });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.code).toBe("invalid");
    expect(store.revision()).toBe(0);

    const ok = store.commit({ expectedRevision: 0, models: [{ modelKey: "a", enabled: true }], knownModelKeys: new Set(["a"]) });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.revision).toBe(1);
    const conflict = store.commit({ expectedRevision: 0, models: [{ modelKey: "a", enabled: false }], knownModelKeys: new Set(["a"]) });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe("revision-conflict");
    store.close();
  });

  it("重复 modelKey 拒绝", () => {
    const store = createSqliteGenerationModelStore({ path: tempDb() });
    const result = store.commit({
      expectedRevision: 0,
      models: [{ modelKey: "a", enabled: true }, { modelKey: "a", enabled: false }],
      knownModelKeys: new Set(["a"])
    });
    expect(result.ok).toBe(false);
    store.close();
  });

  it("重启后管理设置保留；全部关闭保持关闭（不自动全开）", () => {
    const dbPath = tempDb();
    const store = createSqliteGenerationModelStore({ path: dbPath });
    // 管理员关闭全部模型。
    const commit = store.commit({ expectedRevision: 0, models: [{ modelKey: "a", enabled: false }], knownModelKeys: new Set(["a"]) });
    expect(commit.ok).toBe(true);
    store.close();

    // 重启：重新打开同一 store，策略保留；空启用集合保持关闭。
    const reopened = createSqliteGenerationModelStore({ path: dbPath });
    expect(reopened.initialized()).toBe(true);
    const result = resolveGenerationModels({
      registered: [{ modelKey: "a", providerId: "p", providerModelId: "a", modelType: "image" }],
      policy: reopened.snapshot()
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.models).toHaveLength(0);
    reopened.close();
  });
});

describe("生成模型索引（任务 3.1）", () => {
  const registered = [
    { modelKey: "p:a", providerId: "p", providerModelId: "a", modelType: "image" },
    { modelKey: "p:b", providerId: "p", providerModelId: "b", modelType: "image" }
  ];

  it("未初始化 → 全开", () => {
    const result = resolveGenerationModels({ registered, policy: { initialized: false, revision: 0, models: [] } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.models.map((m) => m.modelKey)).toEqual(["p:a", "p:b"]);
  });

  it("已初始化且空集合 → 保持关闭（不自动全开）", () => {
    const result = resolveGenerationModels({ registered, policy: { initialized: true, revision: 3, models: [] } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.models).toHaveLength(0);
  });

  it("selectionAuthority=server 的 Provider 模型绕过本地策略（已初始化、空集合）", () => {
    const result = resolveGenerationModels({
      registered: [
        { modelKey: "p:a", providerId: "p", providerModelId: "a", modelType: "image" },
        { modelKey: "remote:img", providerId: "remote", providerModelId: "img", modelType: "image" }
      ],
      policy: { initialized: true, revision: 4, models: [{ modelKey: "p:a", enabled: true }] },
      providerAuthority: { p: "local", remote: "server" }
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.models.map((m) => [m.modelKey, m.enabled])).toEqual([
      ["p:a", true],
      ["remote:img", true]
    ]);
  });

  it("server 权威模型的本地策略行只做展示覆盖，不影响可用性", () => {
    const registered = [
      { modelKey: "remote:img", providerId: "remote", providerModelId: "img", modelType: "image" },
      { modelKey: "remote:vid", providerId: "remote", providerModelId: "vid", modelType: "video" }
    ];
    const result = resolveGenerationModels({
      registered,
      policy: {
        initialized: true,
        revision: 7,
        models: [
          // 本地策略没勾选远端模型 / 甚至打了 tombstone：都不影响远端权威。
          { modelKey: "remote:img", enabled: false, title: "远端图片", order: 2 },
          { modelKey: "remote:vid", enabled: false, tombstone: true, order: 1, taskTimeoutMs: 9000 }
        ]
      },
      providerAuthority: { remote: "server" }
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 排序沿用策略 order；未写行的模型按注册顺序排在其后。
      expect(result.models.map((m) => m.modelKey)).toEqual(["remote:vid", "remote:img"]);
      expect(result.models.every((m) => m.enabled)).toBe(true);
      expect(result.models.find((m) => m.modelKey === "remote:img")?.title).toBe("远端图片");
      expect(result.models.find((m) => m.modelKey === "remote:vid")?.taskTimeoutMs).toBe(9000);
      // 不写策略：默认模型仍由策略行决定（未声明即无默认）。
      expect(result.defaults).toEqual({});
    }
  });

  it("未标记 server 的 Provider 继续按本地策略过滤（行为不变）", () => {
    const result = resolveGenerationModels({
      registered: [
        { modelKey: "p:a", providerId: "p", providerModelId: "a", modelType: "image" },
        { modelKey: "remote:img", providerId: "remote", providerModelId: "img", modelType: "image" }
      ],
      policy: {
        initialized: true,
        revision: 1,
        models: [{ modelKey: "remote:img", enabled: false }]
      },
      providerAuthority: { remote: "server", other: "local" }
    });
    // 这里 p 不在 authority map 里 → 缺省 local，策略没写它的行 → 关闭。
    // 而 remote=server 仍进入结果：验证两条路径互不影响。
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.models.map((m) => m.modelKey)).toEqual(["remote:img"]);
  });

  it("tombstone 模型从索引移除，但其它启用模型保留", () => {
    const result = resolveGenerationModels({
      registered,
      policy: {
        initialized: true,
        revision: 1,
        models: [
          { modelKey: "p:a", enabled: true, tombstone: true },
          { modelKey: "p:b", enabled: true, isDefault: true }
        ]
      }
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.models.map((m) => m.modelKey)).toEqual(["p:b"]);
      expect(result.defaults.image).toBe("p:b");
    }
  });
});
