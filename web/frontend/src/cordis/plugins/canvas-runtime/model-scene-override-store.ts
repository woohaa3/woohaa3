/**
 * Canvas Runtime 的本地模型 Scene IR override 持有器
 * （change: refactor-frontend-file-size；从 `host.ts` 拆出以遵守文件体积守卫）。
 *
 * 只支持历史聚焦的本地模型版本覆盖；不写规范状态。
 */
export class ModelSceneOverrideStore {
  private readonly overrides = new Map<string, { version: string; ops: readonly unknown[] }>();

  set(nodeId: string, override: { version: string; ops: readonly unknown[] } | null): void {
    if (override) this.overrides.set(nodeId, override);
    else this.overrides.delete(nodeId);
  }

  get(nodeId: string): { version: string; ops: readonly unknown[] } | null {
    return this.overrides.get(nodeId) ?? null;
  }

  clear(): void {
    this.overrides.clear();
  }
}
