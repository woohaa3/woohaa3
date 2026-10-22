/**
 * 任务活动事件 payload 与分类 helper（宿主再导出）
 * （change: formalize-frontend-event-bus，任务 2.2 / design D3；
 *  change: 2026-10-10-extract-optional-feature-extensions：权威定义迁至
 *  `@woohaa3/contracts` 的 `task/activity.ts`，使 task-activity 扩展与 Task Execution
 *  共享同一份浏览器安全契约，不互相 import 宿主/扩展实现。本模块只做稳定再导出，保持
 *  既有宿主import路径不变。
 *
 * 三个生命周期事件只表达**前端可显示事实**：本地 optimistic 开始（`started`）、权威非终态
 * 更新（`updated`）、权威终态或接受前本地拒绝（`finished`）。payload 只含稳定身份、状态、
 * 进度、白名单结果/错误摘要和 cursor；**不得**携带 Blob、data URL、签名 URL、媒体 bytes、
 * 完整 prompt 或凭据。
 */
export {
  classifyTaskActivity,
  isLocalRejection,
  localRejectionEvent
} from "@woohaa3/contracts";
export type {
  TaskActivityClassification,
  TaskActivityEvent,
  TaskActivityFinished,
  TaskActivityFinishedLocalRejection,
  TaskActivityFinishedRemote,
  TaskActivityStarted,
  TaskActivityUpdated
} from "@woohaa3/contracts";
