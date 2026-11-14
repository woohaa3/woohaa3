import type { ServerCanvas, WorldObjectIdentity } from "@woohaa3/contracts";
import { decodeWorldInstanceData, decodeWorldCamera } from "@woohaa3/contracts";
import { objectKey } from "./spatial-leases.js";
import { instanceContentVersion } from "./authority.js";

const WORLD_CONTENT_FIELDS = [
  "modelScript",
  "modelScriptLanguage",
  "modelScriptVersion",
  "modelSourceKind",
  "modelAssetId",
  "modelContentVersion",
  "modelRig"
] as const;

type WorldDataFingerprint = {
  nodeId: string;
  sharedWorldInstance: unknown;
  worldCamera: unknown;
  content: unknown[];
  assetContent: string | null;
};

/**
 * Compare only fields that can change an authority footprint/version.
 *
 * A full JSON.stringify(data) here used to serialize every model script on every ordinary
 * canvas command. Large scripted city models made an otherwise unrelated text/node delete
 * spend seconds in the room queue. The command transaction already supplies canonical
 * projections; comparing this small authority fingerprint preserves the lock decision while
 * avoiding the large opaque payload.
 */
function sameWorldFingerprint(left: WorldDataFingerprint, right: WorldDataFingerprint): boolean {
  if (left.nodeId !== right.nodeId || left.assetContent !== right.assetContent) return false;
  if (JSON.stringify(left.sharedWorldInstance) !== JSON.stringify(right.sharedWorldInstance)) return false;
  if (JSON.stringify(left.worldCamera) !== JSON.stringify(right.worldCamera)) return false;
  if (left.content.length !== right.content.length) return false;
  for (let index = 0; index < left.content.length; index += 1) {
    const before = left.content[index];
    const after = right.content[index];
    // modelScript is commonly megabytes long; equality avoids serializing it when unchanged.
    if (typeof before === "string" || typeof after === "string") {
      if (before !== after) return false;
    } else if (JSON.stringify(before) !== JSON.stringify(after)) {
      return false;
    }
  }
  return true;
}

/** Compare canonical node ownership and data, including content and world settings. */
export function affectedWorldObjects(before: ServerCanvas, after: ServerCanvas): WorldObjectIdentity[] {
  const collect = (canvas: ServerCanvas) => {
    const objects = new Map<string, { target: WorldObjectIdentity; values: WorldDataFingerprint[] }>();
    for (const [nodeId, data] of Object.entries(canvas.nodeData)) {
      const instance = decodeWorldInstanceData(data.sharedWorldInstance);
      const camera = decodeWorldCamera(data.worldCamera);
      const target: WorldObjectIdentity | null = instance.ok
        ? { kind: "instance", instanceId: instance.value.instanceId }
        : camera.ok ? { kind: "camera", cameraId: camera.value.cameraId } : null;
      if (target) {
        const key = objectKey(target);
        const entry = objects.get(key) ?? { target, values: [] };
        // Replacing a shared GLB asset changes every referencing instance even
        // when nodeData stays identical. Keep those writes behind the same locks.
        const assetContent = instance.ok && data.modelSourceKind === "glb"
          ? instanceContentVersion(data, canvas)
          : null;
        entry.values.push({
          nodeId,
          sharedWorldInstance: data.sharedWorldInstance,
          worldCamera: data.worldCamera,
          content: WORLD_CONTENT_FIELDS.map(field => data[field]),
          assetContent
        });
        objects.set(key, entry);
      }
    }
    for (const entry of objects.values()) entry.values.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
    return objects;
  };
  const old = collect(before), next = collect(after);
  const affected = new Map<string, WorldObjectIdentity>();
  const changed = (left: WorldDataFingerprint[] | undefined, right: WorldDataFingerprint[] | undefined): boolean => {
    if (!left || !right || left.length !== right.length) return true;
    return left.some((value, index) => !sameWorldFingerprint(value, right[index]!));
  };
  for (const [key, entry] of old) if (changed(entry.values, next.get(key)?.values)) affected.set(key, entry.target);
  for (const [key, entry] of next) if (changed(old.get(key)?.values, entry.values)) affected.set(key, entry.target);
  return [...affected.values()];
}
