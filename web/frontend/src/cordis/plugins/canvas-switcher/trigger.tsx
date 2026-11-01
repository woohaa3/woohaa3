/**
 * 画布切换器的顶层触发器：显示当前画布标题与同步状态，点击打开切换器。
 *
 * 从 `chrome.tsx` 拆出（file-budget：chrome.tsx 曾越过 800 物理行上限）。触发器和
 * Dialog 是两件事：前者常驻顶栏、只读标题与同步态；后者才是列表与增删改。拆开后
 * 两边各自 300 行以内，改列表不用翻过触发器。
 */
import { useEffect, useSyncExternalStore } from "react";
import { Button, Tooltip } from "@woohaa3/ui/primitives";
import { CanvasSwitcherIcon, ChevronDownIcon } from "@woohaa3/ui/icons";
import type { CanvasSummary } from "../../contract/canvas-catalog.js";
import type { CanvasNavigationService } from "../../navigation/index.js";
import {
  LIVE_SYNC_DETAILS,
  LIVE_SYNC_LABELS,
  LIVE_SYNC_PHASES,
  NO_LIVE_SYNC,
  SYNC_LABELS,
  type CanvasLiveSync
} from "./sync-labels.js";

/** 顶层触发器：显示当前画布标题与同步状态，点击打开切换器。模型聚焦时隐藏。 */
export function CanvasSwitcherTrigger({
  getTitle,
  getSync,
  getLiveSync = NO_LIVE_SYNC,
  subscribeTitle,
  onOpen,
  onRefreshCatalog,
  navigation
}: {
  getTitle: () => string;
  getSync: () => CanvasSummary["sync"] | undefined;
  /**
   * 实时连接态（可选）。未注入时只看目录快照：断线/建连期间必须以它为准，
   * 否则胶囊会和右下角气泡说两套话。
   */
  getLiveSync?: () => CanvasLiveSync | undefined;
  subscribeTitle: (listener: () => void) => () => void;
  onOpen: () => void;
  onRefreshCatalog?: () => void;
  navigation: CanvasNavigationService;
}) {
  const title = useSyncExternalStore(subscribeTitle, getTitle, getTitle);
  const sync = useSyncExternalStore(subscribeTitle, getSync, getSync);
  const liveSync = useSyncExternalStore(subscribeTitle, getLiveSync, getLiveSync);
  const presentation = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
  // 媒体补传期间目录不会自己刷新：触发器可见时短轮询，直到状态离开「同步中」。
  useEffect(() => {
    if (sync !== "syncing" || !onRefreshCatalog) return;
    const timer = setInterval(onRefreshCatalog, 1500);
    return () => clearInterval(timer);
  }, [sync, onRefreshCatalog]);
  if (presentation.mode.type === "node-focus") return null;
  const label = title.trim() || "未命名画布";
  // 实时态优先：断线/建连时不再显示目录快照的「已同步」，胶囊只表达一个事实。
  const livePhase = liveSync === "offline" || liveSync === "connecting" ? liveSync : null;
  const pillLabel = livePhase ? LIVE_SYNC_LABELS[livePhase] : sync ? SYNC_LABELS[sync] : null;
  const pillPhase: CanvasSummary["sync"] | undefined = livePhase ? LIVE_SYNC_PHASES[livePhase] : sync;
  const statusText = livePhase ? LIVE_SYNC_DETAILS[livePhase] : sync ? SYNC_LABELS[sync] : null;
  return (
    <Tooltip content={`当前画布：${label}${statusText ? ` · ${statusText}` : ""}`}>
      <Button
        className="canvas-switcher-trigger"
        tone="neutral"
        size="sm"
        aria-label={`当前画布：${label}${statusText ? `，${statusText}` : ""}，打开画布切换器`}
        data-testid="canvas-switcher-trigger"
        icon={<CanvasSwitcherIcon className="canvas-switcher-trigger__icon" />}
        onClick={onOpen}
      >
        <span className="canvas-switcher-trigger__title">{label}</span>
        {pillLabel && pillPhase ? (
          <span className="canvas-switcher-trigger__sync" data-sync={pillPhase} data-testid="canvas-switcher-sync">
            {pillLabel}
          </span>
        ) : null}
        <span className="canvas-switcher-trigger__caret" aria-hidden="true">
          <ChevronDownIcon />
        </span>
      </Button>
    </Tooltip>
  );
}
