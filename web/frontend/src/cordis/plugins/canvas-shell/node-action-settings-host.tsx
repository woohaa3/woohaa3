/**
 * 「设置箭头」DOM 弹窗宿主
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.4/3.6 / design D6 修订）。
 *
 * 横条本体的按钮由 Web 渲染；点击**独立设置箭头**时 canvas-shell 打开
 * `nodeActionSettingsStore`，本组件按贡献 id 取该贡献声明的 `settings` 组件，锚定在节点
 * 屏幕矩形上方渲染。复杂 UI（模型选择、可选要求、视频范围、配置入口）继续走 DOM，不受画布
 * 手势影响；关闭由贡献的「开始转换」/宿主 `onClose` 完成。
 */
import { useCallback, useRef, useSyncExternalStore } from "react";
import type { ScreenRect } from "@woohaa3/contracts";
import { useService } from "../../react.js";
import { useSlot } from "../../host.js";
import { ContributionBoundary } from "../../contribution-boundary.js";
import { resolveSettingsComponent, nodeActionSettingsStore } from "./node-action-host.js";
import type { NodeActionContribution } from "../../contract/platform.js";

export function NodeActionSettingsHost() {
  const canvasRuntime = useService("canvasRuntime");
  const contributions = useSlot("canvas.node-action") as unknown as NodeActionContribution[];
  const state = useSyncExternalStore(
    nodeActionSettingsStore.subscribe,
    nodeActionSettingsStore.get,
    nodeActionSettingsStore.get
  );
  const screenRect = useNodeScreenRect(canvasRuntime, state?.nodeId ?? null);
  const close = useCallback(() => { nodeActionSettingsStore.close(); }, []);
  const Settings = state ? resolveSettingsComponent(contributions, state.contributionId) : null;
  if (!state || !Settings || !screenRect) return null;
  // 锚点：节点屏幕矩形上方（横条所在处），左对齐节点左缘；容器自身不拦截空白区域。
  const style = { left: `${Math.round(screenRect.left)}px`, top: `${Math.round(screenRect.top)}px` };
  return (
    <div className="node-action-settings" style={style} data-node-id={state.nodeId}>
      <ContributionBoundary
        entry={contributions.find((entry) => entry.id === state.contributionId) ?? { id: state.contributionId }}
        slot="canvas.node-action"
        fallback="card"
      >
        <Settings
          nodeId={state.nodeId}
          nodeType={state.nodeType}
          writable={state.writable}
          onClose={close}
        />
      </ContributionBoundary>
    </div>
  );
}

/** 节点屏幕矩形订阅（视口/投影变化时重排）；按值缓存避免 `getSnapshot` 每次新建对象。 */
function useNodeScreenRect(
  canvasRuntime: { subscribeViewport(listener: () => void): () => void; nodeScreenRect(nodeId: string): ScreenRect | null },
  nodeId: string | null
): ScreenRect | null {
  const cache = useRef<ScreenRect | null>(null);
  const getSnapshot = useCallback((): ScreenRect | null => {
    const next = nodeId ? canvasRuntime.nodeScreenRect(nodeId) : null;
    const previous = cache.current;
    if (sameScreenRect(previous, next)) return previous;
    cache.current = next;
    return next;
  }, [canvasRuntime, nodeId]);
  return useSyncExternalStore(canvasRuntime.subscribeViewport, getSnapshot, () => null);
}

function sameScreenRect(a: ScreenRect | null, b: ScreenRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}
