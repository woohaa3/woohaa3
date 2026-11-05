/** Web 节点动作栏的描述与派发桥；随 canvas-shell 插件释放，不再供 renderer 消费。 */
import type { BevyNodeActionsPresentation } from "@woohaa3/contracts";

/** Web 按钮激活（`actionId` = 贡献 id；`menu` 为独立设置箭头）。 */
export type NodeActionHit = { nodeId: string; actionId: string; menu: boolean };

type Bridge = {
  toolbars: () => ReadonlyMap<string, BevyNodeActionsPresentation>;
  activate: (hit: NodeActionHit) => void;
};

let bridge: Bridge | null = null;

/** 安装桥（canvas-shell 插件注册时）；返回释放函数（幂等）。 */
export function setNodeActionBridge(next: Bridge | null): () => void {
  bridge = next;
  return () => {
    if (bridge === next) bridge = null;
  };
}

/** Web 横条描述；无提供者时为空。 */
export function readNodeActionToolbars(): ReadonlyMap<string, BevyNodeActionsPresentation> {
  return bridge?.toolbars() ?? EMPTY_TOOLBARS;
}

/** 命中派发；无提供者时静默忽略。 */
export function activateNodeAction(hit: NodeActionHit): void {
  bridge?.activate(hit);
}

const EMPTY_TOOLBARS: ReadonlyMap<string, BevyNodeActionsPresentation> = new Map();
