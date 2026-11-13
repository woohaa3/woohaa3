import type { Context } from "@deepseek-ai/cordis";
import { createHighEntropyId, worldCameraSettingsEqual, worldCameraUiSettingsOf, type WorldCameraData, type WorldCameraUiSettings } from "@woohaa3/contracts";
import { submitWorldCameraSave } from "../../services/world-camera-ui.js";

/**
 * Camera settings have no forward/inverse receipt of their own; the authoritative
 * inverse is another `world-camera-save`. Only a verified save outcome updates the
 * shared version chain. A conflict, cancellation or uncertain receipt returns
 * `ok:false`, so the page journal keeps its cursor in place.
 */
export function adoptCameraTimeline(input: {
  ctx: Context;
  canvasId: string;
  cameraId: string;
  before: WorldCameraData;
  after: WorldCameraData;
  label: string;
  operationId: string;
  revision?: number;
  version: { current: string };
}): { ok: boolean; reason?: string } {
  const { ctx, canvasId, cameraId, before, after, label, operationId, version } = input;
  const beforeSettings = worldCameraUiSettingsOf(before);
  const afterSettings = worldCameraUiSettingsOf(after);
  const apply = async (settings: WorldCameraUiSettings): Promise<{ ok: true; revision?: number } | { ok: false; reason: string }> => {
    const result = await submitWorldCameraSave(ctx.canvasRemote, {
      canvasId,
      cameraId,
      expectedSettingsVersion: version.current,
      settings,
      operationId: createHighEntropyId("world-camera-timeline")
    });
    if (!result.ok) return { ok: false, reason: result.message };
    if (!worldCameraSettingsEqual(worldCameraUiSettingsOf(result.camera), settings)) {
      return { ok: false, reason: "镜头回执与请求的配置不一致" };
    }
    version.current = result.settingsVersion;
    return { ok: true, revision: result.revision };
  };
  return ctx.canvasEdit.recordExternal({
    id: `world-camera:${operationId}`,
    label,
    revision: input.revision,
    undo: () => apply(beforeSettings),
    redo: () => apply(afterSettings)
  }).ok ? { ok: true } : { ok: false, reason: "无法加入撤销历史" };
}

