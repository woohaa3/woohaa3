/**
 * 复合内容扩展的**聚合运行时**端口
 * （change: 2026-10-17-decouple-film-set-from-canvas-service）。
 *
 * 宿主（canvas-service）只依赖这里的接口；具体内容领域由扩展实现并通过
 * `extension.json` 的 `canvasContent` 声明装配。内容贡献、受管生命周期与迁移适配器全部可选；
 * 未提供时对应能力在宿主侧明确不可用，不会静默退化或由宿主私自实现。
 */

export type CanvasContentRuntime = {
  /** 这个运行时读取稳定媒体时声明的扩展作用域。宿主不猜测身份。 */
  mediaExtensionId?: string;
  /** Trusted content owners, aggregated before authoritative command paths open. */
  contributions?: readonly import("./content-contribution.js").ContentContribution[];
  managedLifecycles?: readonly import("./managed-node-lifecycle.js").ManagedNodeLifecycleAdapter[];
  managedMigrations?: readonly import("./managed-node-lifecycle.js").ManagedNodeMigrationAdapter[];
};
