# 设计：对齐 PhotoCraft Web 编辑器 UI

## Context

原生 UI 的结构来源为：

- `vendor/photocraft/crates/ui-egui/src/panels.rs`：标题栏以下的 options bar、toolbar、status bar 与右侧 dock。
- `vendor/photocraft/crates/ui-egui/src/dock.rs`：Color、Properties、Character、Navigator、History、Layers、Brushes 组、Tab、折叠、顺序和尺寸策略。
- `packages/editor/src/toolbar-slots.ts`：已迁移的工具槽位结构，继续作为 Web 工具栏唯一数据来源。

Web 当前已有部分面板和显示状态，但 `EditorSidebar` 将它们直接拼成固定纵向树，且嵌入 workspace 的 chrome 通过公共内容矩形参与布局。目标是把 chrome 与画布承载解耦：画布矩形由宿主提供，编辑器 chrome 通过负向外扩定位到矩形外围。

## Decisions

### D1 保留宿主内容矩形，恢复直接镂空画布

编辑器根节点在嵌入模式下只占宿主提供的画布内容矩形。菜单栏、选项栏、工具栏、右侧 dock 和状态栏使用 `position:absolute` 与 `--focus-tools`、`--focus-toolbar`、`--focus-panel-width` 等已声明的 chrome 尺寸向外定位。画布不再被 `.photo-editor` 的 flex 子布局重新分配，也不在编辑器内部做第二次 fit。

`renderCanvasBackground`、`PhotoCanvas` 的 viewport 和宿主 Bevy 内容矩形保持现有端口；本 change 只调整 chrome 的占位和 CSS 定位。需要保留独立 dev 宿主的普通 flex 布局，因此两种模式用明确的根节点标记区分。

### D2 以原生 Group/Tab 模型实现右侧 dock

新增纯 UI 组投影模型：

```ts
type PanelGroupId = "color" | "properties" | "character" | "navigator" | "history" | "layers" | "brushes";
type PanelGroup = { id: PanelGroupId; tabs: PanelTab[]; visible: boolean; collapsed: boolean; height?: number };
```

- 组顺序默认为原生 Essentials 顺序，并在右侧纵向停靠；同组存在多个已实现 Tab 时才显示 Tab 条。
- 每组只注册 Web 已实现的 Tab；未实现 Tab 不渲染，也不制造空占位。
- 组标题、Tab 条、组菜单、折叠按钮、组间拖拽和高度调整都属于 `EditorSidebar`/dock 层，不进入文档内容或历史。
- Layers 保持底部填充优先策略；组高度遵守原生最小值，列表内容自行滚动。
- Properties 在嵌入模式仍可以由宿主显示为独立浮动面板，但其内部 Tab 和状态来源与 dock 相同。

### D3 选项栏和工具栏按上游密度投影

- 选项栏保留当前工具参数组件，但统一工具图标、重置入口、分隔线、滚动方向、控件高度和窄版策略。
- 工具栏继续从 `visibleToolSections()` 渲染；按原生段顺序显示分隔线，单列/双列只改变列数，不改变槽位顺序。
- 颜色、快速蒙版、屏幕模式和面板入口放在工具栏底部固定区；工具列表单独滚动。
- 单成员槽不显示 flyout 指示，多成员槽显示原生方向指示；通用 `ToolSlotButton` 继续是唯一 flyout 实现。

### D4 状态栏对齐信息职责

状态栏保留 Web 特有的宿主保存和错误信息，但顺序按原生调整为：缩放 → 色彩模式/位深 → 文档尺寸 → 图层数 → 状态/任务 → 尾部操作。Fit、进度和后台状态只在对应能力存在时显示，不为不存在的宿主任务伪造进度。

### D5 视觉 token 与尺寸基线

新增 chrome 尺寸 token，按普通/紧凑模式提供：菜单栏、选项栏、工具栏、dock、状态栏、Tab strip、控件高度和分隔线颜色。组件不得在 JSX 中散落固定像素；CSS 负责密度和主题适配。验证以结构快照和关键 computed-style 断言为主，避免测试绑定浏览器字体的像素差异。

### D6 不把原生未开放能力伪装成 Web 入口

面板和工具都从 capability/visible projection 派生。原生有但 Web 未开放的 Tab、工具或面板动作继续不渲染；右侧组只在至少有一个可用 Tab 时出现。菜单中已有的 Web/宿主入口保持原语义。

## Risks / Trade-offs

- dock 从固定堆叠改为组模型会影响已有面板布局记忆；迁移只读取已有 `panelLayout` 的宽度、分割和浮动字段，未知组状态使用默认值，不修改工程内容。
- chrome 向外镂空后，宿主 focus workspace 的 z-index 和 overflow 可能暴露回归；增加嵌入模式 DOM/布局测试，并保留普通 dev 宿主的 flex 回归。
- 原生存在而 Web 未实现的 Tab 不能用空壳填充，否则会造成入口误导；因此组可见性必须由可用 Tab 集合决定。

### D7 菜单和已有能力的实际操作对齐

`photo-editor-menu.ts` 保存十个顶级菜单的静态 native 层级，`photo-editor-chrome.tsx` 投影 capability 与宿主动作。对话框复用宿主栈并在确认时检查 owner、修订/选择和顶层实例。图像模式直接使用 native 无参命令；新建参考线复用几何对话框生命周期。完整逐区块记录见 `ui-parity.md`。

### D8 真实 WASM 桥接与笔刷调度

所有普通命令响应在 `EditorHandle.execute` 解码一次 JSON。合成命令须与 native 命令拥有同样的必需元数据；menu 为空不代表不可供面板使用。预设加载使用 native `tools.setBrush({preset})`，保留其锁定/平滑语义，然后回填本地工具参数。

采样保存小数坐标和设备元数据；RAF 是否继续由 native `strokeWantsTime` 决定。Web 不复制喷枪或平滑算法，所有增量仍处于同一候选，结束只提交一次，取消停止调度并丢弃候选。

### D9 面板与工具交互回归

保持挂载的非活动 Tab 不应继续查询内核或视口；`active` 随组可见性、折叠和当前 Tab 改变，并取消待执行读取。工具组与槽位都记住成员身份而非丢失变体的工具 id，临时快捷键切换沿用 spring tool 生命周期。命令搜索的工具变体各有唯一标识，选择时携带 variant；精确名称优先于其他工具的子串，菜单路径按从父到子匹配。

### D10 以 4318 独立网页对照真实 Woohaa 入口

两端使用同一个 `PhotoEditorApp`，编辑器主题根自己声明字体，避免 Woohaa 的字体栈覆盖菜单和面板。普通选项栏为 52px，窄栏为 44px，与 `editorDisplayLayout` 的 96/88px 占位一致。

嵌入菜单、选项栏和状态栏横贯可用窗口；工具列与停靠侧栏从选项栏下沿开始。文档标签栏放在宿主已预留的内容矩形上方，不能再以文档流扣除一次高度。34/42px 标签栏和全屏隐藏状态共用局部高度变量，画布交互层始终等于宿主内容矩形。浮动侧栏仍由自身位置控制。
