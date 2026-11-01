/**
 * 创作入口的「模型 + 推理强度」选择器（从 `authoring-composer.tsx` 的内联 JSX 原样移出）。
 *
 * 移出原因只是 file-budget：`authoring-composer.tsx` 曾越过 800 物理行上限。这里只负责把
 * 已算好的选项渲染成选择器，状态与副作用仍留在调用方 —— 因此全部通过 props 传入，组件本身
 * 不持有任何 hook。
 */
import { AssistantModelSelector } from "@woohaa3/ui/assistant";
import type { AgentReasoningEffort } from "@woohaa3/contracts";

export type AuthoringModelSelectorProps = {
  model: string;
  /** 本次创作已绑定助手时的模型：选项一律禁用、文案不引导用户去选。 */
  delivery: boolean;
  toolDefault: boolean;
  modelOptions: readonly { id: string; label: string }[];
  invalidModel: boolean;
  /** 目录是否正在为当前 来源:连接 读取模型。 */
  loading: boolean;
  modelError: string | undefined;
  open: boolean;
  disabled: boolean;
  effort: string;
  supportedEfforts: readonly string[];
  invalidEffort: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectModel: (value: string) => void;
  onSelectEffort: (value: string) => void;
};

export function AuthoringModelSelector({
  model,
  delivery,
  toolDefault,
  modelOptions,
  invalidModel,
  loading,
  modelError,
  open,
  disabled,
  effort,
  supportedEfforts,
  invalidEffort,
  onOpenChange,
  onSelectModel,
  onSelectEffort
}: AuthoringModelSelectorProps) {
  return (
    <AssistantModelSelector
      label="模型"
      model={model}
      placeholder={delivery ? "本次模型" : undefined}
      keepOpenOnModelSelect
      options={[
        {
          value: "",
          label: toolDefault
            ? "跟随工具设置"
            : modelOptions.length
              ? "选择模型"
              : loading
                ? "正在读取模型…"
                : modelError
                  ? "模型读取失败"
                  : "暂无可用模型",
          disabled: !toolDefault && !modelOptions.length
        },
        ...(invalidModel
          ? [
              {
                value: model,
                label: delivery ? model : `${model}（已不可用）`,
                disabled: true
              }
            ]
          : []),
        ...modelOptions.map((entry) => ({ value: entry.id, label: entry.label }))
      ]}
      open={open}
      onOpenChange={onOpenChange}
      disabled={disabled}
      onChange={onSelectModel}
      variant={
        supportedEfforts.length || invalidEffort
          ? {
              value: effort,
              options: [
                { value: "", label: "默认" },
                ...(invalidEffort
                  ? [
                      {
                        value: effort,
                        label: delivery ? effort : `${effort}（已不可用）`,
                        disabled: true
                      }
                    ]
                  : []),
                ...supportedEfforts.map((value) => ({ value, label: value }))
              ],
              onChange: (value) => onSelectEffort(value as AgentReasoningEffort | "")
            }
          : undefined
      }
    />
  );
}
