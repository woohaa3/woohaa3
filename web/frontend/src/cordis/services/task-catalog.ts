/**
 * Task Catalog Service（change: adopt-frontend-cordis-plugin-runtime；
 *   change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 3.2）。
 *
 * 把原来 `use-task-state.ts` 的模块级 Promise 缓存收拢为页面级 Service。目录在运行期可能
 * 因站点生成插件/模型策略变化而失效：调用方通过 `invalidate()` 触发重取；这里用**请求序号**
 * 保证较早响应不覆盖较新的目录（design D3）。
 */
import type { CanvasTaskCatalog } from "@woohaa3/contracts";
import type { CatalogState, TaskCatalogService, TaskRemoteService } from "../contracts.js";
import type { GenerationModelsStatusService } from "./generation-models-status.js";

export class TaskCatalogStore implements TaskCatalogService {
  private state: CatalogState = { status: "loading" };
  private promise: Promise<CanvasTaskCatalog> | null = null;
  private readonly listeners = new Set<() => void>();
  /** 请求序号：只有最新一次请求可以写入状态（旧响应保护）。 */
  private requestId = 0;
  private lastRevision = -1;

  constructor(private readonly remote: TaskRemoteService) {}

  getState = (): CatalogState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async load(force = false): Promise<void> {
    if (force) this.promise = null;
    const id = ++this.requestId;
    this.setState({ status: "loading" });
    try {
      const catalog = await this.ensure();
      if (id !== this.requestId) return; // 迟到响应：丢弃。
      // catalogRevision 单调：更旧的目录不覆盖更新的。
      const revision = catalog.catalogRevision ?? 0;
      if (revision < this.lastRevision) return;
      this.lastRevision = revision;
      this.setState({ status: "ready", catalog });
    } catch (error) {
      if (id !== this.requestId) return;
      this.setState({
        status: "error",
        error: error instanceof Error && error.message !== "" ? error.message : "目录请求失败"
      });
    }
  }

  /**
   * 目录失效（站点生成插件/模型策略变化）：清缓存并重取。
   * 与 `load(true)` 等价，但语义明确。
   */
  invalidate(): void {
    this.promise = null;
    void this.load(true);
  }

  dispose(): void {
    this.promise = null;
    this.listeners.clear();
  }

  private ensure(): Promise<CanvasTaskCatalog> {
    this.promise ??= this.remote.fetchCatalog();
    return this.promise;
  }

  private setState(state: CatalogState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

/**
 * 生成模型策略（启用集合/默认/标题）或任务目录修订变化后使任务目录失效。
 *
 * 目录 = Provider 注册表 ∩ 站点模型策略。设置里的模型开关只写策略（`/api/generation-models`），
 * 且设置已是画布内弹窗、关闭不再整页刷新；没有这条失效路径时，新启用的模型要手动刷新页面
 * 才会出现在节点的模型菜单里。
 *
 * 两个信号都跟踪（change: 2026-10-20-reserve-remote-generation-provider，任务 6.1）：
 * - `revision`：本地模型策略 revision，管理员启停/设默认时前进；
 * - `catalogRevision`：宿主任务目录修订，Provider 注册/可用性/模型描述变化时前进（远端 Provider
 *   新增模型不改本地策略，只有这个信号能让已打开的画布重取目录）。
 *
 * 任一信号前进即 invalidate；按 revision 单调触发，旧值不回退；首次拿到权威值只建立基线
 * （目录尚未加载，无需重取），与站点插件状态的失效路径一致。
 *
 * @returns 取消订阅。
 */
export function invalidateCatalogOnModelPolicyChange(
  catalog: Pick<TaskCatalogService, "invalidate">,
  models: Pick<GenerationModelsStatusService, "getSnapshot" | "subscribe">
): () => void {
  const baseline = models.getSnapshot();
  let policyRevision = baseline.revision;
  let catalogRevision = baseline.catalogRevision;
  return models.subscribe(() => {
    const snapshot = models.getSnapshot();
    let advanced = false;
    if (snapshot.revision > policyRevision) {
      // 首次拿到权威值（-1 → 真实值）只建立基线：目录尚未加载，无需重取。
      if (policyRevision >= 0) advanced = true;
      policyRevision = snapshot.revision;
    }
    if (snapshot.catalogRevision > catalogRevision) {
      if (catalogRevision >= 0) advanced = true;
      catalogRevision = snapshot.catalogRevision;
    }
    if (advanced) catalog.invalidate();
  });
}
