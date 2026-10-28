/**
 * Task Activity extension 前端入口（扫描约定入口）
 * （change: 2026-10-10-extract-optional-feature-extensions，任务 5.1/5.2 / design D1/D2/D7；
 *   change: 2026-10-22-unify-task-activity-rows，任务 1.1/3.3：转出统一记录模型与三个适配器，
 *   删除组专属行组件）。
 *
 * `web/extensions/task-activity/src/frontend/index.ts` 是构建期可信扫描入口：扫描器只读取
 * `descriptor`。`descriptor.plugin()` 是无副作用工厂；宿主在 Canvas page scope 始终装配
 * 完整 Cordis plugin（见 `./plugin.js`）。任务活动承接组节点状态入口，是必需能力；旧的本地
 * 停用偏好不再过滤它，资源加载或插件启动失败必须进入可见的页面错误。
 *
 * 除 descriptor 外，本入口还转出包内业务实现的**公共浏览器面**（store/bridge/feed/display/
 * rows），供 Frontend/Showcase 消费者按公开路径消费，不直接 import 包内私有相对路径。
 *
 * 仅导入 `./plugin.js` 与 `./style.css`：CSS 由消费方打包器（Vite）按相对 import 加载，包构建
 * 以 copy loader 保留。
 */
import type { ExtensionFrontendDescriptor } from "@woohaa3/frontend/extension-api";
import { TASK_ACTIVITY_FRONTEND_METADATA } from "./metadata.js";
import { taskActivityExtension } from "./plugin.js";
import "./style.css";

export { taskActivityExtension, TASK_ACTIVITY_STORE_SERVICE } from "./plugin.js";
export { TASK_ACTIVITY_FRONTEND_METADATA } from "./metadata.js";
export {
  TaskActivityStore,
  ACTIVITY_PREFERENCE_KEY,
  ACTIVITY_EXIT_DURATION_MS,
  ACTIVITY_TERMINAL_LINGER_MS
} from "./store.js";
export type {
  ActivityFeedItem,
  ActivityFeedSnapshot,
  ActivityStoreOptions,
  BackgroundFeedJob,
  TaskActivityRow
} from "./store.js";
export {
  compareRows,
  groupRunTone,
  BACKGROUND_KIND_LABELS,
  BACKGROUND_STATUS_LABELS,
  SKILL_STATE_LABELS,
  TASK_STATE_LABELS,
  skillStateActive,
  skillStateTone
} from "./rows.js";
export type {
  ActivityRow,
  ActivityRowActions,
  ActivityRowCapabilities,
  ActivityRowGroupCapabilities,
  ActivityRowKind,
  ActivityRowSkillCapabilities,
  ActivityRowSource,
  ActivityRowTone
} from "./rows.js";
export { adaptTaskRow, defaultTaskTitle, taskRowKey } from "./adapt-task-row.js";
export { adaptJobRow, isActiveBackgroundJob, jobRowKey } from "./adapt-job-row.js";
export { adaptGroupRow, canRetryGroupRun, canStopGroupRun, groupRowKey } from "./adapt-group-row.js";
export { adaptSkillRow, currentSkillAttempt, skillRowKey, skillStepActive, skillStepTitle } from "./adapt-skill-row.js";
export { createTaskActivityEventBridge } from "./bridge.js";
export type {
  TaskActivityBridgeOptions,
  TaskActivityBridgeSink,
  TaskActivityEventBridge,
  TaskActivitySources
} from "./bridge.js";
export { TaskActivityFeed } from "./feed.js";
export type { TaskActivityFeedProps } from "./feed.js";
/** 组创作读模型行类型（`ActivityRow.source` 组的载荷）。 */
export type { CanvasGroupRun } from "@woohaa3/frontend/extension-api";
export { resolveTaskActivityDisplay, modelDisplayName, taskActivityAction } from "./display.js";
export type { ActivityCanvasNode, TaskActivityDisplay } from "./display.js";

/** 构建期扫描读取的入口描述。`plugin()` 无副作用；画布必需装配（`always`）。 */
export const descriptor: ExtensionFrontendDescriptor = {
  ...TASK_ACTIVITY_FRONTEND_METADATA,
  plugin: () => taskActivityExtension()
};
