/**
 * 模型策略／任务目录修订 → 任务目录失效
 * （回归：设置里启停模型后节点模型菜单不更新；change: 2026-10-20-reserve-remote-generation-provider，任务 6.1/6.3）。
 *
 * 设置弹窗不再整页刷新；模型开关只推进策略 revision。目录必须跟着重取，
 * 否则新启用的模型要手动刷新页面才出现。远端 Provider 注册/模型描述变化不改策略 revision，
 * 只推进快照里的 catalogRevision（宿主目录修订），同样必须让已打开的画布重取目录。
 */
import { describe, expect, it, vi } from "vitest";
import { invalidateCatalogOnModelPolicyChange, TaskCatalogStore } from "./task-catalog.js";
import { createGenerationModelsStatusService, type GenerationModelsStatusService } from "./generation-models-status.js";

type FakeRevision = { revision: number; catalogRevision: number };

function fakeModelsStatus(initial: FakeRevision) {
  let snapshot = {
    revision: initial.revision,
    catalogRevision: initial.catalogRevision,
    initialized: true,
    models: [],
    error: null as string | null,
    loading: false
  };
  const listeners = new Set<() => void>();
  const status: Pick<GenerationModelsStatusService, "getSnapshot" | "subscribe"> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
  return {
    status,
    /** 模拟一次权威快照发布（写入成功 / 轮询拿到新 revision）。 */
    publish(next: Partial<FakeRevision>) {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size
  };
}

describe("invalidateCatalogOnModelPolicyChange", () => {
  it("首次拿到权威快照只建立基线，不触发目录重取", () => {
    const models = fakeModelsStatus({ revision: -1, catalogRevision: -1 });
    const catalog = { invalidate: vi.fn() };
    invalidateCatalogOnModelPolicyChange(catalog, models.status);

    // 首次轮询同时拿到两个权威值：目录尚未加载，只建立基线。
    models.publish({ revision: 24, catalogRevision: 8 });
    expect(catalog.invalidate).not.toHaveBeenCalled();

    // 基线建立后，任一信号前进才重取。
    models.publish({ revision: 24, catalogRevision: 9 });
    expect(catalog.invalidate).toHaveBeenCalledTimes(1);
  });

  it("策略 revision 前进时使目录失效；相同或回退的 revision 不重复触发", () => {
    const models = fakeModelsStatus({ revision: 24, catalogRevision: 5 });
    const catalog = { invalidate: vi.fn() };
    invalidateCatalogOnModelPolicyChange(catalog, models.status);

    models.publish({ revision: 25 });
    expect(catalog.invalidate).toHaveBeenCalledTimes(1);

    models.publish({ revision: 25 });
    models.publish({ revision: 24 });
    expect(catalog.invalidate).toHaveBeenCalledTimes(1);

    models.publish({ revision: 26 });
    expect(catalog.invalidate).toHaveBeenCalledTimes(2);
  });

  it("catalogRevision 前进时使目录失效（远端 Provider 新增模型，策略 revision 不变）", () => {
    const models = fakeModelsStatus({ revision: 24, catalogRevision: 5 });
    const catalog = { invalidate: vi.fn() };
    invalidateCatalogOnModelPolicyChange(catalog, models.status);

    models.publish({ catalogRevision: 6 });
    expect(catalog.invalidate).toHaveBeenCalledTimes(1);

    // 旧值（回退）不回退基线，也不重复触发。
    models.publish({ catalogRevision: 5 });
    expect(catalog.invalidate).toHaveBeenCalledTimes(1);

    models.publish({ catalogRevision: 7 });
    expect(catalog.invalidate).toHaveBeenCalledTimes(2);
  });

  it("两者都未变时不重取", () => {
    const models = fakeModelsStatus({ revision: 24, catalogRevision: 5 });
    const catalog = { invalidate: vi.fn() };
    invalidateCatalogOnModelPolicyChange(catalog, models.status);

    models.publish({ revision: 24, catalogRevision: 5 });
    expect(catalog.invalidate).not.toHaveBeenCalled();
  });

  it("两者同时前进只重取一次", () => {
    const models = fakeModelsStatus({ revision: 24, catalogRevision: 5 });
    const catalog = { invalidate: vi.fn() };
    invalidateCatalogOnModelPolicyChange(catalog, models.status);

    models.publish({ revision: 25, catalogRevision: 6 });
    expect(catalog.invalidate).toHaveBeenCalledTimes(1);
  });

  it("旧宿主缺 catalogRevision（-1）时策略 revision 仍驱动失效，目录信号首次出现只建立基线", () => {
    const models = fakeModelsStatus({ revision: 24, catalogRevision: -1 });
    const catalog = { invalidate: vi.fn() };
    invalidateCatalogOnModelPolicyChange(catalog, models.status);

    // 策略 revision 前进：旧宿主行为不变。
    models.publish({ revision: 25, catalogRevision: -1 });
    expect(catalog.invalidate).toHaveBeenCalledTimes(1);

    // 目录修订首次出现（-1 → 0）：只建立基线，不重复重取。
    models.publish({ revision: 25, catalogRevision: 0 });
    expect(catalog.invalidate).toHaveBeenCalledTimes(1);

    models.publish({ revision: 25, catalogRevision: 1 });
    expect(catalog.invalidate).toHaveBeenCalledTimes(2);
  });

  it("返回的取消订阅停止监听", () => {
    const models = fakeModelsStatus({ revision: 24, catalogRevision: 5 });
    const catalog = { invalidate: vi.fn() };
    const unsubscribe = invalidateCatalogOnModelPolicyChange(catalog, models.status);

    unsubscribe();
    expect(models.listenerCount()).toBe(0);
    models.publish({ revision: 25, catalogRevision: 6 });
    expect(catalog.invalidate).not.toHaveBeenCalled();
  });
});

describe("模型策略／目录修订 → 目录重取（真实服务组合）", () => {
  function realService(initial: FakeRevision) {
    const state = { ...initial };
    const modelsRemote = {
      fetchSnapshot: async () => ({
        ok: true as const,
        snapshot: { revision: state.revision, initialized: true, models: [], catalogRevision: state.catalogRevision }
      }),
      writeConfig: async () => {
        state.revision += 1;
        return {
          ok: true as const,
          revision: state.revision,
          snapshot: {
            revision: state.revision,
            initialized: true,
            models: [],
            catalogRevision: state.catalogRevision
          }
        };
      }
    };
    const fetchCatalog = vi.fn(async () => ({ available: true, models: [], defaultModels: {}, catalogRevision: 1 }));
    const catalog = new TaskCatalogStore({
      fetchCatalog,
      createHistory: () => ({}) as never
    });
    const models = createGenerationModelsStatusService({ remote: modelsRemote });
    return { state, fetchCatalog, catalog, models };
  }

  it("setEnabled 成功后重新请求 catalog", async () => {
    const { fetchCatalog, catalog, models } = realService({ revision: 1, catalogRevision: 1 });
    const unsubscribe = invalidateCatalogOnModelPolicyChange(catalog, models);

    await models.refresh();
    await catalog.load();
    expect(fetchCatalog).toHaveBeenCalledTimes(1);

    // 设置里启用一个模型：策略 revision 前进，目录必须重新拉取（不刷新整页）。
    await models.setEnabled("litellm:gemini-4-argon", true);
    await vi.waitFor(() => expect(fetchCatalog).toHaveBeenCalledTimes(2));

    unsubscribe();
    models.dispose();
    catalog.dispose();
  });

  it("catalogRevision 前进（远端 Provider 注册/模型变化）后重新请求 catalog", async () => {
    const { state, fetchCatalog, catalog, models } = realService({ revision: 1, catalogRevision: 2 });
    const unsubscribe = invalidateCatalogOnModelPolicyChange(catalog, models);

    await models.refresh();
    await catalog.load();
    expect(fetchCatalog).toHaveBeenCalledTimes(1);

    // 远端 Provider 原地更新模型：策略 revision 不变，只有宿主目录修订前进。
    state.catalogRevision = 3;
    await models.refresh();
    await vi.waitFor(() => expect(fetchCatalog).toHaveBeenCalledTimes(2));

    // 快照未变化时不重取。
    await models.refresh();
    await Promise.resolve();
    expect(fetchCatalog).toHaveBeenCalledTimes(2);

    unsubscribe();
    models.dispose();
    catalog.dispose();
  });
});
