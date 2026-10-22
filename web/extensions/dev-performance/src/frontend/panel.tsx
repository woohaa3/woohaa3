import { useEffect, useState, type ReactNode } from "react";
import { startFrameMonitor, type FrameMetrics, type FrameSnapshot } from "./monitor.js";

function compact(value: number | null | undefined) {
  return value == null ? "—" : Math.round(value) > 999 ? "999+" : value.toFixed(0);
}

function full(value: number | null | undefined) {
  return value == null ? "—" : value.toFixed(2);
}

function readoutSvg(metrics: FrameMetrics | null) {
  return (
    <svg className="dev-performance" width="36" height="26" viewBox="0 0 36 26" fill="currentColor">
      <g className="dev-performance__labels">
        <text x="1" y="10">FPS</text>
        <text x="1" y="22">DC</text>
      </g>
      <g className="dev-performance__values" textAnchor="end">
        <text x="35" y="10" fontSize={metrics && Math.round(metrics.fps) > 999 ? 8 : undefined}>{compact(metrics?.fps)}</text>
        <text x="35" y="22" fontSize={metrics?.drawCalls3d != null && Math.round(metrics.drawCalls3d) > 999 ? 8 : undefined}>{compact(metrics?.drawCalls3d)}</text>
      </g>
    </svg>
  );
}

function details(metrics: FrameMetrics | null) {
  return (
    <div className="dev-performance__details">
      <span>FPS</span><span>{full(metrics?.fps)} 帧/秒</span>
      <span>Draw Call</span><span>{full(metrics?.drawCalls3d)} 次/帧</span>
      <span>逻辑更新</span><span>{full(metrics?.updatesPerSecond)} 次/秒</span>
      <span>平均渲染间隔</span><span>{full(metrics?.averageMs)} ms</span>
    </div>
  );
}

/**
 * 性能读数面板。
 *
 * 采样与读数只有一份，气泡始终由宿主提供（同一个 `canvas-control-panel__status` 实现）：
 * - **工具栏**（浏览器）：宿主把读数放进同步状态气泡，向上展开；
 * - **窗口顶栏**（Tauri）：宿主把读数放进横栏右侧，气泡**向下展开**。
 *
 * 两种情况都保留悬停详情，只是展开方向随宿主槽位；不在顶栏用原生 `title` 另起一套提示。
 */
export function PerformancePanel({ read, renderStatus }: {
  read: () => FrameSnapshot | null;
  renderStatus: (readout: ReactNode, details: ReactNode) => ReactNode;
}) {
  const [metrics, setMetrics] = useState<FrameMetrics | null>(null);
  useEffect(() => startFrameMonitor(window, read, setMetrics), [read]);
  return renderStatus(readoutSvg(metrics), details(metrics));
}
