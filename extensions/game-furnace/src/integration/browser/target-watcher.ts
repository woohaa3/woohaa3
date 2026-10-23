/**
 * 游戏炼丹炉目标节点删除观察器（extension 自有）
 * （change: 2026-10-10-add-game-furnace-extension，任务 6.10 / design D9/D11）。
 *
 * 目标删除必须由 **Canvas scope** 观察，而不是聚焦工作区：聚焦工作区只在对应节点被双击进入时渲染，
 * 普通画布上删除一个**未被聚焦**的炼丹炉节点同样需要按权限取消/脱离其后端在途任务。本观察器
 * 订阅宿主注入的只读画布 facade，跨节点持续有效（随插件 owner 释放而停）。
 *
 * 语义（避免误报/漏报）：
 * - 只认「炼丹炉节点」：`extension3d` 类型且 nodeData 带本扩展 identity 或炉体几何脚本
 *   （与后端 MCP 的节点判定同源）；
 * - 追踪上次观察到的画布 id 与 node 集合：**首次观察**某画布只建立基线，不触发；画布 id 变化
 *   （切换画布）重置基线，不触发（切画布只释放前端，不取消 durable 任务）；临时 null 保留基线；
 * - 缺失节点进入 **待脱离集合**，成功后移除；请求失败保留在集合中（回报且不崩溃），下次观察重试；
 * - 节点重新出现会清除其待脱离项，因此「删除→撤销→再删除」仍能再次脱离；
 * - 同一 canvas+node 同一时刻只发一次请求（`inFlight` 去重）。
 *
 * 纯逻辑：不 import 宿主 store/DOM；画布与远端都由调用方注入。
 */
import type { CanvasStoreFacade } from "@woohaa3/frontend/extension-api";
import type { ServerCanvas } from "@woohaa3/contracts";
import { isGameFurnaceNodeData, GAME_FURNACE_NODE_TYPE } from "../../preview/shared/geometry.js";

/** 目标删除请求的稳定结果（失败携带 code 与安全消息）。 */
export type TargetDetachResult = { ok: true } | { ok: false; code: string; message: string };

export type TargetDetachRequest = { canvasId: string; nodeId: string };

export type TargetDetachWatcherDeps = {
  /** 宿主只读画布 facade（`getCanvas` 权威优先，缺省回退 working 投影）。 */
  canvasState: Pick<CanvasStoreFacade, "getCanvas" | "getWorkingCanvas" | "subscribe">;
  /** 发起受控 target-detach 请求（由调用方注入远端客户端）。 */
  detach: (input: TargetDetachRequest) => Promise<TargetDetachResult>;
  /** 请求失败回报（不抛）；成功静默。 */
  onFailure?: (input: TargetDetachRequest, failure: { code: string; message: string }) => void;
};

const KEY_SEP = "\u0000";

function keyOf(canvasId: string, nodeId: string): string {
  return `${canvasId}${KEY_SEP}${nodeId}`;
}

function splitKey(key: string): { canvasId: string; nodeId: string } {
  const at = key.indexOf(KEY_SEP);
  return { canvasId: key.slice(0, at), nodeId: key.slice(at + KEY_SEP.length) };
}

export { isGameFurnaceNodeData } from "../../preview/shared/geometry.js";

/** 当前画布上的炼丹炉节点 id 集合（纯读取；缺失/非法时为空）。 */
export function gameFurnaceNodeIds(canvas: ServerCanvas | null | undefined): string[] {
  if (!canvas) return [];
  return canvas.document.nodes
    .filter((node) => node.type === GAME_FURNACE_NODE_TYPE && isGameFurnaceNodeData(canvas.nodeData[node.id]))
    .map((node) => node.id);
}

/**
 * 启动目标删除观察器；返回幂等 disposer（停止订阅，不再发请求）。
 */
export function startTargetDetachWatcher(deps: TargetDetachWatcherDeps): () => void {
  let observedCanvasId: string | null = null;
  let priorNodeIds = new Set<string>();
  /** 已观察到消失、尚未成功脱离的 canvas+node（失败保留以便重试）。 */
  const pending = new Set<string>();
  /** 正在请求中的 canvas+node（去重）。 */
  const inFlight = new Set<string>();

  const attempt = (canvasId: string, nodeId: string, key: string): void => {
    if (inFlight.has(key)) return;
    inFlight.add(key);
    const input: TargetDetachRequest = { canvasId, nodeId };
    void deps.detach(input)
      .then((result) => {
        inFlight.delete(key);
        if (result.ok === true) pending.delete(key);
        else deps.onFailure?.(input, { code: result.code, message: result.message });
      })
      .catch((error: unknown) => {
        inFlight.delete(key);
        deps.onFailure?.(input, { code: "unavailable", message: error instanceof Error ? error.message : String(error) });
      });
  };

  const evaluate = (): void => {
    const canvas = deps.canvasState.getCanvas() ?? deps.canvasState.getWorkingCanvas();
    // 临时 null：保留基线，不把“全部消失”误判为删除。
    if (canvas) {
      const currentIds = new Set(gameFurnaceNodeIds(canvas));
      if (observedCanvasId === canvas.id) {
        for (const nodeId of priorNodeIds) {
          if (!currentIds.has(nodeId)) pending.add(keyOf(canvas.id, nodeId));
        }
      }
      // 节点重新出现：清除其待脱离项（允许后续再删除时重新脱离）。
      for (const nodeId of currentIds) pending.delete(keyOf(canvas.id, nodeId));
      observedCanvasId = canvas.id;
      priorNodeIds = currentIds;
    }
    // 处理全部待脱离（含失败重试；幂等）。
    for (const key of [...pending]) {
      const { canvasId, nodeId } = splitKey(key);
      attempt(canvasId, nodeId, key);
    }
  };

  const unsubscribe = deps.canvasState.subscribe(evaluate);
  evaluate();
  return unsubscribe;
}
