/**
 * 镜头卡片取景状态（change: 2026-11-05-camera-shot-as-video）。
 *
 * 浏览器本地只读投影：由 `captures-status` 轮询写入，供 Bevy 卡片显示
 * preview/ready/stale/failed。不进入 Y.Doc、不写规范数据、不参与生成。
 */
import type { WorldCaptureFramingStatus, WorldCameraShotPhase } from "@woohaa3/contracts";

let statuses: ReadonlyMap<string, WorldCaptureFramingStatus> = new Map();
const listeners = new Set<() => void>();

export const worldCameraShotStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get(cameraId: string): WorldCaptureFramingStatus | undefined {
    return statuses.get(cameraId);
  },
  snapshot(): ReadonlyMap<string, WorldCaptureFramingStatus> {
    return statuses;
  },
  set(next: readonly WorldCaptureFramingStatus[]): void {
    const map = new Map<string, WorldCaptureFramingStatus>();
    for (const status of next) map.set(status.cameraId, status);
    if (sameStatuses(map, statuses)) return;
    statuses = map;
    for (const listener of [...listeners]) listener();
  },
  clear(): void {
    if (statuses.size === 0) return;
    statuses = new Map();
    for (const listener of [...listeners]) listener();
  }
};

/** 把宿主状态映射成可下发到卡片的阶段。 */
export function shotPhaseOf(status: WorldCaptureFramingStatus | undefined): WorldCameraShotPhase {
  if (!status) return "preview";
  if (status.phase === "failed" || status.phase === "unavailable") return "failed";
  if (status.stale) return "stale";
  if (status.phase === "ready") return "ready";
  return "preview";
}

function sameStatuses(
  left: ReadonlyMap<string, WorldCaptureFramingStatus>,
  right: ReadonlyMap<string, WorldCaptureFramingStatus>
): boolean {
  if (left.size !== right.size) return false;
  for (const [cameraId, status] of left) {
    const other = right.get(cameraId);
    if (!other) return false;
    if (
      other.phase !== status.phase ||
      other.stale !== status.stale ||
      other.reason !== status.reason ||
      other.width !== status.width ||
      other.height !== status.height ||
      other.key?.outputVersion !== status.key?.outputVersion ||
      other.video?.mediaId !== status.video?.mediaId
    ) {
      return false;
    }
  }
  return true;
}
