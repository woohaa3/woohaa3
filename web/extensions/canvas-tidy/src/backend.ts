/**
 * 一键整理的后端入口（`hostPlugin`）。
 *
 * 这个扩展的整理动作完全发生在浏览器（几何、命令提交都在前端），后端**不做任何业务**：它的
 * 唯一职责是**声明配置段**，让宿主把这些键登记进设置定义表，于是它们
 * - 落在宿主配置文件里（`extensions.canvas-tidy.*`），跟着用户数据走，不是浏览器本地偏好；
 * - 在设置页「插件配置 → 一键整理」里自动生成表单；
 * - 改动后热重载，前端下一次点「一键整理」就用新值。
 *
 * 为什么必须走这条而不是前端自己存：这是**宿主持久化**的配置事实，要能被手工编辑配置文件、
 * 能被设置接口校验、能随部署迁移。浏览器 localStorage 只适合纯展示偏好（如任务面板展开状态），
 * 不适合「整理怎么排」这种可被运维统一约定的策略。
 *
 * `apply` 里没有副作用是刻意的：配置值由前端经 `/api/settings` 读取后传给规划函数，
 * 后端再算一遍会造出第二份事实。
 */
import type { ExtensionPlugin } from "@woohaa3/contracts";
import { CANVAS_TIDY_CONFIG, CANVAS_TIDY_PLUGIN_ID } from "./shared.js";

export function createCanvasTidyPlugin(): ExtensionPlugin<typeof CANVAS_TIDY_CONFIG.fields> {
  return {
    name: CANVAS_TIDY_PLUGIN_ID,
    label: "一键整理",
    configPrefix: `extensions.${CANVAS_TIDY_PLUGIN_ID}`,
    inject: ["log"],
    Config: CANVAS_TIDY_CONFIG,
    apply(ctx, config) {
      // 只记录一次生效配置，便于排障时确认「这次整理用的是哪组参数」。
      ctx.log.scope(CANVAS_TIDY_PLUGIN_ID)({
        event: "canvas-tidy-config-loaded",
        gap: config.gap,
        columnGapRatio: config.columnGapRatio,
        shrinkOversized: config.shrinkOversized,
        maxCardScale: config.maxCardScale,
        revealAfterTidy: config.revealAfterTidy
      });
    }
  };
}
