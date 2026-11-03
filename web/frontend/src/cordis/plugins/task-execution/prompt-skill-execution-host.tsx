/**
 * 提示词改写的 Host 适配层（change: add-prompt-skill-extension，design D1）。
 *
 * 执行面板的「快捷改写」由扩展通过 `execution.prompt-skill` slot 提供：宿主取**首个可用贡献**，
 * 把它的 `rewrite` 接到 `ModelExecutionHost`。扩展只产出改写后的文本；把结果写回草稿、显示
 * 进行中/错误状态都由 Host 与面板拥有。
 *
 * 单独成模块：`ModelExecutionHost` 是懒加载 chunk，这里保持同一条懒加载边界，避免宿主闭包
 * 提前拉起执行面板实现。
 */
import { useCallback, useSyncExternalStore } from "react";
import type { SlotsService } from "../../contracts.js";
import { ModelExecutionHost } from "./model-execution-host.js";
import type { ModelExecutionHostProps } from "./node-execution-panel-types.js";

const PROMPT_SKILL_SLOT = "execution.prompt-skill" as const;

export function PromptSkillExecutionHost({ slots, ...props }: ModelExecutionHostProps & { slots: SlotsService }) {
  useSyncExternalStore(
    useCallback((listener: () => void) => slots.subscribe(PROMPT_SKILL_SLOT, listener), [slots]),
    () => slots.version(),
    () => slots.version()
  );
  const contribution = slots.list(PROMPT_SKILL_SLOT).find((entry) => {
    if (entry.available === undefined) return true;
    try {
      return entry.available();
    } catch {
      // 扩展自己的可用性判断抛错只表示"不可用"；不让它打断执行面板渲染。
      return false;
    }
  });
  return (
    <ModelExecutionHost
      {...props}
      {...(contribution ? { promptSkill: contribution.rewrite } : {})}
    />
  );
}
