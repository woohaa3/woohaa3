# 任务

结构来源与现状对照见 [工具栏交互盘点](notes/toolbar-interaction-inventory.md)；
行为契约见 [delta spec](specs/editor-workspace/spec.md)；做法见 [design](design.md)。
逐项完成标准写在各自任务里；缺少真实设备（GPU/Pad/数位笔/系统输入法）的项按仓库规则
标注待人工，不作为本 change 的阻塞。

## 1. 槽位注册表与结构门禁

- [x] 1.1 从 `crates/ui-egui/src/panels.rs::TOOL_SECTIONS`（19–46 行）与 `state.rs::Tool::key()`
  手工抄录全部 5 段 21 槽 67 成员的段号、槽索引、槽内顺序、组键与循环序，写入
  `tests/fixtures/toolbar-slots.json`；文件头注释锚定上游行号。验证：JSON 可被 `JSON.parse`
  读取，且段数 5、槽数 21、成员数 67 与上游 `Tool::ALL` 长度一致。
- [x] 1.2 新增 `packages/editor/src/toolbar-slots.ts`，导出 `TOOL_SLOTS`（段/槽/成员/组键/
  循环序/未支持理由）与 `visibleToolSlots()` 投影函数（隐藏未支持成员、丢弃空槽与空段）。
  验证：投影结果段数 5、槽数 16，与盘点文档的 16 槽清单逐项相等。
- [x] 1.3 新增 `packages/editor/src/toolbar-slots.test.ts`，断言注册表与 fixture 的段数、槽索引、
  槽内成员顺序、组键、循环序完全一致；断言投影后的可见成员集合 = fixture 成员 − 未支持成员；
  断言每个未支持成员都带非空理由。验证：`pnpm -C packages/editor test toolbar-slots` 通过，
  且故意把 `pencil` 移出槽 8 时该测试失败。
- [x] 1.4 在 `tests/fixtures/toolbar-slots.json` 的未支持成员上写明产品/平台理由（画板需要新
  持久化结构、裁剪需要画布手势、路径需要矢量能力等），与差异矩阵对应条目一致。验证：
  `toolbar-slots.test.ts` 断言理由非空且不含「不支持」以外的占位词；与矩阵 I003/I024/I025/
  I026/I027 的理由逐条比对。

## 2. 工具身份归一

- [x] 2.1 在 `photo-editor-tools.ts` 的 `EditorToolId` 增加 16 个绘画工具 id 并删除 `retouch`；
  在 `photo-editor-shortcuts.ts` 的 `PhotoEditorTool` 同步。验证：`pnpm -C packages/editor run
  typecheck` 报出所有未更新的穷举点，逐处修完后通过。
- [x] 2.2 把 `retouch-tools.ts` 的 `RetouchToolId` 改为这 16 个 id 的子集并导出
  `isRetouchTool(id)` 判定；`RETOUCH_SPECS` 键与命令映射不变。验证：`retouch-tools.test.ts`
  改为断言 `retouchToolIds()` 长度 16 且每个 id 都在 `TOOL_SLOTS` 中有唯一归属槽位，不再断言
  「16 个同组」。
- [x] 2.3 `photo-editor-app.tsx`：删除 `retouchTool` 独立状态，改为按当前 `tool` 取
  `RETOUCH_SPECS`；绘制分派、Alt 取样、整笔提交、点按类单坐标的分支按新工具 id 判定。
  验证：新增 `photo-editor-app` 相关回归断言「每个绘画工具 id 按下并释放只派发一次对应命令，
  取消不派发」，以及 `tests/wasm-interactions.mjs` 冒烟仍覆盖 16 条 `paint.*` 命令。
- [x] 2.4 `decodeRememberedTool` 白名单补齐 16 个绘画工具，并把旧值 `"retouch"` 迁移为
  `"colorReplacement"`。验证：`tool-memory.test.tsx` 增加断言「读 `retouch` 得
  `colorReplacement`」「读 16 个新 id 均原样返回」「未知值回落 `marquee`」。
- [x] 2.5 `command-search.tsx` 的工具清单改为从 `TOOL_SLOTS` 派生，覆盖 `magicWand` 与全部绘画
  工具。验证：新增断言「命令面板工具条目集合 = 投影后工具栏成员集合」。
- [x] 2.6 `tool-reset.tsx` 的图标查找与 `photo-editor-tool-options.tsx` 的 `painting` 判定改为
  使用 `isRetouchTool` 与注册表；为修复、仿制、历史记录画笔、橡皮、模糊、减淡加深、油漆桶
  各提供一个独立图标并把 `retouch` 与 `magicWand` 的共用图标拆开。验证：断言工具栏内任意两个
  槽位按钮的图标组件互不相同；选项栏对每个绘画工具都渲染出对应分组。

## 3. 工具栏渲染重构

- [x] 3.1 新增 `packages/editor/src/tool-slot-button.tsx`，实现 design D3 的通用 flyout：
  右键展开、350ms 长按展开、按下拖出即开、拖出释放选取、外部释放取消、Escape 关闭、再点关闭、
  长按期间选中按钮成员、双击回调、只读/隐藏/卸载清理计时器。验证：新增
  `tool-slot-button.test.tsx`，把现 `marquee-tool-group.test.tsx` 与 `text-tool-group.test.tsx`
  的每条断言迁移过来并补「单成员槽右键不弹层」。
- [x] 3.2 重写 `EditorToolRail`：按 `visibleToolSlots()` 渲染段与槽，段间加分隔线并暴露
  `data-section` / `data-slot-index`；槽内任一成员命中即高亮；仅多成员槽画 flyout 三角与提示；
  颜色块、Quick Mask、屏幕模式固定在底部。验证：`photo-editor-chrome.test.tsx` 断言渲染出
  5 段 16 槽、按钮顺序等于投影、单成员槽无三角、画笔与铅笔同在一个槽内。
- [x] 3.3 删除 `marquee-tool-group.tsx`、`text-tool-group.tsx`、`retouch-tool-group.tsx` 与
  `PHOTO_TOOLS` 平铺数组，同步删除其测试文件。验证：`grep` 无残留引用；
  `pnpm -C packages/editor run typecheck` 与全量测试通过。
- [x] 3.4 `photo-editor.css` 增加段容器与分隔线样式，保留 36px 方形按钮、双列每行 2 个、
  工具区独立滚动、底部固定。验证：新增样式断言或可见性回归，确认双列下 16 槽不挤压底部颜色
  控件；单列/双列切换后段序不变（对应 spec「单列与双列顺序一致」）。

## 4. 槽位记忆与快捷键组

- [x] 4.1 新增每槽记忆（`slotTool`，键为槽索引）与每组记忆（`groupTool`，键为组字母），
  只通过「选中工具」这一个动作更新，写入 `localStorage` 的 `photocraft.tools.v1.` 命名空间且
  只存非默认项。验证：新增测试断言「画笔槽选铅笔 → 切到移动 → 回到画笔槽显示铅笔」「任一选择
  动作后两张表与当前工具一致」「记忆损坏时回落且不阻断」。
- [x] 4.2 `photo-editor-shortcuts.ts` 改为组模型：`TOOL_GROUP_KEYS` 从注册表派生（按循环序），
  `resolveEditorShortcut` 返回 `{kind:"toolGroup", key, cycle}`；选框组只含矩形与椭圆，单行/单列
  无组键，`Blur/Sharpen/Smudge` 也无组键。验证：新增 `photo-editor-shortcuts.test.ts` 覆盖
  15 个字母（V/M/L/W/I/J/B/S/Y/E/G/O/T/H/Z）与无键工具，其中 7 个多成员组（M/J/B/S/E/O/T）断言
  逐成员循环顺序、8 个单成员字母断言按键只回到该工具、单行/单列与模糊族断言不被任何字母选中；
  同时覆盖 Shift 开关两种偏好。
- [x] 4.3 `photo-editor-app.tsx` 按 design D5 的 `match group.iter().position(...)` 语义解析组
  切换，并让 `springTools` 的临时切换按同一组模型工作。验证：新增断言「按住组键并用画布后松开
  恢复原工具」「普通键回组内上次、Shift 循环」；`spring-tools.test.ts` 与
  `photo-editor-shortcuts` 组测试同时通过。
- [x] 4.4 工具提示与 flyout 行显示「工具名（组键）」，无组键工具不显示括号；flyout 行显示当前
  成员标记。验证：`tool-slot-button.test.tsx` 断言提示文本与无键工具不出现空括号。

## 5. 底部常驻入口与主题

- [x] 5.1 工具列底部新增 Quick Mask 按钮：读文档 `quickMask` 状态决定按下态与提示文案，点击
  派发既有 `select.editInQuickMaskMode` 命令；只读或手势中禁用。验证：断言点击派发一次、状态
  切换时提示在「以快速蒙版模式编辑（Q）」与「以标准模式编辑（Q）」间变化、禁用不分派。
- [x] 5.2 屏幕模式按钮迁到同一底部区域，单击循环、长按/右键展开列表、展开用的释放不循环。
  验证：迁移并扩展 `screen-mode-button` 相关断言，补「长按后释放不额外切换」。
- [x] 5.3 工具栏容器按段渲染时暴露 `data-section` 与槽位序号（design D1），使样式与回归测试都能
  按结构定位，不依赖子元素次序。验证：断言单列与双列下段数与槽序一致，且结构标识与注册表的
  段号/槽索引逐一对应。

## 6. 文档与矩阵回写

- [x] 6.1 更新 `openspec/specs/editor-workspace/spec.md`：把本 change 的 8 条 ADDED 要求并入
  主规格；既有「选框子工具记忆与蚂蚁线」场景保持不变（新增的快捷键组要求已覆盖 Shift+M 的循环
  范围）。更新 `packages/editor/README.md` 与根 `CODEMAP.md` 的工具栏所有权行（槽位注册表、
  通用 flyout、组键）。验证：`openspec validate --strict` 通过；`pnpm boundary:check` 通过；
  README/CODEMAP 中的文件路径逐一存在。
- [x] 6.2 回写 `2026-10-24-resolve-photocraft-interaction-gaps`：I004 处置改为「按上游槽位
  渲染 5 段 16 槽」并附 16 槽清单；I106 改为「8 组字母循环 + 无键槽」；I210 的证据改为通用
  flyout 测试并补「槽位成员正确」；I005–I015 与 I011 的证据从「润饰工具组」改为各自槽位。
  验证：`node scripts/check-disposition-matrix.mjs` 通过；新增证据路径均存在；矩阵统计数字与
  实际行数一致。
- [x] 6.3 在该 change 的 `verification.md` 记录本次判错原因与结构门禁的作用（为什么 599 个
  测试全绿仍未发现分组错误）。验证：记录含具体文件与批次记录号，且矩阵行引用可达。

## 7. 综合验收

- [x] 7.1 运行完整门禁：`pnpm -C packages/editor test`、`pnpm -C packages/editor run typecheck`、
  `pnpm run check`、`pnpm run rust:test`、`pnpm run wasm:smoke`、`pnpm boundary:check`、
  `openspec validate refactor-photocraft-toolbar --strict`。验证：全部通过，并在 verification
  记录命令与结果。
- [ ] 7.2 真实浏览器验收（待人工）：在 GPU 可用的桌面环境打开编辑器，逐段核对 5 段 16 槽、
  8 个 flyout 的成员与顺序、长按/拖出/右键/再点关闭、J/S/Y/O 与 Shift 循环、快速蒙版按钮提示
  切换、单双列切换后布局。验证：截图或录屏与盘点文档逐项对照，记录设备与系统；无 GPU 时保持
  待人工，不以软件渲染代替。
- [x] 7.3 跨工具参数隔离验收：逐一选用 16 个绘画工具，确认选项栏分组、笔头记忆、命令派发与
  状态栏工具名各自正确，且互不串用（原本共用一个「润饰」状态时无法区分）。验证：自动化断言
  每个工具的参数编译只读取该工具自己的字段；真实笔迹画面待人工。
