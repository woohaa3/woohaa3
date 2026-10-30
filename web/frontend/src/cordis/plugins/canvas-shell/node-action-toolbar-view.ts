import { nodeCapabilityContext, type NodeCapabilityResolver } from "@woohaa3/contracts";
/**
 * 节点顶部操作横条的纯判定逻辑
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.1/3.2 / design D7）。
 *
 * 与 React/DOM 解耦，供宿主渲染与**非渲染回归**共用：只做「显示哪条横条」「下载是否可用」
 * 的纯数据判定，不测量 DOM、不触发布局、不写画布。几何定位由 contracts 的
 * `nodeActionToolbarLayout` 负责。
 */
import { isGlbModelNodeData, readGlbModelAssetId } from "@woohaa3/contracts";
import type { ServerCanvas } from "@woohaa3/contracts";
import { resolveNodeActionToolbarTarget, resolveSelectionActionToolbarTarget } from "@woohaa3/contracts";

export type NodeActionToolbarView = {
  nodeId: string;
  nodeType: string;
  writable: boolean;
};

/**
 * 解析当前是否显示多选动作横条及其目标
 * （change: 2026-10-16-add-group-selection-toolbar，design D1/D2）。
 *
 * 仅在**未聚焦**且选中 ≥2 个仍存在的节点时返回这些稳定 nodeId；单选、取消选择、进入聚焦工作区
 * 时返回 null（隐藏横条），但不因此取消任何已受理的后台工作。
 */
export function resolveSelectionActionToolbarView(input: {
  selectedNodeIds: readonly string[];
  nodes: readonly { id: string }[];
  focused: boolean;
}): { nodeIds: string[] } | null {
  if (input.focused) return null;
  return resolveSelectionActionToolbarTarget({ selectedNodeIds: input.selectedNodeIds, nodes: input.nodes });
}

/**
 * 解析当前是否显示横条及其目标：仅在**未聚焦**且**单选**一个适用类型节点时显示。
 *
 * 多选、取消选择、选中不适用类型或进入聚焦工作区时返回 null（隐藏画布横条），但**不**因此
 * 取消任何已受理的后台工作。来源 `nodeId` 在此固定，激活后不随 selection 变化。
 */
export function resolveNodeActionToolbarView(input: {
  selectedNodeIds: readonly string[];
  nodes: readonly { id: string; type: string }[];
  focused: boolean;
  writable: boolean;
  canvas?: ServerCanvas | null;
  nodeCapabilities?: NodeCapabilityResolver;
}): NodeActionToolbarView | null {
  if (input.focused) return null;
  const target = resolveNodeActionToolbarTarget({ selectedNodeIds: input.selectedNodeIds, nodes: input.nodes,
    ...(input.nodeCapabilities ? { accepts: (id: string) => {
      const context = input.canvas && nodeCapabilityContext(input.canvas, id);
      return !!context && !!input.nodeCapabilities!.resolve(context).actions?.accepts(context);
    } } : {})
  });
  if (!target) return null;
  return { nodeId: target.nodeId, nodeType: target.nodeType, writable: input.writable };
}

import { decideContentAction } from "@woohaa3/contracts";

/**
 * 容器「编辑」动作的目标：只有自带模型聚焦工作区的容器（片场）返回可进入的 kind。
 *
 * 按通用能力判定（group + focus.kind === "model"），宿主不按 film-set 业务 ID 分支；
 * 普通 group 的聚焦 kind 是 `extension`，不提供画布横条上的直接编辑入口。
 */
export function resolveContainerFocusEdit(input: {
  canvas: ServerCanvas | null;
  nodeId: string;
  nodeCapabilities: NodeCapabilityResolver;
}): "model" | null {
  const { canvas, nodeId, nodeCapabilities } = input;
  const context = canvas ? nodeCapabilityContext(canvas, nodeId) : null;
  if (!context || context.node.type !== "group") return null;
  return nodeCapabilities.resolve(context).focus?.kind(context) === "model" ? "model" : null;
}

/**
 * 依来源节点与**当前画布**判定「下载」是否可用；不可用时给出可读原因。
 *
 * 只读取内容就绪性（3D 有模型脚本、图片/视频有 ready 原资产），**不**检查画布写权限：
 * 可读取内容的下载 MUST NOT 被只读拒绝（design D7）。
 */
export function resolveNodeDownloadAvailability(input: {
  canvas: ServerCanvas | null;
  nodeId: string;
  nodeType: string;
  mediaContent?: Pick<import("../../../extension-api/media-content.js").MediaContentService, "state" | "describe">;
  content?: import("@woohaa3/contracts").ContentContributionResolver;
}): { available: true } | { available: false; reason: string } {
  const { canvas, nodeId, nodeType } = input;
  if (!canvas) return { available: false, reason: "作品尚未加载，暂时无法下载" };
  const data = canvas.nodeData[nodeId];
  if (input.content) {
    const decision = decideContentAction(input.content, "download", nodeType, data);
    if (!decision.allowed) return { available: false, reason: decision.reason };
  }
  if (nodeType === "model3d") {
    if (isGlbModelNodeData(data)) {
      const assetId = readGlbModelAssetId(data);
      const asset = canvas.assets.find((entry) => entry.id === assetId);
      return asset && asset.status === "ready"
        ? { available: true }
        : { available: false, reason: "模型资源尚未就绪，暂时无法下载" };
    }
    const script = (data as { modelScript?: unknown } | undefined)?.modelScript;
    return typeof script === "string" && script.trim() !== ""
      ? { available: true }
      : { available: false, reason: "模型尚无可下载的内容" };
  }
  if (nodeType === "image" || nodeType === "video") {
    if (data?.mediaContent) {
      try {
        const source = input.mediaContent?.describe(canvas, data.mediaContent, nodeType);
        const state = input.mediaContent?.state(nodeId);
        if (source && state?.status === "ready" && state.sourceIdentity === source.sourceIdentity && state.asset?.mediaKind === nodeType) return { available: true };
      } catch { /* A missing provider or stale source is not downloadable. */ }
      return { available: false, reason: "当前版本的资源尚未就绪，暂时无法下载" };
    }
    const assetId = (data as { outputAssetId?: unknown } | undefined)?.outputAssetId;
    const asset = canvas.assets.find((entry) => entry.id === assetId);
    if (!asset || asset.status !== "ready" || asset.mediaKind !== nodeType) {
      return { available: false, reason: "资源尚未就绪，暂时无法下载" };
    }
    return { available: true };
  }
  return { available: false, reason: "此类节点暂不支持下载" };
}
