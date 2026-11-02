import type { ServerCanvas, WorldObjectIdentity } from "@woohaa3/contracts";
import { decodeWorldInstanceData, decodeWorldCamera } from "@woohaa3/contracts";
import { objectKey } from "./spatial-leases.js";

/** Compare canonical node data, including content as well as world settings. */
export function affectedWorldObjects(before: ServerCanvas, after: ServerCanvas): WorldObjectIdentity[] {
  const collect = (canvas: ServerCanvas) => {
    const objects = new Map<string, { target: WorldObjectIdentity; value: string }>();
    for (const data of Object.values(canvas.nodeData)) {
      const instance = decodeWorldInstanceData(data.sharedWorldInstance);
      const camera = decodeWorldCamera(data.worldCamera);
      const target: WorldObjectIdentity | null = instance.ok
        ? { kind: "instance", instanceId: instance.value.instanceId }
        : camera.ok ? { kind: "camera", cameraId: camera.value.cameraId } : null;
      if (target) objects.set(objectKey(target), { target, value: JSON.stringify(data) });
    }
    return objects;
  };
  const old = collect(before), next = collect(after);
  const affected = new Map<string, WorldObjectIdentity>();
  for (const [key, entry] of old) if (next.get(key)?.value !== entry.value) affected.set(key, entry.target);
  for (const [key, entry] of next) if (old.get(key)?.value !== entry.value) affected.set(key, entry.target);
  return [...affected.values()];
}
