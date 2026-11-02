import type { ServerCanvas, WorldObjectIdentity } from "@woohaa3/contracts";
import { decodeWorldInstanceData, decodeWorldCamera } from "@woohaa3/contracts";
import { objectKey } from "./spatial-leases.js";

/** Compare canonical node ownership and data, including content and world settings. */
export function affectedWorldObjects(before: ServerCanvas, after: ServerCanvas): WorldObjectIdentity[] {
  const collect = (canvas: ServerCanvas) => {
    const objects = new Map<string, { target: WorldObjectIdentity; values: string[] }>();
    for (const [nodeId, data] of Object.entries(canvas.nodeData)) {
      const instance = decodeWorldInstanceData(data.sharedWorldInstance);
      const camera = decodeWorldCamera(data.worldCamera);
      const target: WorldObjectIdentity | null = instance.ok
        ? { kind: "instance", instanceId: instance.value.instanceId }
        : camera.ok ? { kind: "camera", cameraId: camera.value.cameraId } : null;
      if (target) {
        const key = objectKey(target);
        const entry = objects.get(key) ?? { target, values: [] };
        entry.values.push(JSON.stringify([nodeId, data]));
        objects.set(key, entry);
      }
    }
    for (const entry of objects.values()) entry.values.sort();
    return objects;
  };
  const old = collect(before), next = collect(after);
  const affected = new Map<string, WorldObjectIdentity>();
  for (const [key, entry] of old) if (JSON.stringify(next.get(key)?.values) !== JSON.stringify(entry.values)) affected.set(key, entry.target);
  for (const [key, entry] of next) if (JSON.stringify(old.get(key)?.values) !== JSON.stringify(entry.values)) affected.set(key, entry.target);
  return [...affected.values()];
}
