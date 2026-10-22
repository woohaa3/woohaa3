import { actionGraphSchema } from "./creature/action.js";
import { directionPlanSchema, masterOf } from "./creature/direction.js";
import type { WorkflowRun } from "./workflow.js";

/** 依据当前 clipGeneration 统计；不恢复已废弃的独立锚点制图。 */
export function productionPlan(run: WorkflowRun) {
  const direction = directionPlanSchema.safeParse(run.stages["03_direction_plan"].structured);
  const action = actionGraphSchema.safeParse(run.stages["04_action_design"].structured);
  if (!direction.success || !action.success) return null;
  const masters = direction.data.generationDirections;
  const clips = action.data.states.flatMap(state => masters.filter(id => state.directionCoverage.some(d=>masterOf(d,direction.data.policy)===id)).map(directionId => ({ directionId, actionId: state.stateId, durationSeconds: state.durationSeconds })));
  const connectors = action.data.transitions.filter(t=>t.authoredConnector === "stop_or_exit_clip").flatMap(t=>[...new Set(t.directions.map(d=>masterOf(d,direction.data.policy)))].map(directionId=>({directionId,actionId:t.toStateId,transitionId:t.transitionId})));
  const sharedImages = new Set(action.data.states.filter(state => state.clipGeneration.sharedStartImage && masters.some(id => state.directionCoverage.some(d => masterOf(d,direction.data.policy)===id))).map(state => state.clipGeneration.sharedStartImage!.anchorId)).size;
  return { identityImages: 1, masterImages: masters.length, sharedStartImages: sharedImages, videoTasks: clips.length + connectors.length, gpuTasks: (clips.length + connectors.length) * 2, clips, connectors };
}
