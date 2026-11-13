/**
 * 节点类型 → 执行面板类型（change: add-image-text-node-execution，任务 3.3）。
 *
 * 映射表只有这一份：`image -> image-generation`、`text -> text-generation`，
 * 其它节点类型没有执行入口。反向映射也在这里，避免调用方自己写 if。
 */
import { NODE_TYPE_TO_TASK_KIND,
  TASK_KIND_TO_MODEL_TYPE,
  type CanvasTaskKind,
  type CanvasTaskModelType,
  type CanvasTaskNodeType } from "@woohaa3/contracts";

/** 执行面板类型就是任务类型；这里起个别名让宿主侧读起来更清楚。 */
export type NodePanelKind = CanvasTaskKind;

/** 节点类型 → 面板类型；不支持的类型返回 `null`（页面不显示执行面板）。 */
export function panelKindForNodeType(
  nodeType: string | null | undefined
): NodePanelKind | null {
  if (!nodeType) return null;
  return (NODE_TYPE_TO_TASK_KIND as Record<string, CanvasTaskKind | undefined>)[nodeType] ?? null;
}

/** 面板类型 → 节点类型（提交请求里要带上节点类型）。 */
export function nodeTypeForPanelKind(kind: NodePanelKind): CanvasTaskNodeType {
  switch (kind) {
    case "image-generation":
      return "image";
    case "video-generation":
      return "video";
    case "motion-generation":
      return "motion";
    case "audio-generation":
      return "audio";
    case "text-generation":
    default:
      return "text";
  }
}

/** 面板类型 → provider 模型类型。 */
export function modelTypeForPanelKind(kind: NodePanelKind): CanvasTaskModelType {
  return TASK_KIND_TO_MODEL_TYPE[kind];
}
