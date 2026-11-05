/**
 * 四喜发行形态：画布右键菜单里不出现的任务执行项。
 *
 * 与 `settings/workspace/settings-plugins-sixi.ts` 同一套做法 —— 规则放在我们自己的文件，
 * 只在上游那个纯函数 `generationTraceMenuItems` 里加一个入参（缺省不隐藏），由插件接线处传入，
 * 不删菜单、不改分组逻辑、不动 `registerGenerationTraceMenu` 的注册流程。
 *
 * 为什么藏「查看生成溯源」而不是「不装配任务执行」：
 * `task-execution` 是节点生成面板（图片/文本/视频/音频）与提交协调器的宿主，
 * 四喜每一次生成都走它。**必须继续装配**，否则画布上没有任何生成入口。
 * 它的问题是这一项暴露了宿主的管理面：点开是上游任务号、请求摘要、事件时间线，
 * 那是给能看全局任务数据的人排障用的。四喜用户从画布产物出发需要的是「这张图怎么再做一张」，
 * 不是「这次 run 的 taskKey 是什么」。
 *
 * 隐藏只作用于这一条菜单项：生成面板、任务提交、取消、节点历史、任务监控页面
 * （`/admin/tasks`）都不受影响。内部排障仍可从任务监控页按画布筛选。
 */

/**
 * 画布右键菜单里隐藏的贡献 id。加一行即可隐藏，不用动 `generation-trace.ts` 的实现。
 *
 * - `view-generation-trace`（「查看生成溯源」）：打开上游任务详情（taskKey、请求摘要、
 *   事件时间线）。面向能读全局任务数据的排障者，四喜用户不需要，列在右键菜单里只会
 *   多一个点进去看不懂的入口。
 *
 * 隐藏只作用于右键菜单项：`generation-trace` 这个菜单贡献本身仍注册（因此菜单合并、
 * 释放与诊断行为不变），只是 `items()` 返回空数组。
 */
export const SIXI_HIDDEN_CANVAS_MENU_ITEMS: readonly string[] = ["view-generation-trace"];

/** 这一项在四喜发行形态下是否隐藏。纯函数，每次右键重新调用。 */
export function isSixiHiddenCanvasMenuItem(id: string): boolean {
  return SIXI_HIDDEN_CANVAS_MENU_ITEMS.includes(id);
}
