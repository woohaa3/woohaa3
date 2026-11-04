import { createImageDirectorScenePort, type CanvasMediaClient, type CanvasService } from "@woohaa3/canvas-service";

export function createImageDirectorPort(canvas: CanvasService, media: CanvasMediaClient) {
  return createImageDirectorScenePort({
    resolveRoom: async canvasId => (await canvas.sync?.registry.resolve(canvasId)) ?? null,
    authorize: async (owner, canvasId, permission) => (await canvas.mcpServices().agent?.authorizeCanvas({ principalId: owner, canvasId, permission }))?.ok === true,
    media
  });
}
