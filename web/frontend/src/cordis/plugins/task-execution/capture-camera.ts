/**
 * T10 generation-entry capture selection.
 *
 * A world-camera card only frames a generation when the caller that owns the
 * generation selects it explicitly. The model execution panel must never scan the
 * canvas and adopt an unrelated camera: adding, removing, reordering or binding a
 * camera card cannot change an ordinary image submission.
 *
 * T09/T11b own the production UI that supplies the explicit id. The id is only a
 * selection; every version/media field still comes from the Canvas Service freeze
 * response before durable acceptance.
 */

export type WorldCaptureSelection = { cameraId: string };

/**
 * Return the explicit caller selection, if any.
 *
 * Deliberately has no canvas parameter: there is no implicit global default.
 */
export function explicitWorldCaptureSelection(
  captureCameraId: string | undefined
): WorldCaptureSelection | undefined {
  return captureCameraId ? { cameraId: captureCameraId } : undefined;
}
