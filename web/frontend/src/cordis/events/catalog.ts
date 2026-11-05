/**
 * Frontend Event Catalog
 * （change: formalize-frontend-event-bus，任务 2.1 / design D1、D2）。
 *
 * Cordis `ctx.emit/on` 是**唯一**进程内事件总线。本模块把事件从散落的 `context.ts` 收集为
 * 一个集中、可发现、可审计的目录：
 *
 * - 编译期：`frontendEventPayloads` 定义每个事件的 payload 类型，并据此增强 Cordis `Events`
 *   （`emit`/`on` 都按同一份定义获得类型约束）；
 * - 运行时：`frontendEventCatalog` 记录 scope、语义种类与 producer/consumer owner，供架构
 *   审计与诊断使用；
 * - 运行时 descriptor **不**保存 payload 实例。
 *
 * 命名规则（design D2）：UI 行为请求用 `ui.<feature>.<action>-requested`；任务活动事实用
 * `task.activity.<phase>`。事件名不表达后端部署来源。
 */
import type { TaskActivityFinished, TaskActivityStarted, TaskActivityUpdated } from "./task-activity.js";
import type { ReleaseChangedPayload } from "../extension-entry/release-adoption.js";

/** 所有跨插件事件的 payload 类型（编译期事实源）。 */
export type FrontendEventPayloads = {
  "ui.media-preview.open-requested": { assetId: string; nodeId: string; title: string };
  "ui.text-preview.open-requested": { nodeId: string };
  /** 双击卡片底部标题行 → 请求重命名该节点（由 canvas-menu 的重命名浮层消费）。 */
  "ui.node-rename.open-requested": { nodeId: string };
  "ui.video-frame-capture.open-requested": { nodeId: string };
  "ui.node-history.open-requested": { nodeId: string };
  "ui.node-history.switch-requested": { nodeId: string; index?: number; step?: number; presentationId?: string; entryId?: string; operationId?: string };
  /** 版本卡片「重新编辑」→ 请求把该版本生成时的输入载回节点的对话框（由 task-execution 消费）。 */
  "ui.node-history.reedit-requested": { nodeId: string; snapshot: import("@woohaa3/contracts").RunInputSnapshot };
  "ui.node-download.save-requested": { nodeId: string };
  "task.activity.started": TaskActivityStarted;
  "task.activity.updated": TaskActivityUpdated;
  "task.activity.finished": TaskActivityFinished;
  /**
   * 扩展后台活动（非 durable 任务）：扩展在 canvas scope 内按稳定 `job.id` 幂等发布，
   * 由 task-activity 浮层展示（如镜头参考录制）。payload 只含可读摘要。
   */
  /**
   * 宿主发布目录已切换并完成热登记（change: 2026-10-21-add-extension-marketplace-point，6.2/6.3）：
   * 新增条目已按资格装配；升级/卸载的条目当前页面仍用旧版本，`pendingReopen` 供设置面提示重开画布。
   */
  "extension.release.changed": ReleaseChangedPayload;
};

/** Cordis `Events` 需要函数签名；由 payload map 派生。 */
export type FrontendEventSignatures = {
  [K in keyof FrontendEventPayloads]: (payload: FrontendEventPayloads[K]) => void;
};

export type FrontendEventName = keyof FrontendEventPayloads;

/** 事件语义种类：行为请求 vs 领域事实。 */
export type FrontendEventKind = "request" | "fact";

/** 事件所属 scope：App scope 跨页面存活，Canvas scope 随 Canvas page scope 释放。 */
export type FrontendEventScope = "app" | "canvas";

export type EventDescriptor = {
  scope: "app" | "canvas";
  kind: FrontendEventKind;
  producers: readonly string[];
  consumers: readonly string[];
};

/**
 * 事件目录：每个事件的 scope/kind/owner。
 *
 * `satisfies` 保证 key 集合与 `FrontendEventPayloads` **完全一致**——新增 payload 类型而忘记
 * 登记 descriptor，或登记了不存在的 payload，都会在 typecheck 失败。
 */
export const frontendEventCatalog = {
  "ui.node-history.switch-requested": { scope: "canvas", kind: "request", producers: ["canvas-runtime"], consumers: ["node-history"] },
  "ui.media-preview.open-requested": {
    scope: "canvas",
    kind: "request",
    producers: ["canvas-runtime"],
    consumers: ["media-preview"]
  },
  "ui.text-preview.open-requested": {
    scope: "canvas", kind: "request", producers: ["canvas-runtime"], consumers: ["media-preview"]
  },
  "ui.node-rename.open-requested": {
    scope: "canvas", kind: "request", producers: ["canvas-runtime"], consumers: ["canvas-menu"]
  },
  "ui.video-frame-capture.open-requested": {
    scope: "canvas",
    kind: "request",
    producers: ["canvas-runtime"],
    consumers: ["seedance-video-interaction"]
  },
  "ui.node-history.reedit-requested": {
    scope: "canvas",
    kind: "request",
    producers: ["node-history"],
    consumers: ["task-execution"]
  },
  "ui.node-history.open-requested": {
    scope: "canvas",
    kind: "request",
    producers: ["canvas-runtime"],
    consumers: ["node-history"]
  },
  "task.activity.started": {
    scope: "canvas",
    kind: "fact",
    producers: ["task-execution"],
    consumers: ["task-activity"]
  },
  "ui.node-download.save-requested": {
    scope: "canvas", kind: "request", producers: ["canvas-runtime"], consumers: ["canvas-shell"]
  },
  "task.activity.updated": {
    scope: "canvas",
    kind: "fact",
    producers: ["task-activity"],
    consumers: ["task-activity"]
  },
  "task.activity.finished": {
    scope: "canvas",
    kind: "fact",
    producers: ["task-execution", "task-activity"],
    consumers: ["task-activity"]
  },
  "extension.release.changed": {
    scope: "canvas",
    kind: "fact",
    producers: ["canvas-page-services"],
    consumers: ["settings"]
  }
} satisfies Record<FrontendEventName, EventDescriptor>;

/** 目录事件名集合（运行时；审计与诊断用）。 */
export const FRONTEND_EVENT_NAMES = Object.keys(frontendEventCatalog) as FrontendEventName[];

/** 已迁移前的旧事件名（必须零引用；审计守卫用）。 */
export const RETIRED_FRONTEND_EVENT_NAMES = [
  "canvas/image-preview",
  "canvas/video-frame-capture",
  "canvas/node-history"
] as const;

declare module "@deepseek-ai/cordis" {
  interface Events extends FrontendEventSignatures {}
}
