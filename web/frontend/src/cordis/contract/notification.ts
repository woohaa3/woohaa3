/**
 * App 级任务结果通知契约（类型与默认偏好 re-export）
 *
 * 契约定义已上移到 `@woohaa3/contracts`（`extension/services/frontend/`）：前端 Cordis 根的服务
 * 契约由 contracts 定义，`web/frontend` 实现并经 Context 增强暴露。本文件只做 re-export，
 * 保持前端内部与扩展的既有 import 路径不变。
 */
export type {
  TaskNotificationCategories,
  TaskNotificationChannel,
  TaskNotificationPermission,
  TaskNotificationChannelState,
  TaskNotificationPreferences,
  TaskNotificationSnapshot,
  TaskNotificationActions,
  TaskNotificationDelivery,
  TaskNotificationService,
  TaskNotificationTarget
} from "@woohaa3/contracts";
export { DEFAULT_TASK_NOTIFICATION_PREFERENCES } from "@woohaa3/contracts";
