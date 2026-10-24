# 修正 PhotoCraft 交互差异

## Why

2026-10-24 的 PhotoCraft 交互差异清单记录了 `photocraft-next` 与 Woohaa PhotoCraft 之间的 301 项静态差异，涉及工具、画布手势、图层、文件与多文档、文字、预设、工作区、偏好和性能入口。当前清单包含实现缺口、入口差异、运行环境限制及有意未开放的能力，不能把每条都直接解释成产品必须复制的功能。

本 change 以随附的 [原始差异清单](notes/interaction-differences-baseline.md) 为基线，并用 [差异处置矩阵](notes/disposition-matrix.md) 追踪。逐条确定产品处置并修正结果：符合 PhotoCraft 产品边界的差异补齐端到端交互；不适用或不承诺的能力记录理由、保持不可执行并在入口/状态上避免误导。不得只隐藏 UI 却留下可调用命令，也不得以静态源码差异宣称运行时行为已经核验。

## What Changes

- 建立 301 条差异到处置、实现批次、验收证据的追踪矩阵；每项均以补齐、已有等价行为、明确不支持或待运行时核验之一结案。
- 按交互域分批修正画布工具和手势、文档/文件/剪贴板、多文档与工作区、选择/导航、文字与字体、绘画/颜色/调整、图层/蒙版/样式、面板/历史/时间轴、偏好/性能及导入导出等行为。
- 所有新增或调整的写操作统一遵守现有文档目标、草稿、只读、取消、撤销/重做、资源预算和工程往返约束；工作区偏好不得意外进入工程内容身份。
- 对需要浏览器、Pad、GPU、数位笔、字体或外部应用的差异建立可复核的验证记录；静态检查不得替代实机验收。
- 更新 PhotoCraft 当前能力规格、受影响模块地图和包文档，使实现状态、命令可用性和公开入口一致。

## Capabilities

### Modified Capabilities

- `editor-workspace`：明确交互能力的端到端开放、未支持入口和差异处置约束；移除与本 change 选定范围冲突的首期硬性禁用项。
- `project-format`：新增持久化内容继续使用版本化能力协商和规范内容身份；纯工作区偏好不污染工程指纹。
- `project-verification`：新增/扩展资源和可编辑结构须先经过共享预算与能力核验，不能由 UI 可见性代替核验。

## Non-goals

- 不承诺逐字节或逐手势复刻 `photocraft-next`、Photoshop 或其专有能力；按 Woohaa PhotoCraft 的共享核心、Web/Pad 运行形态和产品边界决定支持范围。
- 不修改 `vendor/photocraft` 上游快照，不将 Woohaa 服务或宿主私有实现引入 PhotoCraft 核心。
- 不以本 change 自动引入账号、云存储、原生文件系统、安装包、应用商店或独立产品外壳；外部平台专属能力须有独立适配边界。
- 不把表中静态差异视为已确认的运行时缺陷；待核项须先按 design 中的证据规则复核。

## Impact

主要影响 `packages/editor`、`packages/protocol`、`rust`、`packages/project-verifier`、开发宿主、共享 fixture 与 PhotoCraft OpenSpec。需要宿主行为时只扩展 `integrations/woohaa` 的公共适配，不让核心反向依赖 Woohaa。具体文件和能力依赖在实施阶段按处置矩阵细化。
