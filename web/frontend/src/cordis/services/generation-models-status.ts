/**
 * 生成模型状态 Service
 * （change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 5.1 / design D2）。
 *
 * 服务端权威模型策略的浏览器读模型：拉取 snapshot，支持管理员启停/设默认。
 * 不含秘密；旧响应不覆盖新 revision。
 */
import type { GenerationModelsSnapshot } from "@woohaa3/contracts";
import type { GenerationModelsRemote } from "./generation-models-remote.js";

export type GenerationModelsStatusSnapshot = {
  revision: number;
  /**
   * 当前任务目录修订（change: 2026-10-20-reserve-remote-generation-provider，任务 6.1）。
   *
   * 宿主在已被轮询的模型快照里透出；Provider 注册/可用性/模型描述版本变化时单调前进。
   * 前端据此使任务目录失效。旧宿主没有该信号时为 -1（「无此信号」）。
   */
  catalogRevision: number;
  initialized: boolean;
  models: GenerationModelsSnapshot["models"];
  error: string | null;
  loading: boolean;
};

export type GenerationModelsStatusService = {
  getSnapshot: () => GenerationModelsStatusSnapshot;
  subscribe: (listener: () => void) => () => void;
  refresh: () => Promise<void>;
  setEnabled: (modelKey: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  /** 一次启用或关闭一批模型。关闭时清掉这批里的默认标记。已删除的模型不动。 */
  setEnabledMany: (modelKeys: readonly string[], enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  setDefault: (modelKey: string, modelType: string) => Promise<{ ok: boolean; error?: string }>;
  start: () => void;
  stop: () => void;
  dispose: () => void;
};

const EMPTY: GenerationModelsStatusSnapshot = {
  revision: -1,
  catalogRevision: -1,
  initialized: false,
  models: [],
  error: null,
  loading: true
};

/** 宿主快照里的目录修订；旧宿主缺字段时按「无此信号」(-1) 处理。 */
function readCatalogRevision(snapshot: GenerationModelsSnapshot): number {
  return snapshot.catalogRevision ?? -1;
}

export function createGenerationModelsStatusService(options: {
  remote: GenerationModelsRemote;
  pollIntervalMs?: number;
}): GenerationModelsStatusService {
  const listeners = new Set<() => void>();
  let snapshot: GenerationModelsStatusSnapshot = EMPTY;
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const publish = (next: GenerationModelsStatusSnapshot) => {
    snapshot = next;
    if (disposed) return;
    for (const listener of listeners) listener();
  };

  const refresh = async (): Promise<void> => {
    if (disposed) return;
    const result = await options.remote.fetchSnapshot();
    if (disposed) return;
    if (!result.ok) {
      publish({ ...snapshot, error: result.error, loading: false });
      return;
    }
    // 单调：旧响应不覆盖更新 revision。
    if (result.snapshot.revision < snapshot.revision) return;
    publish({
      revision: result.snapshot.revision,
      catalogRevision: readCatalogRevision(result.snapshot),
      initialized: result.snapshot.initialized,
      models: result.snapshot.models,
      error: null,
      loading: false
    });
  };

  const write = async (
    mutate: (models: GenerationModelsSnapshot["models"]) => GenerationModelsSnapshot["models"]
  ): Promise<{ ok: boolean; error?: string }> => {
    const next = mutate(snapshot.models);
    const result = await options.remote.writeConfig({ expectedRevision: Math.max(snapshot.revision, 0), models: next });
    if (!result.ok) {
      publish({ ...snapshot, error: result.error });
      return { ok: false, error: result.error };
    }
    // 写响应可能不带目录修订（策略写入不改变目录）；保留已读到的值，不回退。
    publish({
      revision: result.revision,
      catalogRevision: result.snapshot.catalogRevision ?? snapshot.catalogRevision,
      initialized: result.snapshot.initialized,
      models: result.snapshot.models,
      error: null,
      loading: false
    });
    return { ok: true };
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    setEnabled: (modelKey, enabled) =>
      write((models) => models.map((model) => (model.modelKey === modelKey ? { ...model, enabled } : model))),
    setEnabledMany: (modelKeys, enabled) => {
      const keys = new Set(modelKeys);
      return write((models) => models.map((model) => {
        if (!keys.has(model.modelKey) || model.tombstone) return model;
        return enabled ? { ...model, enabled: true } : { ...model, enabled: false, isDefault: false };
      }));
    },
    setDefault: (modelKey, modelType) =>
      write((models) =>
        models.map((model) => ({ ...model, isDefault: model.modelType === modelType ? model.modelKey === modelKey : false }))
      ),
    start: () => {
      if (disposed || timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), options.pollIntervalMs ?? 10_000);
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    dispose: () => {
      disposed = true;
      if (timer) clearInterval(timer);
      listeners.clear();
    }
  };
}
