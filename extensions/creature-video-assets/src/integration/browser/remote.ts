import type { ApplicationRemoteService } from "@woohaa3/frontend/extension-api";
import { EXTENSION_ID } from "../../state/shared/recipe.js";
import { WorkflowError, type WorkflowRun } from "../../state/shared/workflow.js";
export function workflowRemote(remote: ApplicationRemoteService) {
  return async (route: string, identity: { canvasId: string; nodeId: string; instanceId: string }, body: Record<string, unknown> = {}): Promise<WorkflowRun> => {
    const result = await remote.transport.request({ path: `/api/extensions/${EXTENSION_ID}/handlers/${route}`, method: "POST", body: { ...identity, ...body } });
    if (!result.ok) throw new WorkflowError(result.code, result.error);
    const data = result.data as { ok?: boolean; run?: WorkflowRun; message?: string; code?: string };
    if (!data.ok || data.run?.schemaVersion !== 1 || data.run.nodeId !== identity.nodeId || data.run.instanceId !== identity.instanceId) throw new WorkflowError(data.code ?? "invalid-response", data.message ?? "制作记录读取失败，请重试。");
    return data.run;
  };
}
