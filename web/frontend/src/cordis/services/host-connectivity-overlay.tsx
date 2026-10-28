/**
 * 宿主重连遮罩与「扩展已更新」提示（change: 2026-10-21-harden-extension-fault-isolation，design D6）。
 *
 * - `reconnecting`：全局半透明遮罩「正在重新连接本机服务…」，盖住画布但**不卸载**它；
 *   遮罩吞掉指针事件，提交类操作另由 `blocksSubmissions()` 拒绝。
 * - `restarted`：底部非阻断提示，用户确认后只重建 Canvas scope。
 */
import { useSyncExternalStore } from "react";
import { Button } from "@woohaa3/ui/primitives";
import type { HostConnectivityService } from "./host-connectivity.js";

export function HostConnectivityOverlay({ connectivity }: { connectivity: HostConnectivityService }) {
  const snapshot = useSyncExternalStore(connectivity.subscribe, connectivity.getSnapshot, connectivity.getSnapshot);
  if (snapshot.phase === "reconnecting") {
    return (
      <div className="host-reconnecting" data-testid="host-reconnecting">
        <div className="host-reconnecting__panel">
          <div className="host-reconnecting__title">正在重新连接本机服务…</div>
          <div className="host-reconnecting__detail">
            {snapshot.attempts > 1 ? `已尝试 ${snapshot.attempts} 次，恢复后自动继续，无需刷新页面` : "恢复后自动继续，无需刷新页面"}
          </div>
        </div>
      </div>
    );
  }
  if (snapshot.phase === "restarted") {
    return (
      <div className="host-restarted" data-testid="host-restarted">
        <span>扩展已更新，重新打开画布以加载</span>
        <Button size="sm" tone="primary" onClick={() => void connectivity.reopenCanvas()}>
          重新打开画布
        </Button>
        <Button size="sm" tone="ghost" onClick={() => connectivity.dismissRestarted()}>
          稍后
        </Button>
      </div>
    );
  }
  return null;
}
