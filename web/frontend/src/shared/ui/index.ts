/**
 * 生产 UI 基础组件公共入口（唯一允许 import Radix/Lucide 的目录）
 * （change: adopt-radix-lucide-canvas-ui，任务 2.6 / design D1；
 *   2026-10-10-extract-task-history-page：由 `cordis/ui/primitives` 迁到 `shared/ui`）。
 *
 * Plugin、Dialog 业务 renderer、独立页面与 Showcase **只从这里**获取 Button/IconButton/
 * Tooltip/Menu/Popover/DialogSurface/Tabs/SegmentedControl/Collapsible/ScrollArea 与
 * icon facade，不得直接 import `@radix-ui/react-*` 或 `lucide-react`。共享层不依赖页面、
 * Cordis 宿主或具体插件。
 */
export * from "./UiProvider.js";
export * from "./Button.js";
export * from "./Tooltip.js";
export * from "./Popover.js";
export * from "./Menu.js";
export * from "./Listbox.js";
export * from "./DialogSurface.js";
export * from "./Tabs.js";
export * from "./SegmentedControl.js";
export * from "./Switch.js";
export * from "./Collapsible.js";
export * from "./ScrollArea.js";
export * from "./icons.js";
export * from "./SettingsSection.js";
export * from "./FormControls.js";
export * from "./ServiceLogo.js";
