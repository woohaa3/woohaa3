/**
 * 游戏炼丹炉复制拖入收集（extension 侧）
 * （change: 2026-10-10-add-game-furnace-extension，任务 4.3/4.4；按 integration 新架构重实现）。
 *
 * 向宿主通用 `canvas.node-drop` slot 贡献复合资产 `composite-asset` 接收方：拖动一批来源节点落在炼丹炉
 * 节点范围内并释放时，本扩展用**自有**纯规划器（`planGameFurnaceDrop`）把来源展开为一批
 * `resources.add` 操作，交给本扩展后端 handler（`project-collect`）在权威边界重验并写入新的
 * 不可变 envelope；随后用通用 `canvasCommands` 把返回的稳定 `storageKey`/`inputHash` 关联写回
 * 节点。来源节点从不进入命令；释放一旦命中即被消费（来源回位，不提交移动，任务 4.5）。
 *
 * `onDrop` 必须**同步**返回是否消费；真实收集是后端往返，因此在返回 `true` 后异步进行，
 * 结果经 live region 反馈（成功/失败都说明，不静默）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CanvasStoreFacade, CanvasCommandsService, CanvasEditService, ApplicationRemoteService, SlotsService } from "@woohaa3/frontend/extension-api";
import { createHighEntropyId, type ServerCanvas } from "@woohaa3/contracts";
import { isGameFurnaceNodeData, GAME_FURNACE_NODE_TYPE } from "../../preview/shared/geometry.js";
import { GAME_FURNACE_PLUGIN_ID } from "../../state/shared/index.js";
import { planGameFurnaceDrop } from "../../authoring/browser/collection.js";
import { createGameFurnaceRemote, remoteFailureMessage } from "./remote.js";
import { isGameFurnaceNode } from "../../state/browser/associations.js";
import { reportGameFurnace } from "../../authoring/browser/feedback.js";

/** drop contribution 稳定 ID。 */
export const GAME_FURNACE_NODE_DROP_ID = "game-furnace-node-drop";

type DropContext = Context & {
  slots: SlotsService;
  canvasState: CanvasStoreFacade;
  canvasCommands: CanvasCommandsService;
  canvasEdit: CanvasEditService;
  applicationRemote: ApplicationRemoteService;
};

/**
 * 注册炼丹炉节点复制接收方；返回 disposer。
 *
 * 只处理 `extension3d` 目标（由宿主按通用 nodeType 命中）；命中即消费，异步收集。
 */
export function extendGameFurnaceDrop(ctx: DropContext): () => void {
  const remote = createGameFurnaceRemote({ transport: ctx.applicationRemote.transport });

  const matches = ({ canvas, targetNodeId }: { canvas: ServerCanvas; targetNodeId: string }) =>
    canvas.document.nodes.some((node) => node.id === targetNodeId && node.type === GAME_FURNACE_NODE_TYPE
      && isGameFurnaceNodeData(canvas.nodeData[node.id]));

  const nodeDataOf = (canvas: ServerCanvas, nodeId: string) => canvas.nodeData[nodeId];

  // scope 生命周期门禁：dispose 后任何晚到回执都不得再写回（任务 5.5/10.11）。
  let disposed = false;

  /**
   * 目标生命周期/session fence（change: 2026-10-11-extract-film-set-extension，任务 5.5/10.7/10.11）。
   *
   * 字段相等**不能**证明目标生命周期连续：删除后同 ID/同 bytes 重建、切画布再切回都会得到
   * 逐字段相同的节点数据（也是 structuredClone，不能用引用相等判定）。因此用公开
   * `canvasState.subscribe` 观察到的**目标作用域**实际状态转移派生单调 epoch：fence 键为
   * `canvasId:nodeId`，某键从「不在场」变为「在场」即推进该目标自身的 epoch。这样：
   *   - 无关目标（同画布另一个独立炉体）出现/消失不影响本目标；
   *   - 目标画布切换再切回、目标删除后同 ID 重建都会使目标键重新出现，从而推进 epoch。
   * 捕获时记录该目标 epoch，回执写回前必须仍等于捕获值，否则拒绝。无生命的字段改写不改变 fence。
   */
  const targetEpoch = new Map<string, number>();
  let presentFurnaceKeys = new Set<string>();
  const targetFenceKey = (canvasId: string, nodeId: string): string => `${canvasId}:${nodeId}`;
  const refreshFence = (): void => {
    const canvas = ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
    const next = new Set<string>();
    if (canvas) {
      for (const node of canvas.document.nodes) {
        if (isGameFurnaceNode(canvas, node.id)) next.add(targetFenceKey(canvas.id, node.id));
      }
    }
    for (const key of next) {
      if (!presentFurnaceKeys.has(key)) targetEpoch.set(key, (targetEpoch.get(key) ?? 0) + 1);
    }
    presentFurnaceKeys = next;
  };
  refreshFence();
  const unsubscribeFence = typeof ctx.canvasState.subscribe === "function" ? ctx.canvasState.subscribe(refreshFence) : () => {};
  const epochOf = (canvasId: string, nodeId: string): number => targetEpoch.get(targetFenceKey(canvasId, nodeId)) ?? 0;

  /**
   * 同一目标上的并发 collect 关联 fence：每次 drop 开始时按 (canvasId, nodeId) 推进单调序号，
   * 回执只在自身序号仍为最新时才能提交关联。可在任意到达顺序下保证较旧回执不会覆盖较新意图，
   * 也不依赖 `submit.ok` 当作 committed（任务 10.7/10.11）。
   */
  let collectSeq = 0;
  const latestCollectSeq = new Map<string, number>();

  /**
   * 捕获本次 drop 的完整身份：画布、目标节点、来源业务定义、项目关联快照。
   *
   * 异步往返期间可能与新项目关联并发（projectStorageKey/inputHash 已更换）或节点定义被改写；
   * 写回前必须与捕获身份逐字段一致，否则拒绝（任务 10.7/10.11）。
   */
  const captureIdentity = (canvas: ServerCanvas, nodeId: string): string => {
    const data = (canvas.nodeData[nodeId] ?? {}) as Record<string, unknown>;
    return JSON.stringify({
      extensionId: data.extensionId ?? null,
      modelScript: data.modelScript ?? null,
      modelScriptLanguage: data.modelScriptLanguage ?? null,
      modelScriptVersion: data.modelScriptVersion ?? null,
      modelContentVersion: data.modelContentVersion ?? null,
      modelPlacement: data.modelPlacement ?? null, scenePlacement: data.scenePlacement ?? null,
      projectStorageKey: data.projectStorageKey ?? null,
      inputHash: data.inputHash ?? null,
      activeBuildId: data.activeBuildId ?? null
    });
  };

  const runCollect = async (canvas: ServerCanvas, targetNodeId: string, sourceNodeIds: readonly string[]): Promise<void> => {
    const capturedCanvasId = canvas.id;
    const capturedIdentity = captureIdentity(canvas, targetNodeId);
    const capturedEpoch = epochOf(capturedCanvasId, targetNodeId);
    const fenceKey = `${capturedCanvasId}:${targetNodeId}`;
    const seq = collectSeq += 1;
    latestCollectSeq.set(fenceKey, seq);
    const collectionId = createHighEntropyId("collect");
    const plan = planGameFurnaceDrop(canvas, sourceNodeIds, collectionId);
    if (!plan) {
      reportGameFurnace("没有可收集的素材（来源未就绪或类型不支持）");
      return;
    }
    const result = await remote.collectResources({
      canvasId: canvas.id,
      nodeId: targetNodeId,
      operations: plan.operations,
      collectionId,
      ...(typeof canvas.nodeData[targetNodeId]?.projectStorageKey === "string"
        ? { expectedProjectStorageKey: canvas.nodeData[targetNodeId].projectStorageKey as string } : {}),
      sourceSnapshots: plan.sourceSnapshots
    });
    if (disposed) return;
    if (!result.ok) {
      reportGameFurnace(`收集失败：${remoteFailureMessage(result)}`);
      return;
    }
    // 关联写回前重新确认原会话生命周期连续：仍指向原画布，目标节点仍存在、仍是炼丹炉节点，业务
    // 定义与项目关联未在异步期间变化，且目标生命周期 epoch 与本次 drop 捕获时相同。切画布（可能含
    // 同名 nodeId）、目标被删除/重建（同 ID/同 bytes）、改成别的业务、关联或定义被并发改写时，
    // MUST NOT patch 或复活。字段相等不代表生命周期连续，故还必须 epoch 相等。
    refreshFence();
    const current = ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
    if (!current || current.id !== capturedCanvasId) {
      reportGameFurnace("收集已保存，但画布已切换，关联未写回（可重新拖入恢复）");
      return;
    }
    const target = current.document.nodes.find((node) => node.id === targetNodeId);
    if (!target || !isGameFurnaceNode(current, targetNodeId)) {
      reportGameFurnace("收集已保存，但目标炼丹炉节点已失效，关联未写回");
      return;
    }
    if (epochOf(capturedCanvasId, targetNodeId) !== capturedEpoch) {
      reportGameFurnace("收集已保存，但目标生命周期已改变，关联未写回（可重新拖入恢复）");
      return;
    }
    if (captureIdentity(current, targetNodeId) !== capturedIdentity) {
      reportGameFurnace("收集已保存，但目标定义或项目关联已更新，关联未写回（可重新拖入恢复）");
      return;
    }
    // 并发关联 fence：只有当自身仍是该目标最新的 collect 时才提交，避免较旧回执覆盖新意图
    // （任意到达顺序）。`submit.ok` 只表示命令已被受理，不等于 committed；本扩展不依赖它。
    if (latestCollectSeq.get(fenceKey) !== seq) {
      reportGameFurnace("收集已保存，但已有更新的收集意图，关联未写回");
      return;
    }
    // 关联写回：保留既有通用字段（如 modelScript），只覆盖稳定关联。
    if (!ctx.canvasCommands.isWritable()) return;
    const existing = nodeDataOf(current, targetNodeId);
    const value = {
      ...((existing ?? {}) as Record<string, unknown>),
      projectStorageKey: result.value.projectStorageKey,
      inputHash: result.value.inputHash
    };
    if (disposed) return;
    if (latestCollectSeq.get(fenceKey) !== seq) {
      reportGameFurnace("收集已保存，但已有更新的收集意图，关联未写回");
      return;
    }
    const command = await ctx.canvasEdit.record(
      [{ type: "nodeData.patch", nodeId: targetNodeId, value: value as never }],
      plan.label
    );
    if (!command.ok) {
      reportGameFurnace(`收集已保存，但关联未写回：${command.reason}`);
      return;
    }
    // 关联命令**已受理**不等于 canonical committed（平台 CommandHandle 语义）：必须等待正式
    // handle.settled 并核验 state，成功才提示「已收集」；否则报可恢复的 saved-but-unlinked，
    // 不把跨库两阶段伪装成一次成功（任务 10.7）。settled 阶段同样绑定捕获的 session（画布 +
    // 目标 epoch），但**不**比较 project identity（正常 commit 会改变它），也不撤回已合法提交的
    // 旧画布命令，只是不在新 scope 上显示成功反馈。
    const collected = plan.operations[0] && Array.isArray((plan.operations[0] as { resources?: unknown[] }).resources)
      ? (plan.operations[0] as { resources: unknown[] }).resources.length
      : 0;
    void settleAssociation({ settled: Promise.resolve({ state: "committed", error: null }) }, collected, capturedCanvasId, targetNodeId, capturedEpoch, fenceKey, seq);
  };

  /** 捕获的 session 是否仍连续：同一画布、同一目标 epoch（不比较会随 commit 变化的 project identity）。 */
  const sessionAlive = (canvasId: string, nodeId: string, epoch: number): boolean => {
    const canvas = ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
    return Boolean(canvas && canvas.id === canvasId && epochOf(canvasId, nodeId) === epoch);
  };

  const settleAssociation = async (
    handle: { settled: Promise<{ state: string; error: string | null }> },
    collected: number,
    capturedCanvasId: string,
    targetNodeId: string,
    capturedEpoch: number,
    fenceKey: string,
    seq: number
  ): Promise<void> => {
    let settled: { state: string; error: string | null } | null = null;
    try {
      settled = await handle.settled;
    } catch {
      settled = null;
    }
    if (disposed || latestCollectSeq.get(fenceKey) !== seq) return;
    if (!sessionAlive(capturedCanvasId, targetNodeId, capturedEpoch)) return;
    if (settled && settled.state === "committed" && !settled.error) {
      reportGameFurnace(`已收集 ${collected} 项素材`);
      return;
    }
    reportGameFurnace("收集已保存，但关联未写回（可重新拖入恢复）");
  };

  const disposer = ctx.slots.register("canvas.node-drop", {
    id: GAME_FURNACE_NODE_DROP_ID,
    dropLabel: "放到此处加入游戏炼丹炉",
    owner: GAME_FURNACE_PLUGIN_ID,
    nodeType: GAME_FURNACE_NODE_TYPE,
    matchesTarget: matches,
    onDrop: ({ canvas, targetNodeId, sourceNodeIds }) => {
      if (disposed || !ctx.canvasCommands.isWritable() || !matches({ canvas, targetNodeId })) return false;
      // 首次拖入即自动初始化项目（后端以确定性 projectId 建新项目），无需先读关联。
      void runCollect(canvas, targetNodeId, sourceNodeIds);
      // 命中即消费：来源节点回位、不提交移动（与片场一致，任务 4.5）。
      return true;
    },
    onPreview: ({ canvas, targetNodeId, sourceNodeIds }) => {
      if (!matches({ canvas, targetNodeId })) return null;
      const plan = planGameFurnaceDrop(canvas, sourceNodeIds);
      return plan ? null : "该来源无法收集为素材";
    }
  });
  return () => {
    disposed = true;
    unsubscribeFence();
    disposer();
  };
}
