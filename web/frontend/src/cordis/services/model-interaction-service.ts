/**
 * Model Interaction Registry（canvas page scope Service）
 * （change: 2026-09-29-add-pluggable-model-interactions，任务 3.2 / design D3）。
 *
 * - 精确 `{id, version}` 解析，不隐式替代 generic；
 * - 同一 `{id, version}` 只能有一个 owner，重复注册抛错（由 Cordis activation 回滚）；
 * - 注册返回幂等 disposer；`list()` 只暴露 id/version/owner 诊断摘要；
 * - 离开 Canvas page 或 runtime dispose 后不保留 React component / closure / listener。
 *
 * Registry **不**在 import evaluation 注册 builtins；generic/Seedance 都由各自 Plugin activation
 * 调用 `register()`。
 */
import type {
  ModelInteractionDefinition,
  ModelInteractionDescriptor,
  ModelInteractionRegistry,
  ModelInteractionSummary
} from "../contract/model-interaction.js";

export class ModelInteractionService implements ModelInteractionRegistry {
  private readonly byKey = new Map<string, ModelInteractionDefinition>();
  private readonly listeners = new Set<() => void>();

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  register(definition: ModelInteractionDefinition): () => void {
    if (definition.id === "" || !Number.isInteger(definition.version) || definition.version < 1) {
      throw new Error("ModelInteraction definition 需要合法的 id 与正整数 version");
    }
    if (definition.owner === "") {
      throw new Error("ModelInteraction definition 需要非空 owner");
    }
    const key = keyOf(definition);
    const existing = this.byKey.get(key);
    if (existing) {
      throw new Error(
        `ModelInteraction ${definition.id}@${definition.version} 已被 owner ${existing.owner} 注册`
      );
    }
    const registered: ModelInteractionDefinition = { ...definition };
    this.byKey.set(key, registered);
    this.notify();
    let disposed = false;
    // 幂等 disposer：只删除自己那一次注册（同 key 已被重新注册时不动）。
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.byKey.get(key) === registered) {
        this.byKey.delete(key);
        this.notify();
      }
    };
  }

  resolve(descriptor: ModelInteractionDescriptor): ModelInteractionDefinition | null {
    return this.byKey.get(keyOf(descriptor)) ?? null;
  }

  list(): readonly ModelInteractionSummary[] {
    return [...this.byKey.values()]
      .sort((left, right) => {
        if (left.id !== right.id) return left.id < right.id ? -1 : 1;
        return left.version - right.version;
      })
      .map((definition) => ({ id: definition.id, version: definition.version, owner: definition.owner }));
  }

  /** 订阅注册/注销变化（change: 2026-10-04-...，任务 5.3）。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Runtime dispose：清空全部 registrations 与 listener，不遗留 component/closure。 */
  dispose(): void {
    this.byKey.clear();
    this.listeners.clear();
  }
}

function keyOf(descriptor: ModelInteractionDescriptor): string {
  return `${descriptor.id}@${descriptor.version}`;
}
