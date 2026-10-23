
import { computeInputHash, reduceGameFurnace, type GameFurnaceOperation, type GameFurnaceState } from "../shared/index.js";
import { safeMessage } from "../shared/diagnostics.js";
import { projectKey, type Runtime } from "./runtime.js";
import { runSaveProject } from "./projects.js";

export async function applyOperations(
  rt: Runtime,
  canvasId: string,
  nodeId: string,
  operations: GameFurnaceOperation[]
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const key = projectKey(canvasId, nodeId);
  const project = rt.projects.get(key);
  if (!project) return { ok: false, code: "target-missing", message: "项目尚未打开或已删除" };
  let next: GameFurnaceState;
  try {
    next = reduceGameFurnace(project.state as never, operations as never) as unknown as GameFurnaceState;
  } catch (error) {
    return { ok: false, code: "content-conflict", message: safeMessage(error) };
  }
  if (!rt.services.media.resources) {
    // 无存储能力：仅在内存中前进（调用方随后应重新 saveProject）；不产生稳定关联。
    rt.projects.set(key, { ...project, state: next, inputHash: computeInputHash(next) });
    return { ok: true };
  }
  try {
    const saved = await runSaveProject(rt, { canvasId, nodeId, state: next });
    if (saved.ok !== true) return { ok: false, code: String(saved.code), message: String(saved.message) };
    return { ok: true };
  } catch (error) {
    return { ok: false, code: "storage-failed", message: safeMessage(error) };
  }
}
