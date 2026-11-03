/**
 * 生成面板里的「图片 / 视频」切换（参考站输入框左下角的模式切换）。
 *
 * 只在**空节点**上可用：节点已经有结果、任务在途或画布只读时置灰并说明原因。切换是一条权威命令
 * （`node.update { nodeType }`），不是本地状态；成功后节点类型变了，面板随之换成另一类模型。
 */
import type { CanvasNodeData } from "@woohaa3/contracts";

export type SwitchableNodeType = "image" | "video";

const OPTIONS: ReadonlyArray<{ type: SwitchableNodeType; label: string }> = [
  { type: "image", label: "图片" },
  { type: "video", label: "视频" }
];

/** 在途的任务状态：此时切换会让回流结果写进错误类型的节点。 */
const IN_FLIGHT = new Set(["pending", "queued", "processing", "running"]);

/**
 * 为什么现在不能切换；可以切换返回 `null`。与权威 reducer 的拒绝条件一致，
 * 这里提前置灰只是为了让用户在点之前就知道原因，权威判断仍在命令里。
 */
export function retypeBlockReason(nodeData: CanvasNodeData | undefined, writable: boolean): string | null {
  if (!writable) return "当前会话不可写（画布只读）";
  const data = (nodeData ?? {}) as Record<string, unknown>;
  if (typeof data.outputAssetId === "string" && data.outputAssetId !== "") return "已有结果的节点不能切换类型，请新建节点";
  if (data.mediaContent !== undefined && data.mediaContent !== null) return "已有内容的节点不能切换类型，请新建节点";
  if (typeof data.taskStatus === "string" && IN_FLIGHT.has(data.taskStatus)) return "正在生成，暂时不能切换类型";
  return null;
}

type Props = {
  current: SwitchableNodeType;
  /** 不能切换的原因；`null` 表示可以。 */
  blockedReason: string | null;
  onSwitch: (next: SwitchableNodeType) => void;
};

export function NodeTypeSwitch({ current, blockedReason, onSwitch }: Props) {
  return (
    <div className="node-type-switch" role="group" aria-label="生成类型" title={blockedReason ?? undefined}>
      {OPTIONS.map((option) => {
        const active = option.type === current;
        return (
          <button
            key={option.type}
            type="button"
            className="node-type-switch__option"
            data-active={active ? "true" : undefined}
            aria-pressed={active}
            // 当前项永远可点（无操作）；另一项在不可切换时置灰。
            aria-disabled={!active && blockedReason !== null ? true : undefined}
            onClick={() => {
              if (active || blockedReason !== null) return;
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
