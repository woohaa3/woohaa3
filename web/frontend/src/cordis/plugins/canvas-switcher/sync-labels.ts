/**
 * 画布切换器的同步文案与实时态判定。
 *
 * 从 `chrome.tsx` 拆出（file-budget：chrome.tsx 曾越过 800 物理行上限）。触发器与
 * 条目徽标都要读同一套文案，放在这里避免两边各写一份、也避免 `chrome.tsx` 与
 * `trigger.tsx` 互相 import 成环。
 */
import type { CanvasSummary } from "../../contract/canvas-catalog.js";

/** 目录同步状态的展示文案（触发器与条目徽标共用）。 */
export const SYNC_LABELS: Record<NonNullable<CanvasSummary["sync"]>, string> = {
  "local-only": "仅本机",
  synced: "已同步",
  syncing: "同步中",
  offline: "离线",
  failed: "同步失败",
  "remote-only": "仅远端",
  // 属于远端、但本机还没有上游链路：改动只落在本机，必须显式说出来。
  unlinked: "未连接"
};

/**
 * 顶栏胶囊的**实时**连接态，来自当前画布会话而不是目录快照。
 *
 * 目录快照（`CanvasSummary.sync`）回答「本机↔远端存储同步到哪一步」，可能已经过期；
 * 断线时它仍会写着「已同步」，与右下角同步气泡的「只读」互相矛盾。因此胶囊以会话为准：
 * - `offline`：画布连接已断开，页面只读（文案「离线只读」）；
 * - `connecting`：会话仍在建连、尚未 ready（文案「连接中」）；
 * - `ready`：连接正常，胶囊回落目录同步标签（已同步/同步中/仅本机/…）。
 */
export type CanvasLiveSync = "offline" | "connecting" | "ready";

/** 实时态在胶囊里的短文案。 */
export const LIVE_SYNC_LABELS: Record<Exclude<CanvasLiveSync, "ready">, string> = {
  offline: "离线只读",
  connecting: "连接中"
};

/** 实时态的详细说明（Tooltip 与 aria-label 用）：与右下角气泡回答同一件事。 */
export const LIVE_SYNC_DETAILS: Record<Exclude<CanvasLiveSync, "ready">, string> = {
  offline: "画布连接已断开，只读，可在右下角重新连接",
  connecting: "正在连接画布服务"
};

/**
 * 实时态对应的 `data-sync` 相位：离线沿用离线色，连接中沿用同步中色，
 * 复用既有样式分支，不为实时态新增一套配色。
 */
export const LIVE_SYNC_PHASES: Record<Exclude<CanvasLiveSync, "ready">, NonNullable<CanvasSummary["sync"]>> = {
  offline: "offline",
  connecting: "syncing"
};

/** 未注入实时态时的稳定空实现（useSyncExternalStore 需要稳定的 getSnapshot）。 */
export const NO_LIVE_SYNC = () => undefined;
