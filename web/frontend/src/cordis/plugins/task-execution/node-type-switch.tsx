/**
 * 生成面板里的「图片 / 视频」切换（参考站输入框左下角的模式切换）。
 *
 * 随时可切换，点另一项会发生什么由 `plan` 决定（见 `switch-node-type.ts`）：空节点原地改类型，
 * 已有结果的节点在旁边新建关联节点；只有画布只读或空节点正在生成时才置灰。
 */
import type { NodeTypeSwitchPlan, SwitchableNodeType } from "./switch-node-type.js";

export type { SwitchableNodeType };

const OPTIONS: ReadonlyArray<{ type: SwitchableNodeType; label: string }> = [
  { type: "image", label: "图片" },
  { type: "video", label: "视频" }
];

type Props = {
  current: SwitchableNodeType;
  /** 点另一项会发生什么：原地改类型 / 新建关联节点 / 不可切换。 */
  plan: NodeTypeSwitchPlan;
  onSwitch: (next: SwitchableNodeType) => void;
};

/** 悬停说明：新建关联节点时提前说清楚，免得用户以为原节点会被改掉。 */
function hintFor(plan: NodeTypeSwitchPlan, nextLabel: string): string | undefined {
  if (plan.kind === "blocked") return plan.reason;
  if (plan.kind === "create") return `会在旁边新建一个${nextLabel}节点，并把当前内容作为参考`;
  return undefined;
}

export function NodeTypeSwitch({ current, plan, onSwitch }: Props) {
  return (
    <div className="node-type-switch" role="group" aria-label="生成类型">
      {OPTIONS.map((option) => {
        const active = option.type === current;
        return (
          <button
            key={option.type}
            type="button"
            className="node-type-switch__option"
            data-active={active ? "true" : undefined}
            aria-pressed={active}
            title={active ? undefined : hintFor(plan, option.label)}
            // 当前项永远可点（无操作）；另一项只在不可切换时置灰。
            aria-disabled={!active && plan.kind === "blocked" ? true : undefined}
            onClick={() => {
              if (active || plan.kind === "blocked") return;
              onSwitch(option.type);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
