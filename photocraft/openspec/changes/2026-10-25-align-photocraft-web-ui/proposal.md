# 对齐 PhotoCraft Web 编辑器 UI

## Why

当前 `photocraft web` 的编辑器已经具备大量原生 PhotoCraft 的工具与面板能力，但 chrome 的布局承载、面板组织、工具参数栏、状态栏和控件密度仍与 `vendor/photocraft/crates/ui-egui` 的原生 UI 有可见差异。用户需要在同一套 PhotoCraft 语义下使用 Web 编辑器，不能因为宿主是浏览器而改变工具入口、面板分组和工作区操作习惯。

本 change 只处理编辑器 UI 对齐。文档工作区、多文档/标签以及顶部窗口标题栏不在范围内。画布区域恢复此前“直接镂空给画布”的嵌入设计：编辑器 chrome 从宿主内容矩形周围定位，画布占用宿主提供的内容矩形，不再由本 change 重做画布布局或渲染。

## What Changes

- 以原生 `panels.rs` 与 `dock.rs` 为结构基准，对齐选项栏、工具栏、右侧 dock、面板分组、状态栏、颜色/预设入口和显示控制。
- 保留现有上游工具槽位注册表和未开放能力门禁；补齐 Web chrome 中仍与原生结构不一致的显示、分段、按钮尺寸、flyout、工具重置和底部入口。
- 将右侧侧栏从固定的“属性 + 图层 + 历史”堆叠，整理为可折叠、可调宽度、可切换 Tab 的原生面板组模型，覆盖 Color、Properties、Character、Navigator、History、Layers、Brushes 及其已开放子面板。
- 让 Web 选项栏、工具栏、dock 和状态栏使用与原生 Pro/Studio 密度相对应的尺寸、间距、分隔线、滚动和面板菜单行为。
- 恢复嵌入场景的直接镂空布局：菜单/选项栏/工具栏/右侧面板/状态栏定位到宿主内容矩形外围；不在编辑器内部对画布再做一次 fit、背景或尺寸分配。
- 按原生 `menu_catalog.rs` 逐块整理十个菜单；补齐已开放操作的对话框、面板重开、图像模式和参考线入口，维持宿主文件操作边界。
- 修复真实 WASM 命令表、命令结果 JSON 解码和画笔预设加载；保留设备采样并按内核请求推进停留笔迹。
- 建立结构与视觉回归检查，确保 Web chrome 的分组、顺序、可见性和尺寸不会再次偏离上游。

## Non-goals

- 不改文档工作区、文档标签、多文档切换、文件打开/关闭或保存宿主流程。
- 不改顶部窗口标题栏、品牌标志、窗口拖拽、系统 caption buttons 或 workspace selector。
- 不重做画布渲染、缩放算法、选择、文字输入、背景图片或 GPU 路径；恢复直接镂空承载，并修复笔刷采样元数据、预设同步与停留采样调度。
- 不开放 `toolbar-slots.ts` 中已有的 unsupported 工具，不改变工程格式或扩大工具能力白名单。修复内核命令元数据、已有调整参数校验和画笔参数接线；新增只读 `strokeWantsTime` 桥接。
- 不追求 egui 的逐像素复制；对齐结构、密度、入口和交互语义，Web 控件仍使用公共 React UI primitives。

## Impact

主要影响 `photocraft/packages/editor/src/photo-editor.css`、`photo-editor-chrome.tsx`、`editor-sidebar.tsx`、`photo-editor-panels.tsx`、`photo-editor-app.tsx`、`editor-display.ts` 及新增的 dock/tab 面板组件和测试；嵌入定位涉及 `web/frontend/src/cordis/focus/workspace.tsx` 的公共内容矩形契约，但不改变其文档工作区语义。同步更新 `packages/editor/README.md`、`CODEMAP.md` 与本 change 的 editor-workspace delta spec。
