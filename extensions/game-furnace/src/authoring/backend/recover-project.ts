import { projectKey, type Runtime } from "../../state/backend/runtime.js";
import { runOpenProject } from "../../state/backend/projects.js";
import type { GameFurnaceState } from "../../state/shared/index.js";

export async function recoverGameProject(rt: Runtime, input: { canvasId: string; nodeId: string; projectStorageKey: string }, sweep: () => Promise<unknown> | undefined) {
  const key = projectKey(input.canvasId, input.nodeId);
  const cached = rt.projects.get(key);
  let result = await runOpenProject(rt, input);
  if (result.ok !== true) return result;
  const openedState = result.state as GameFurnaceState | undefined;
  // Only known automatic-finalization predecessors are stale associations.
  // Other valid keys may be deliberate history/undo restores and must remain authoritative.
  if (cached?.recoveredFromStorageKeys?.includes(input.projectStorageKey) && openedState?.projectId === cached.state.projectId) {
    rt.projects.set(key, cached);
  }

  // 刷新恢复：先从 canonical 节点 key 读回 generation，再等 worker 重放已完成 Task 的收尾。
  // 返回 worker 写出的最新 envelope key，工作区会在权限允许且关联未并发变化时 CAS 回写节点。
  await sweep();
  const latest = rt.projects.get(key);
  if (!latest) return result;
  result = { ok: true, projectStorageKey: latest.projectStorageKey, inputHash: latest.inputHash, state: latest.state };
  return result;
}
