import { computeInputHash, validateGameFurnaceState, GAME_FURNACE_SCHEMA_VERSION, type GameFurnaceState } from "../shared/index.js";
import { persistResourceOriginals } from "./source-assets.js";
import { forkProjectForTarget } from "./fork-project.js";
import { createHash } from "node:crypto";
import { projectKey, type Runtime } from "./runtime.js";
import { safeMessage } from "../shared/diagnostics.js";

export function readEnvelopeVersion(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const version = (value as Record<string, unknown>).schemaVersion;
  return typeof version === "number" && Number.isFinite(version) ? version : null;
}

/** 未知版本的安全结果：内容寻址对象保持不变，扩展不解释、不覆盖、不删除。 */
function unsupportedVersion(version: number): { ok: false; code: string; message: string; preserved: true; version: number } {
  return { ok: false, code: "unsupported-version", message: `项目版本 ${version} 暂不受支持；原文已原样保留`, preserved: true, version };
}

export async function runSaveProject(
  rt: Runtime,
  input: { canvasId: string; nodeId: string; state: GameFurnaceState }
): Promise<Record<string, unknown>> {
  if (!rt.services.media.resources) return { ok: false, code: "unavailable", message: "缺少媒体存储能力" };
  // 未知版本：拒绝以当前 schema 覆盖写入（不静默降级未来版本内容）。
  const version = readEnvelopeVersion(input.state);
  if (version !== null && version !== GAME_FURNACE_SCHEMA_VERSION) return unsupportedVersion(version);
  try { validateGameFurnaceState(input.state); }
  catch { return { ok: false, code: "malformed-request", message: "项目状态非法或版本不受支持" }; }
  let state: GameFurnaceState;
  let projectStorageKey: string;
  try {
    // 导入/显式保存也必须遵守复制隔离，不能靠覆盖 owner 掩盖原 Task 身份。
    const seed = createHash("sha256").update(JSON.stringify(input.state)).digest("hex");
    const copied = await forkProjectForTarget(rt, { canvasId: input.canvasId, nodeId: input.nodeId, projectStorageKey: `sha256-${seed}` }, input.state);
    state = await persistResourceOriginals(rt, { ...copied.state, projectOwner: { canvasId: input.canvasId, nodeId: input.nodeId } });
    projectStorageKey = copied.state !== input.state && state.resources === copied.state.resources ? copied.projectStorageKey
      : (await rt.services.media.resources.write({ bytes: new TextEncoder().encode(JSON.stringify(state)), contentType: "application/json" })).storageKey;
  } catch (error) {
    return { ok: false, code: "storage-failed", message: safeMessage(error) };
  }
  const inputHash = computeInputHash(state);
  rt.projects.set(projectKey(input.canvasId, input.nodeId), { projectStorageKey, state, inputHash, canvasId: input.canvasId, nodeId: input.nodeId });
  return { ok: true, projectStorageKey, inputHash, state };
}

export async function runOpenProject(
  rt: Runtime,
  input: { canvasId: string; nodeId: string; projectStorageKey: string }
): Promise<Record<string, unknown>> {
  if (!rt.services.media.resources) return { ok: false, code: "unavailable", message: "缺少媒体读取能力" };
  const key = projectKey(input.canvasId, input.nodeId);
  const cached = rt.projects.get(key);
  if (cached && cached.projectStorageKey === input.projectStorageKey) {
    return { ok: true, projectStorageKey: input.projectStorageKey, inputHash: cached.inputHash, state: cached.state };
  }
  try {
    const value = await rt.services.media.resources.read(input.projectStorageKey);
    const raw = JSON.parse(new TextDecoder().decode(value.bytes)) as unknown;
    // 未知更高版本：不按 v1 解释，原文原样保留（不缓存、不改写）。
    const version = readEnvelopeVersion(raw);
    if (version !== null && version !== GAME_FURNACE_SCHEMA_VERSION) return unsupportedVersion(version);
    validateGameFurnaceState(raw as GameFurnaceState);
    const { state, projectStorageKey } = await forkProjectForTarget(rt, input, raw as GameFurnaceState);
    rt.projects.set(key, { projectStorageKey, state, inputHash: computeInputHash(state), canvasId: input.canvasId, nodeId: input.nodeId });
    return { ok: true, projectStorageKey, inputHash: computeInputHash(state), state };
  } catch (error) {
    return { ok: false, code: "target-missing", message: safeMessage(error) };
  }
}
