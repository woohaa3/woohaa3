/**
 * 画布同类型节点合并的共享分派点
 * （change: 2026-10-27-merge-same-type-node-history，任务 2.2 / 2.3 / design D3）。
 *
 * 拖动族在 pointermove 热路径上算出唯一候选并调用 `preview`，释放时**先于** `nodeDrop.drop`
 * 调用 `drop` 裁决。`node-merge` 插件是唯一注册的 handler：它负责 DOM 高亮、确认框与远端
 * 写面调用，拖动族因此不需要 import 插件，也不自建 DOM 监听或第二份指针状态。
 *
 * 与 `node-drop` 的差别：合并只有一个候选与一个接收方，`drop` 命中即消费释放（源节点不提交
 * 位置命令），取消确认时源节点停在原位。
 */

/** 拖动期的合并候选（世界坐标中心与目标节点）。 */
export type NodeMergeDrag = {
  /** 触发合并的来源节点；v1 只接受单根节点拖动。 */
  sourceNodeIds: readonly string[];
  /** 唯一目标节点。 */
  targetNodeId: string;
  /** 拖动中心（绝对画布坐标）；用于诊断与文案，不重新判定目标。 */
  point: { x: number; y: number };
};

type Handler = {
  /** 候选变化（含 `null` 表示候选消失）；必须幂等。 */
  preview(drag: NodeMergeDrag | null): void;
  /** 释放裁决：返回 `true` 表示命中并消费释放。 */
  drop(drag: NodeMergeDrag): boolean;
};

const handlers = new Set<Handler>();

export const nodeMerge = {
  bind(next: Handler) {
    handlers.add(next);
    return () => {
      if (handlers.delete(next)) next.preview(null);
    };
  },
  preview(drag: NodeMergeDrag | null) {
    for (const handler of handlers) handler.preview(drag);
  },
  drop(drag: NodeMergeDrag): boolean {
    for (const handler of handlers) {
      if (handler.drop(drag)) return true;
    }
    return false;
  },
  clear() {
    for (const handler of handlers) handler.preview(null);
  }
};
