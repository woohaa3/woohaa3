/**
 * 画布节点复制拖入的共享分派点
 * （change: 2026-10-08-make-film-set-model-only，任务 2.3/3.3 / design D4；
 *  change: 2026-10-10-add-game-furnace-extension：改为**多 handler** 分派，使扩展节点接收方
 *  与片场接收方共用同一 pointer 生命周期裁决点，无需第二个 DOM 监听或第二份指针状态）。
 *
 * 一个 pointer 生命周期内由拖动族委托调用，控制器不自建 DOM 监听。
 * 多个接收方按注册顺序裁决：任一 handler 返回 `true` 表示已消费本次释放
 * （源节点不得提交移动）。全部返回 `false` 时回退普通移动/连线。
 */
type Drag = { sourceNodeIds: readonly string[]; point: { x: number; y: number } };
type Handler = { preview(drag: Drag | null): void; drop(drag: Drag): boolean };

const handlers = new Set<Handler>();

export const nodeDrop = {
  bind(next: Handler) {
    handlers.add(next);
    return () => {
      if (handlers.delete(next)) next.preview(null);
    };
  },
  preview(sourceNodeIds: readonly string[], point: { x: number; y: number } | null) {
    for (const handler of handlers) handler.preview(point ? { sourceNodeIds, point } : null);
  },
  drop(sourceNodeIds: readonly string[], point: { x: number; y: number } | null): boolean {
    if (!point) return false;
    const drag: Drag = { sourceNodeIds, point };
    for (const handler of handlers) {
      if (handler.drop(drag)) return true;
    }
    return false;
  },
  clear() {
    for (const handler of handlers) handler.preview(null);
  }
};
