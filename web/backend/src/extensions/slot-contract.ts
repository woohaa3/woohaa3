/**
 * 槽位实现的本地结构化类型
 * （change: 2026-10-15-scan-bootstrap-slots-as-extension-directories，任务 3.3 / design D3）。
 *
 * 槽位实现由扩展目录在**启动期扫描**得到，本机后端因此不对任何实现包形成依赖（运行期或编译期）：
 * 这里按后端真正用到的字段声明结构化类型 —— 只有 `canvas` 单元需要绑定到画布服务的具体类型，
 * 其余字段仍由 `@woohaa3/contracts` 的 Storage 契约约束。
 */
import type { StorageProvider } from "@woohaa3/contracts";
import type { CanvasStorageUnit } from "@woohaa3/canvas-service";

/** storage 槽位实现：契约的 `StorageProvider` 绑定画布存储单元。 */
export type RuntimeStorageProvider = StorageProvider<CanvasStorageUnit>;

/** 已发布画布摘要 facade：后端实现，交给访问槽位扩展的目录入口使用。 */
export type CanvasDirectoryFacade = {
  listSummaries(canvasIds: readonly string[]): Promise<
    Array<{ canvasId: string; title: string; revision: number; updatedAt: string; nodeCount: number }>
  >;
};

/**
 * 借用 bootstrap 资源：方法保持 `this`，但 `close` 变为空操作。
 *
 * 槽位实现持有连接，生命周期归宿主（`bootstrapProviders` 的 `close`）；画布领域服务只借用句柄，
 * 它的 `close()` 不得把宿主还要用的连接关掉。
 */
export function borrow<T extends object>(resource: T): T {
  return new Proxy(resource, {
    get(target, key) {
      if (key === "close") return () => undefined;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

/**
 * 把 storage 槽位的画布单元翻译成 Canvas Service 的装配选项。
 *
 * 连接仍由槽位（宿主）持有，这里只借句柄；`storageConfig` 一并透传，使核心服务与槽位看到
 * 同一份配置（不再各自读环境变量）。
 */
export function canvasStorageOptions(storage: RuntimeStorageProvider): {
  repository: CanvasStorageUnit["repository"];
  yjsRepository: CanvasStorageUnit["yjsRepository"];
  writerLock: CanvasStorageUnit["writerLock"];
  storageConfig?: CanvasStorageUnit["storageConfig"];
  nodeHistoryRepository?: CanvasStorageUnit["nodeHistoryRepository"];
  editCompletionRepository?: CanvasStorageUnit["editCompletionRepository"];
  snippetRepository?: CanvasStorageUnit["snippetRepository"];
} {
  const unit = storage.canvas;
  return {
    repository: borrow(unit.repository),
    yjsRepository: borrow(unit.yjsRepository),
    writerLock: unit.writerLock,
    // 存储实现解析出的配置（含部署侧扩展配置文件的值）：画布服务据此组合，不再只认环境变量。
    ...(unit.storageConfig ? { storageConfig: unit.storageConfig } : {}),
    ...(unit.nodeHistoryRepository ? { nodeHistoryRepository: borrow(unit.nodeHistoryRepository) } : {}),
    ...(unit.editCompletionRepository ? { editCompletionRepository: borrow(unit.editCompletionRepository) } : {}),
    ...(unit.snippetRepository ? { snippetRepository: borrow(unit.snippetRepository) } : {})
  };
}
