import { decodeImageDirectorSceneCandidate, PREFERRED_MODEL_SCRIPT_VERSION, v2SceneAabb, type GroundAabb, type ImageDirectorSceneCandidate } from "@woohaa3/contracts";
import { executeSceneIr } from "../model-mcp/script-executor.js";
import { instanceFootprint } from "./authority.js";

export type PreparedImageDirectorCandidate = {
  candidate: ImageDirectorSceneCandidate;
  footprints: GroundAabb[];
};

export async function prepareImageDirectorCandidate(input: unknown, aspect: { width: number; height: number }, signal?: AbortSignal): Promise<{ ok: true; value: PreparedImageDirectorCandidate } | { ok: false; diagnostic: string }> {
  const decoded = decodeImageDirectorSceneCandidate(input, aspect);
  if (!decoded.ok) return decoded;
  const footprints: GroundAabb[] = [];
  for (const model of decoded.value.models) {
    if (signal?.aborted) return { ok: false, diagnostic: "Cancelled" };
    let result: Awaited<ReturnType<typeof executeSceneIr>>;
    try { result = await executeSceneIr(model.script, PREFERRED_MODEL_SCRIPT_VERSION, { signal }); }
    catch (error) { return { ok: false, diagnostic: `${model.key}: ${error instanceof Error ? error.message : "script execution failed"}` }; }
    if (!result.ok) return { ok: false, diagnostic: `${model.key}: ${result.message}` };
    if (result.ops.some(op => op.t === "oscillate" || op.t === "move" || op.t === "rotate")) return { ok: false, diagnostic: `${model.key}: animation is not supported` };
    const bounds = v2SceneAabb(result.ops);
    if (!bounds) return { ok: false, diagnostic: `${model.key}: no valid geometry` };
    const footprint = instanceFootprint(bounds, model.transform);
    if (![footprint.min.u, footprint.min.v, footprint.max.u, footprint.max.v].every(Number.isFinite)) return { ok: false, diagnostic: `${model.key}: invalid footprint` };
    footprints.push(footprint);
  }
  return { ok: true, value: { candidate: decoded.value, footprints } };
}
