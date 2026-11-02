/**
 * T10 generation-entry capture camera resolution.
 *
 * The model execution panel owns no camera UI; the shared-world canonical canvas is
 * the only authority. When an image model accepts `reference_image` guidance, use the
 * world framing of an unbound camera (or the first camera if every camera is bound).
 * This only selects the camera id: every version/media field still comes from the
 * Canvas Service freeze response.
 */
import {
  catalogModelBindings,
  WORLD_CAPTURE_REFERENCE_ROLE,
  type CanvasTaskCatalogModel,
  type ServerCanvas
} from "@woohaa3/contracts";

type CanvasLike = Pick<ServerCanvas, "document" | "nodeData">;

type CameraSnapshot = { cameraId: string; boundInstanceId?: string };

function readCameras(canvas: CanvasLike | null | undefined): CameraSnapshot[] {
  if (!canvas) return [];
  const cameras: CameraSnapshot[] = [];
  for (const node of canvas.document.nodes) {
    if (node.type !== "world-camera") continue;
    const data = (canvas.nodeData as Record<string, { worldCamera?: unknown } | undefined>)[node.id];
    const camera = data?.worldCamera;
    if (!camera || typeof camera !== "object") continue;
    const record = camera as { kind?: unknown; cameraId?: unknown; boundInstanceId?: unknown };
    if (record.kind !== "world-camera" || typeof record.cameraId !== "string" || record.cameraId === "") continue;
    cameras.push({
      cameraId: record.cameraId,
      ...(typeof record.boundInstanceId === "string" && record.boundInstanceId !== ""
        ? { boundInstanceId: record.boundInstanceId }
        : {})
    });
  }
  return cameras;
}

/**
 * Return the unbound world-framing camera id, or undefined.
 *
 * A bound camera only frames its single instance; using it implicitly for an
 * unrelated generation would silently substitute a different composition. Bound
 * cameras must be selected explicitly by the caller that owns that instance.
 */
export function resolveDefaultCaptureCameraId(canvas: CanvasLike | null | undefined): string | undefined {
  return readCameras(canvas).find((camera) => camera.boundInstanceId === undefined)?.cameraId;
}

/** Image models that can consume the framing as a normal reference image. */
export function modelAcceptsWorldCaptureReference(model: CanvasTaskCatalogModel | null | undefined): boolean {
  if (!model || model.modelType !== "image") return false;
  return catalogModelBindings(model).some(
    (binding) =>
      binding.semantic === "reference-image" &&
      binding.roles.includes(WORLD_CAPTURE_REFERENCE_ROLE) &&
      binding.mediaKinds.includes("image")
  );
}
