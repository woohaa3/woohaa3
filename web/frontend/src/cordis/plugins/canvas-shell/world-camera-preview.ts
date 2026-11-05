/**
 * 镜头视锥拖动中的瞬时位姿状态（从 `interaction-controller` 拆出，保持文件体积守卫）。
 *
 * 只保存「相对按下时规范位姿的地面增量」与按下时的镜头快照；真正渲染前按当前工具模式
 * 求值，避免每次 pointermove 都把未提交位姿写进画布。外部改写或删除镜头时该条目自动失效。
 */
import {
  decodeWorldCamera,
  type WorldCameraData,
  type WorldPoint,
  type WorldRotation
} from "@woohaa3/contracts";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { poseFor, type WorldCameraDragMode } from "./world-camera-drag.js";

export type WorldCameraPoseOverride = { position: WorldPoint; rotation: WorldRotation };

type PreviewEntry = {
  delta: { u: number; v: number };
  source: string;
  camera: WorldCameraData;
};

export type WorldCameraPreviewState = {
  /** 设置/更新一个镜头的地面增量；返回是否成功（镜头缺失/非法时为 false）。 */
  set(nodeId: string, delta: { u: number; v: number } | null): boolean;
  /** 清除全部瞬时位姿（取消/卸载/提交完成）。 */
  clear(): void;
  /** 当帧生效的位姿覆盖；会顺带移除已被外部改写的条目。 */
  overrides(): Map<string, WorldCameraPoseOverride>;
};

export function createWorldCameraPreviewState(input: {
  mode: () => WorldCameraDragMode;
  schedule: (reason?: string) => void;
  readCanvas?: () => ReturnType<typeof workingCanvasOf>;
}): WorldCameraPreviewState {
  const previews = new Map<string, PreviewEntry>();
  const readCanvas = input.readCanvas ?? (() => workingCanvasOf(woohaa3CanvasStore.getState()));

  const set = (nodeId: string, delta: { u: number; v: number } | null): boolean => {
    if (!delta) {
      previews.delete(nodeId);
      input.schedule("world-camera-preview");
      return false;
    }
    const canvas = readCanvas();
    const decoded = decodeWorldCamera(canvas?.nodeData?.[nodeId]?.worldCamera);
    if (!decoded.ok) return false;
    const source = JSON.stringify(canvas?.nodeData?.[nodeId]?.worldCamera);
    const existing = previews.get(nodeId);
    if (existing && existing.source === source) existing.delta = { ...delta };
    else previews.set(nodeId, { delta: { ...delta }, source, camera: decoded.value });
    input.schedule("world-camera-preview");
    return true;
  };

  const clear = (): void => {
    previews.clear();
  };

  const overrides = (): Map<string, WorldCameraPoseOverride> => {
    const canvas = readCanvas();
    const result = new Map<string, WorldCameraPoseOverride>();
    let changed = false;
    for (const [nodeId, entry] of previews) {
      if (JSON.stringify(canvas?.nodeData?.[nodeId]?.worldCamera) !== entry.source) {
        previews.delete(nodeId);
        changed = true;
        continue;
      }
      const pose = poseFor(entry.camera, input.mode(), entry.delta);
      // The renderer rejects a whole frame on an invalid camera payload; never let a
      // malformed preview leave the page. The committed path revalidates before saving.
      if (pose && decodeWorldCamera({ ...entry.camera, ...pose }).ok) result.set(nodeId, pose);
    }
    if (changed) input.schedule("world-camera-preview");
    return result;
  };

  return { set, clear, overrides };
}
