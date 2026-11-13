/**
 * 镜头定位：把 3D 机位和（可选）2D 卡片一起带进视口。
 *
 * 镜头姿态与卡片排布本来就分开；用户从卡片操作时，3D 机位可能在 12 m 外、当前视口之外。
 * 这里不修改任何画布数据，只按地面投影点重新计算本地 viewport。
 * 新建镜头的卡片落点由 `@woohaa3/contracts` 的 `initialCameraCardPosition` 统一给出。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CanvasRuntimeService } from "../contract/canvas-runtime.js";
import {
  worldToCanvasPoint,
  worldToRendererPosition,
  type WorldCameraData
} from "@woohaa3/contracts";

export type WorldCameraCardRect = { x: number; y: number; width: number; height: number };

export function revealWorldCamera(
  ctx: Context,
  camera: WorldCameraData,
  card?: WorldCameraCardRect
): boolean {
  const controller = (ctx.get("canvasRuntime" as never) as CanvasRuntimeService | undefined)?.controller() ?? null;
  if (!controller) return false;
  const surface = controller.surface();
  if (!(surface.width > 0) || !(surface.height > 0)) return false;
  const viewport = controller.viewport();
  // Frame the actual camera body (not only its ground projection); otherwise the
  // body can still sit just outside the viewport after locating the card.
  const position = worldToRendererPosition({ u: camera.position.u, v: camera.position.v, h: camera.position.h });
  const ground = worldToCanvasPoint([position[0], position[1], position[2]]);
  const points = [{ x: ground.x, y: ground.y }];
  if (card) points.push({ x: card.x + card.width / 2, y: card.y + card.height / 2 });
  const minX = Math.min(...points.map(point => point.x));
  const maxX = Math.max(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y));
  const maxY = Math.max(...points.map(point => point.y));
  const spanX = Math.max(240, maxX - minX + 240);
  const spanY = Math.max(240, maxY - minY + 240);
  const fit = Math.min(surface.width / spanX, surface.height / spanY);
  const zoom = Math.max(0.2, Math.min(1, viewport.zoom, fit));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  controller.panViewportTo(
    {
      x: surface.width / 2 - centerX * zoom,
      y: surface.height / 2 - centerY * zoom,
      zoom
    },
    { durationMs: 260 }
  );
  return true;
}
