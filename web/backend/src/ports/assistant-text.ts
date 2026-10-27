import {
  createCanvasAssistantTextPort,
  type CanvasService,
} from "@woohaa3/canvas-service";
import type { CanvasMediaClient } from "@woohaa3/canvas-service";
/** Composition only: Canvas remains the sole owner of compilation and delivery. */
export function createAssistantTextPort(
  canvas: CanvasService,
  media: CanvasMediaClient,
) {
  return createCanvasAssistantTextPort({
    resolveRoom: async (canvasId) =>
      (await canvas.sync?.registry.resolve(canvasId)) ?? null,
    authorize: async (owner, canvasId, permission) =>
      (
        await canvas
          .mcpServices()
          .agent?.authorizeCanvas({ principalId: owner, canvasId, permission })
      )?.ok === true,
    media,
    history: canvas.nodeHistory?.service,
  });
}
