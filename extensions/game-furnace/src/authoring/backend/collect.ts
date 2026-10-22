import { computeInputHash, createGameFurnaceState, projectIdFor, reduceGameFurnace, type GameFurnaceState } from "../../state/shared/index.js";
import type { Woohaa3CanvasJsonObject } from "@woohaa3/contracts";
import { persistResourceOriginals } from "../../state/backend/source-assets.js";
import { projectKey, type Runtime } from "../../state/backend/runtime.js";
import { safeMessage } from "../../state/shared/diagnostics.js";

export async function runCollectResources(
  rt: Runtime,
  input: { canvasId: string; nodeId: string; operations: readonly Woohaa3CanvasJsonObject[]; expectedProjectStorageKey?: string }
): Promise<Record<string, unknown>> {
  if (!rt.services.media.resources) return { ok: false, code: "unavailable", message: "缺少媒体存储能力" };
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    return { ok: false, code: "malformed-request", message: "没有可收集的素材" };
  }
  const key = projectKey(input.canvasId, input.nodeId);
  const snapshot = rt.projects.get(key);
  // 任务 4.4：目标修订重验（乐观并发）。前端带上它已知的项目 storageKey；若服务端已前移到
  // 不同内容版本，则拒绝整批，避免把并发编辑覆盖进旧基线。
  if (input.expectedProjectStorageKey !== undefined && snapshot && snapshot.projectStorageKey !== input.expectedProjectStorageKey) {
    return { ok: false, code: "content-conflict", message: "项目已被其它操作更新，请刷新后重试" };
  }
  const current = snapshot?.state ?? (createGameFurnaceState(projectIdFor(input.canvasId, input.nodeId)) as unknown as GameFurnaceState);
  let next: GameFurnaceState;
  try {
    next = reduceGameFurnace(current as unknown as Woohaa3CanvasJsonObject, input.operations) as unknown as GameFurnaceState;
  } catch (error) {
    return { ok: false, code: "content-conflict", message: safeMessage(error) };
  }
  next.projectOwner = { canvasId: input.canvasId, nodeId: input.nodeId };
  let projectStorageKey: string;
  try {
    next = await persistResourceOriginals(rt, next);
    projectStorageKey = (await rt.services.media.resources.write({ bytes: new TextEncoder().encode(JSON.stringify(next)), contentType: "application/json" })).storageKey;
  } catch (error) {
    return { ok: false, code: "storage-failed", message: safeMessage(error) };
  }
  if (rt.projects.get(key) !== snapshot) return { ok: false, code: "content-conflict", message: "项目在素材保存期间已变化，请重新收集" };
  const inputHash = computeInputHash(next);
  rt.projects.set(key, { projectStorageKey, state: next, inputHash, canvasId: input.canvasId, nodeId: input.nodeId });
  return { ok: true, projectStorageKey, inputHash, resources: next.resources };
}
