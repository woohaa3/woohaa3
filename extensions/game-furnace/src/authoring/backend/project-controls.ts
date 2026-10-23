import { projectKey, type Runtime } from "../../state/backend/runtime.js";
import { applyOperations } from "../../state/backend/operations.js";

export async function cancelGeneration(rt: Runtime, input: { canvasId: string; nodeId: string; generationId: string }) {
  const project = rt.projects.get(projectKey(input.canvasId, input.nodeId));
  const generation = project?.state.generations.find(candidate => candidate.generationId === input.generationId);
  if (!generation) return { ok: false, code: "target-missing", message: "生成记录不存在" };
  if (generation.candidateBuildId) return { ok: false, code: "already-finished", message: "该构建已经保存" };
  // 先保存取消意图，晚到的模型结果不能自动激活。
  const applied = await applyOperations(rt, input.canvasId, input.nodeId, [{ type: "generation.disposition", generationId: input.generationId, disposition: "cancelled" }]);
  if (!applied.ok) return applied;
  try { if (generation.origin !== "agent" && !generation.executionDetached) await rt.services.tasks.cancel(generation.workerTaskKey); }
  catch { rt.log({ event: "game-furnace-remote-cancel-unconfirmed", generationId: input.generationId }); }
  if (generation.workId) rt.settleWork?.(generation.workId, "cancelled");
  return { ok: true, state: "cancelled", message: "已取消本站等待；远端执行与费用可能继续" };
}

/**
 * 目标节点删除后的按权限取消/脱离（任务 6.10 / design D11 完成定义）。
 *
 * 删除炼丹炉节点触发对其**在途**任务的取消：普通模型生成以原 key 取消站点 Task 并结算工作
 * 准入；Agent 源码提交不对应站点 Task，仅脱离。随后删除本控制器内存项目快照——内容寻址
 * envelope 仍留在 Media，已完成构建的只读检索/预览不受影响，删除源节点也不破坏已关联项目。
 *
 * 晚到结果不能重建节点或误关联：detach 后内存项目缺失，`finalize`/`runFinalize` 以
 * `target-missing` 收敛，不会登记新 build。
 */
export async function detachNode(rt: Runtime, input: { canvasId: string; nodeId: string }): Promise<{ ok: true; detached: number }> {
  const key = projectKey(input.canvasId, input.nodeId);
  const project = rt.projects.get(key);
  let detached = 0;
  if (project) {
    for (const generation of project.state.generations) {
      if (generation.executionDetached) continue;
      if (generation.candidateBuildId) continue;
      if (generation.disposition === "cancelled" || generation.disposition === "failed" || generation.disposition === "discarded") continue;
      detached += 1;
      if (generation.origin !== "agent" && generation.workerTaskKey) {
        try { await rt.services.tasks.cancel(generation.workerTaskKey); }
        catch { rt.log({ event: "game-furnace-detach-cancel-unconfirmed", generationId: generation.generationId }); }
      }
      if (generation.workId) rt.settleWork?.(generation.workId, "cancelled");
    }
  }
  rt.projects.delete(key);
  rt.log({ event: "game-furnace-target-detached", canvasId: input.canvasId, nodeId: input.nodeId, detached });
  return { ok: true, detached };
}
