/**
 * Task Activity 扩展共享定义（前后端均可导入；不含任何一端运行时实现）
 * （change: 2026-10-10-extract-optional-feature-extensions，任务 5.1 / design D1/D2）。
 *
 * 只含稳定 identity 与浏览器安全的可读元数据。具体 store/bridge/UI 在前端入口。
 */

export const TASK_ACTIVITY_PLUGIN_ID = "task-activity";

/** 浏览器本地可选扩展的展示元数据（纯数据，无副作用）。 */
export const TASK_ACTIVITY_LABEL = "任务活动";
export const TASK_ACTIVITY_DESCRIPTION = "在当前画布显示任务活动浮层、进度与结果预览。";
