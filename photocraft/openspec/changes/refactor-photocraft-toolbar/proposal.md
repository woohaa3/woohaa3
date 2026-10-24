# 按上游槽位重构 PhotoCraft 工具栏

## Why

当前工具栏与 PhotoCraft `0.14.0` 的 `TOOL_SECTIONS` 结构不一致：画笔与铅笔被拆成两个一级按钮，而修复、仿制、历史记录画笔、模糊、减淡加深、橡皮等 16 个本应分属 7 个独立槽位的工具被合并进一个「润饰」flyout。功能命令都已接通，但**入口结构错了**，用户第一眼就能看到，而现有自动化检查（命令白名单、flyout 机制单测、矩阵门禁）都不校验槽位成员，因此 599 个测试全绿仍然漏掉了它。

基线文档本身已写明分组（"Brush 工具组 flyout"、"Clone Stamp 工具组 flyout"、"独立 History Brush"、"独立 Blur、Sharpen、Smudge 工具组"、"Dodge/Burn/Sponge 工具组"、"修复工具组"），但实现时被当成文字背景而不是结构规格。本 change 把工具栏的交互语义沉淀为规格，并以槽位为唯一结构来源重构实现。

## What Changes

- 新增工具槽位注册表：逐项对应上游 `TOOL_SECTIONS` 的段、槽、槽内顺序、原始下标、组键、循环顺序与支持状态；界面只做投影，未支持成员标注理由且不渲染。
- **BREAKING**（内部工具身份）：撤下伪工具 `retouch`，把 16 个绘画/润饰工具提升为各自的一级工具身份；参数编译仍共用 `RETOUCH_SPECS`，命令白名单不变。
- 槽位归位：画笔/铅笔/混合画笔/颜色替换同组；修复、仿制、历史记录画笔、橡皮、模糊、减淡加深各自独立成槽；油漆桶保持单成员；文字组只含横排/竖排。
- 段分隔线、槽位高亮（槽内任一成员命中即高亮）、flyout 三角（仅多成员槽）按上游投影。
- 新建通用 flyout 组件，替换三份手写实现，集中维护长按 350ms、拖出即开、右键切换、拖出释放选取、外部释放取消、Escape、再点关闭、禁用/隐藏/卸载清理。
- 每槽记住上次所用工具（替代全局 `ellipse`/`marqueeLine`/`retouchTool` 三元组作为显示来源）。
- 快捷键改为**组模型**：字母 → 组；`Use Shift Key for Tool Switch` 默认开启时普通键回组内上次工具、Shift 循环；`Blur/Sharpen/Smudge` 与单行/单列选框无组键；补齐 J（修复）、S（仿制）、Y（历史记录画笔）、O（减淡加深）四组键位。
- 修正 `Shift+M` 只循环矩形/椭圆（单行/单列仅从 flyout 进）。
- 工具列底部补常驻 Quick Mask 按钮，提示随状态在「以快速蒙版模式编辑（Q）」与「以标准模式编辑（Q）」间切换。
- 工具身份贯通：工具记忆、命令面板、重置当前工具、选项栏、状态栏工具名、图标都按真实工具；`retouch` 与 `magicWand` 不再共用图标。
- 新增结构门禁：上游槽位表落成共享 fixture，投影结果与 fixture 比对，分组或顺序漂移即失败；把「16 个润饰工具同组」这类断言替换为按槽位断言。

## Capabilities

### New Capabilities

无。工具栏属于既有 `editor-workspace` 能力范围内的交互结构，另开能力会与既有工具/快捷键条款割裂。

### Modified Capabilities

- `editor-workspace`: 新增 8 条工具栏要求（段与槽位组织、槽位分组、按钮指示、指针选择手势、快捷键组循环、槽位记忆、未开放成员不可见、底部常驻快速蒙版与屏幕模式）。既有「选框子工具记忆与蚂蚁线」场景只约定子工具状态共用，未约定 Shift+M 的循环范围；本次以新增的「工具快捷键 SHALL 按组循环」明确 M 只循环矩形与椭圆、单行/单列仅从 flyout 进，因此该既有场景无需改写内容。

## Impact

- `packages/editor/src`：`photo-editor-chrome.tsx`（工具列重写）、新增槽位注册表与通用 flyout 组件、`retouch-tool-group.tsx`/`marquee-tool-group.tsx`/`text-tool-group.tsx`（合入或删除）、`photo-editor-tools.ts` 与 `photo-editor-shortcuts.ts`（工具 id 与组键）、`photo-editor-app.tsx`（工具状态与派发）、`tool-option-memory.ts`、`command-search.tsx`、`tool-reset.tsx`、`photo-editor-tool-options.tsx`、`retouch-tools.ts`、`photo-editor.css`。
- `packages/editor` 测试：`photo-editor-chrome.test.tsx`、`retouch-tools.test.ts`、`marquee-tool-group.test.tsx`、`text-tool-group.test.tsx`、新增槽位契约测试与快捷键组测试。
- `tests/fixtures/`：新增工具栏槽位 fixture，供 TypeScript 契约测试读取。
- `openspec/changes/2026-10-24-resolve-photocraft-interaction-gaps`：I004、I106、I210 的处置与证据需按重构后的实际结构改写；I011 及 I005–I010、I012、I015 的证据需从「润饰工具组」改为各自的槽位。
- 不变：`rust/crates/editor-core/src/capability.rs` 的命令白名单、`vendor/photocraft` 上游快照、协议与工程格式。本 change 不新增持久化内容，工作区工具记忆仍不进内容指纹。
