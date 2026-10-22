/**
 * 编辑器 UI primitives（自有实现，最小集）
 * （change: 2026-10-21-extract-photocraft-subproject，design D3/D6）。
 *
 * 这些组件原先在宿主 `shared/ui`；编辑器需要独立安装与构建，因此保留最小实现与样式。
 * 编辑器不抽全局设计系统：宿主仍可使用自己的 primitives。
 */
export * from "./Button.js";
export * from "./icons.js";
export * from "./Menu.js";
export * from "./Popover.js";
export * from "./Tooltip.js";
export * from "./UiProvider.js";
export * from "./Dialog.js";
