/**
 * 输入角色契约。
 *
 * 来源项目把该类型定义在 `task-contracts` 中，但那个模块同时聚合了生成模型目录与
 * prompt 片段，超出 Woohaa3 画布聚合的范围。这里只收敛画布所需的这一个中立类型。
 */
export type Woohaa3CanvasInputRole = string;

export type Woohaa3CanvasInputMapping = {
  slotId?: string;
  sourceNodeId: string;
  /** Optional stable subset of a multi-output source consumed by this input. */
  sourceAssetIds?: string[];
  role: Woohaa3CanvasInputRole;
  sortKey?: string;
  label?: string;
} & Record<string, unknown>;
