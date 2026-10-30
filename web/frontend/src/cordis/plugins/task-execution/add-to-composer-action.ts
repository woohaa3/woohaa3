/**
 * 卡片悬浮条上的「添加到对话框」动作。
 *
 * 语义：把这张卡片作为当前对话的目标 —— 选中它，底部停靠的节点执行面板随即切到该节点，
 * 用户可以继续在面板里写提示词、挂参考。位置与内容都由节点面板负责，这里只提交一次选择。
 *
 * 只对**有生成面板的节点类型**呈现（图片/视频/音频/文本）；分组、模型卡片没有该面板，不出现。
 */
import type { NodeActionDescriptor } from "../../contract/platform.js";

/** 稳定贡献 ID（横条命中回传用它派发）。 */
export const ADD_TO_COMPOSER_ACTION_ID = "add-to-composer";

/** 动作描述（纯函数）：不可写时保留呈现并禁用，原因写在 `summary` 里。 */
export function resolveAddToComposerDescriptor(input: { writable: boolean }): NodeActionDescriptor {
  return {
    label: "添加到对话框",
    enabled: input.writable,
    ...(input.writable ? {} : { reason: "当前会话不可写（画布只读）", summary: "画布只读" })
  };
}
