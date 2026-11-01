/**
 * 资源驻留的聚焦目标推导（从 `host.ts` 的私有方法原样移出，行为不变）。
 *
 * 移出原因只是 file-budget：`host.ts` 曾越过 800 物理行上限。这两个函数只把若干显式的
 * 目标 id 收成集合，不碰实例状态、不读画布，因此做成纯函数放在类外面更清楚。
 */

export type FocusResidencyInputs = {
  /** 当前三维聚焦节点（未聚焦为 null）。 */
  modelFocusNodeId: string | null;
  /** 当前图片聚焦目标。 */
  imageFocusTargetId: string | null;
  /** 当前视频聚焦目标。 */
  videoFocusTargetId: string | null;
  /** 当前动画播放节点。 */
  animationNodeId: string | null;
  /** 当前悬停节点。 */
  hoverNodeId: string | null;
  /** 视频聚焦纹理所属节点。 */
  videoTextureNodeId: string | null;
  /** 图片聚焦纹理所属节点。 */
  imageTextureNodeId: string | null;
  /** 模型聚焦时的合成焦点上下文展开（调用方算好传入）。 */
  compositeFocusIds: readonly string[];
};

/**
 * 当前必须优先驻留的节点（interactive 用途）。
 *
 * 只含聚焦/播放/捕获目标：选中上千节点只提升优先级，不把全部选中项变成不可淘汰 pin
 * （change: 2026-10-23 design D1/D3）。
 */
export function residencyInteractiveNodeIds(input: FocusResidencyInputs): readonly string[] {
  const ids = new Set<string>();
  const add = (nodeId: string | null | undefined) => { if (nodeId) ids.add(nodeId); };
  add(input.modelFocusNodeId);
  for (const id of input.compositeFocusIds) add(id);
  add(input.imageFocusTargetId);
  add(input.videoFocusTargetId);
  add(input.animationNodeId);
  add(input.hoverNodeId);
  add(input.videoTextureNodeId);
  add(input.imageTextureNodeId);
  return [...ids];
}

/**
 * 显式 pin（聚焦/捕获过渡期间保留目标卡片与过渡表示）。
 *
 * 有界：只包含当前聚焦目标，不随选择集增长；退出聚焦即自动释放。
 */
export function residencyPinnedNodeIds(input: {
  modelFocusNodeId: string | null;
  imageFocusTargetId: string | null;
  videoFocusTargetId: string | null;
}): readonly string[] {
  const ids = new Set<string>();
  const add = (nodeId: string | null | undefined) => { if (nodeId) ids.add(nodeId); };
  add(input.modelFocusNodeId);
  add(input.imageFocusTargetId);
  add(input.videoFocusTargetId);
  return [...ids];
}
