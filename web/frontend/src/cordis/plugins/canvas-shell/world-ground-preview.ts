/**
 * 共享世界模型的瞬时地面位移状态（从 `interaction-controller` 拆出，保持文件体积守卫）。
 *
 * 只服务 Render Scene 的 `worldGroundPreviews`：不移动卡片、不发命令；模型被外部改写、
 * 页面失焦或聚焦切换时自动丢弃未提交位移。
 */
import type { ServerCanvas } from "@woohaa3/contracts";

type Ground = { u: number; v: number };

export type WorldGroundPreviewState = {
  /** 当前有效位移（节点 id → 米制增量）；供场景构建直接读取。 */
  values(): ReadonlyMap<string, Ground>;
  /** 写入/清除单个世界实例的位移（米制增量）。 */
  set(nodeId: string, delta: Ground | null): boolean;
  /** 开始一次地面拖动；实例缺失/地面不可用时返回 false。 */
  begin(nodeId: string, point: { x: number; y: number }): boolean;
  /** 指针移动：更新位移；实例被改写或指针离开地面时清除并返回 false。 */
  update(point: { x: number; y: number }): boolean;
  /** 取消当前拖动（不提交）。 */
  cancel(): void;
  /** 清除全部位移与拖动状态。 */
  clear(): void;
  /** 帧前同步：聚焦/过渡/外部改写时丢弃未提交位移。 */
  sync(): void;
};

export function createWorldGroundPreviewState(input: {
  getCanvas: () => ServerCanvas | null | undefined;
  groundAt: (point: { x: number; y: number }) => Ground | null;
  available: () => boolean;
  schedule: (reason?: string) => void;
}): WorldGroundPreviewState {
  const previews = new Map<string, Ground>();
  let drag: { nodeId: string; source: string; start: Ground } | null = null;

  const reset = () => {
    previews.clear();
    drag = null;
  };

  const set = (nodeId: string, delta: Ground | null): boolean => {
    if (delta) {
      if (!input.available()) return false;
      if (!Number.isFinite(delta.u) || !Number.isFinite(delta.v)) return false;
      if (!input.getCanvas()?.nodeData[nodeId]?.sharedWorldInstance) return false;
      previews.set(nodeId, { ...delta });
    } else {
      previews.delete(nodeId);
    }
    input.schedule("world-ground-preview");
    return true;
  };

  const begin = (nodeId: string, point: { x: number; y: number }): boolean => {
    const instance = input.getCanvas()?.nodeData[nodeId]?.sharedWorldInstance;
    const start = input.groundAt(point);
    if (!instance || !start) return false;
    previews.clear();
    drag = { nodeId, source: JSON.stringify(instance), start };
    return true;
  };

  const update = (point: { x: number; y: number }): boolean => {
    if (!drag) return false;
    const instance = input.getCanvas()?.nodeData[drag.nodeId]?.sharedWorldInstance;
    const ground = input.groundAt(point);
    if (!instance || JSON.stringify(instance) !== drag.source || !ground) {
      reset();
      input.schedule("world-ground-preview");
      return false;
    }
    previews.set(drag.nodeId, { u: ground.u - drag.start.u, v: ground.v - drag.start.v });
    input.schedule("world-ground-preview");
    return true;
  };

  const sync = (): void => {
    if (!input.available()) {
      reset();
      return;
    }
    if (drag) {
      const instance = input.getCanvas()?.nodeData[drag.nodeId]?.sharedWorldInstance;
      if (JSON.stringify(instance) !== drag.source) reset();
    }
  };

  return {
    values: () => previews,
    set,
    begin,
    update,
    cancel: () => {
      reset();
      input.schedule("world-ground-preview");
    },
    clear: reset,
    sync
  };
}
