import { STAGES } from "../../state/shared/recipe.js";
import { createRun, type Status, type WorkflowRun } from "../../state/shared/workflow.js";
import type { StageId } from "../../state/shared/creature/ids.js";
/** 仅展示交互状态，不产生任务、批准或可复用的制作证据。 */
export function previewRun(source: WorkflowRun, stageId: StageId, status: Status): WorkflowRun {
  const run = createRun(source.canvasId, source.nodeId, source.instanceId);
  run.activeStage = stageId; run.updatedAt = source.updatedAt;
  const index = STAGES.findIndex(stage => stage.id === stageId);
  STAGES.slice(0, index + 1).forEach((definition, position) => {
    const state = run.stages[definition.id]; state.status = position < index ? "approved" : status;
    state.input.prompt = definition.id === "01_brief" ? "苔原巡游者：厚毛、四足，适合俯视角游戏。" : "";
    if (position < index || ["review", "approved", "stale"].includes(status)) {
      const real = source.stages[definition.id].artifacts;
      state.artifacts = real.length ? structuredClone(real) : [{ id: `preview-${definition.id}`, title: `${definition.output} · 交互示意`, kind: definition.kind, text: definition.kind === "text" ? JSON.stringify({ preview: true, output: definition.output, review: definition.review }, null, 2) : "交互预览未执行媒体制作。" }];
      state.checks = { hardPassed: true, agent: "pass", notes: ["调试状态，仅用于查看交互，不作为真实制作证据。"] };
    }
    if (status === "failed" && position === index) state.error = "示意：本轮任务失败，已有产物已保留。";
  });
  return run;
}
