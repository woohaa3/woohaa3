/**
 * 节点操作横条的宿主桥（canvas-shell → canvas-runtime）
 * （change: 2026-10-13-add-node-action-toolbar，任务 3.1/3.2/3.6 / design D6 修订）。
 *
 * 横条由 Bevy 绘制、Rust 命中，因此需要两个方向的跨模块调用：
 * - **下行**：`canvas-runtime` 每帧构建 render scene 时读取本帧横条描述（由 canvas-shell 从
 *   `canvas.node-action` 贡献聚合）；
 * - **上行**：`canvas-runtime` 把 Rust 命中的动作回传给 canvas-shell 派发。
 *
 * canvas-shell 是横条归属者（拥有贡献列表、选择、画布与写权限读取）；canvas-runtime 只消费本
 * 桥。桥是模块级单例，随插件 scope 释放清空。缺省无提供者时返回空描述、命中静默忽略——绝不
 * 回退 TS 几何。
 */
import type { BevyNodeActionsPresentation } from "@woohaa3/contracts";

/** Rust 命中回传（`actionId` = 贡献 id；`menu` 为独立设置箭头）。 */
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

/** 每帧横条描述（render scene `nodeActions`）；无提供者时为空。 */
export function readNodeActionToolbars(): ReadonlyMap<string, BevyNodeActionsPresentation> {
  return bridge?.toolbars() ?? EMPTY_TOOLBARS;
}

/** 命中派发；无提供者时静默忽略。 */
export function activateNodeAction(hit: NodeActionHit): void {
  bridge?.activate(hit);
}

const EMPTY_TOOLBARS: ReadonlyMap<string, BevyNodeActionsPresentation> = new Map();
