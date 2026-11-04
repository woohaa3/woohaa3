import type { ImageDirectorScenePort } from "@woohaa3/contracts";
import type { CanvasMediaClient } from "../clients/media-client.js";
import type { CanvasRoom } from "../sync/room.js";
import { commitImageDirectorScene, lookupImageDirectorScene } from "./image-director-commit.js";
import { prepareImageDirectorCandidate } from "./image-director-candidate.js";
import { imageDirectorOccupancy, imageDirectorPlacementAnchor, planImageDirectorPlacement } from "./image-director-placement.js";
import { prepareImageDirectorSource } from "./image-director-source.js";
import { imageDirectorSourceGround, reserveImageDirectorScene, settleImageDirectorReservation } from "./image-director-reservation.js";

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
    async validate({ owner, canvasId, candidate, source, signal }) {
      await roomFor(owner, canvasId, "write");
      if (!await deps.authorize(owner, canvasId, "read")) throw new Error("当前用户无画布读取权限");
      const result = await prepareImageDirectorCandidate(candidate, { width: source.width, height: source.height }, signal);
      return result.ok ? { ok: true } : result;
    },
    async plan({ owner, canvasId, source, candidate, reservation, signal }) {
      const room = await roomFor(owner, canvasId, "write");
      const snapshot = room.exportCanvas();
      if (!snapshot.ok) throw new Error(snapshot.message);
      const ground = reservation ? imageDirectorPlacementAnchor(reservation.bounds) : imageDirectorSourceGround(snapshot.canvas, source.sourceNodeId);
      const prepared = await prepareImageDirectorCandidate(candidate, { width: source.width, height: source.height }, signal);
      if (!prepared.ok) throw new Error(prepared.diagnostic);
      const placement = planImageDirectorPlacement(prepared.value, await imageDirectorOccupancy(snapshot.canvas, signal, reservation?.nodeId), ground, "below-image");
      if (!placement) throw new Error("无法确定空闲放置位置");
      return placement;
    },
    async settleReservation({ owner, canvasId, reservation, status }) {
      const room = await roomFor(owner, canvasId, "write");
      await settleImageDirectorReservation(room, { canvasId, reservation, status }, () => deps.authorize(owner, canvasId, "write"));
    },
    async commit({ owner, signal, ...input }) {
      const room = await roomFor(owner, input.canvasId, "write");
      return commitImageDirectorScene(room, input, { signal, authorize: async () => await deps.authorize(owner, input.canvasId, "write") && await deps.authorize(owner, input.canvasId, "read") });
    },
    async lookup({ owner, canvasId, commandId }) {
      const room = await roomFor(owner, canvasId, "read");
      return lookupImageDirectorScene(room, commandId, () => deps.authorize(owner, canvasId, "read"));
    }
  };
}
