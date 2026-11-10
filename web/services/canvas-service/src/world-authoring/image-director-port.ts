import type { ImageDirectorScenePort } from "@woohaa3/contracts";
import type { CanvasMediaClient } from "../clients/media-client.js";
import type { CanvasRoom } from "../sync/room.js";
import { finalizeImageDirectorScene, lookupImageDirectorScene } from "./image-director-finalize.js";
import { prepareImageDirectorSource } from "./image-director-source.js";
import { reserveImageDirectorScene, settleImageDirectorReservation } from "./image-director-reservation.js";

export function createImageDirectorScenePort(deps: { resolveRoom(canvasId: string): Promise<CanvasRoom | null>; authorize(owner: string, canvasId: string, permission: "read" | "write"): Promise<boolean>; media: CanvasMediaClient }): ImageDirectorScenePort {
  const roomFor = async (owner: string, canvasId: string, permission: "read" | "write") => {
    if (!await deps.authorize(owner, canvasId, permission)) throw new Error("当前用户无画布权限");
    const room = await deps.resolveRoom(canvasId);
    if (!room) throw new Error("画布不可用");
    return room;
  };
  return {
    prepare: input => prepareImageDirectorSource(input, deps),
    async reserve({ owner, ...input }) {
      const room = await roomFor(owner, input.canvasId, "write");
      return reserveImageDirectorScene(room, input, async () => await deps.authorize(owner, input.canvasId, "write") && await deps.authorize(owner, input.canvasId, "read"));
    },
    async settleReservation({ owner, canvasId, reservation, status }) {
      const room = await roomFor(owner, canvasId, "write");
      await settleImageDirectorReservation(room, { canvasId, reservation, status }, () => deps.authorize(owner, canvasId, "write"));
    },
    async finalize({ owner, ...input }) {
      const room = await roomFor(owner, input.canvasId, "write");
      return finalizeImageDirectorScene(room, input, { authorize: async () => await deps.authorize(owner, input.canvasId, "write") && await deps.authorize(owner, input.canvasId, "read") });
    },
    async lookup({ owner, canvasId, commandId }) {
      const room = await roomFor(owner, canvasId, "read");
      return lookupImageDirectorScene(room, commandId, () => deps.authorize(owner, canvasId, "read"));
    }
  };
}
