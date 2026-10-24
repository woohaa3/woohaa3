# 设计：按槽位重构工具栏

动机见 [proposal](../proposal.md)；行为契约见 [delta spec](../specs/editor-workspace/spec.md)；
现状与上游逐槽对照见 [工具栏交互盘点](../notes/toolbar-interaction-inventory.md)。

## Context

- 上游结构只有一个权威来源：`crates/ui-egui/src/panels.rs::TOOL_SECTIONS`（5 段 21 槽），
  叠加 `state.rs::Tool::key()` 决定字母组，`shortcuts.rs` 用 `Tool::ALL` 序决定循环序。
- 当前实现把 13 个工具平铺成一个 grid，其中 `retouch` 是伪工具，携带 16 个 `RetouchToolId`；
  `marquee`、`text` 各自手写了一份 flyout 组件，加 `retouch` 共三份几乎相同的长按/拖出逻辑。
- 工具参数编译（`RETOUCH_SPECS`）已按工具分项，与命令一一对应；问题只在**工具身份与入口结构**。
- 工具 id 同时被 `EditorToolId`、`PhotoEditorTool`、`TOOL_KEYS`、`decodeRememberedTool`、
  `command-search` 工具清单、`tool-reset` 的图标查找、选项栏 `painting` 判定、状态栏工具名引用，
  任何扩 id 的改动都要同步这些点。
- 上游 `slot_tool` 的「每槽记住的工具」是 UI 内存态；`group_tools` 的「每组上次工具」是
  `shortcuts.rs` 的独立状态。两者不能共用一个变量。

## Goals / Non-Goals

**Goals:**
- 让工具栏结构成为**数据驱动的投影**，而不是渲染函数里的手写分支。
- 让工具身份与命令一一对应，消除伪工具 `retouch`。
- 把三份 flyout 实现收敛成一份，行为只有一处定义。
- 建立结构门禁，使「命令全通但分组错」这类回归无法再通过自动化检查。

**Non-Goals:**
- 不实现 I108（工具栏逐项隐藏）和 I040（菜单/工具栏自定义）。
- 不改颜色块到编辑器自有 Color Picker 的接线：宿主提供 `colorPicker` 端口时已走自有取色器，
  无端口时回落原生 `<input type=color>`，这是既有等价行为，本 change 不动。
- 不改任何内核命令、能力白名单、协议或持久化格式。
- 不实现 Sticky/Pad 特有的工具栏变体。
- 不追求像素级复刻上游 egui 皮肤，只复刻结构、手势与快捷键语义。

## Decisions

### D1 用一张槽位注册表作为唯一结构来源

新增 `toolbar-slots.ts`，把 `TOOL_SECTIONS` 逐项落成数据：

```ts
type ToolSlot = {
  /** 在 TOOL_SECTIONS 中的原始下标，flyout 身份与记忆键都用它。 */
  index: number;
  /** 段号，用于画分隔线。 */
  section: number;
  /** 槽内顺序 = flyout 顺序。 */
  members: readonly ToolSpec[];
};
type ToolSpec = {
  /** 稳定的工具 id，与命令/参数编译一一对应。 */
  id: PhotoEditorTool;
  label: string;
  icon: ComponentType<{size?: number}>;
  /** 组键；`null` 表示不参与字母循环。 */
  key: string | null;
  /** 未开放时给出理由，渲染与快捷键都省略。 */
  unsupported?: string;
};
```

段顺序、槽索引、成员顺序**全部照抄上游**，不在本模块里重排。循环顺序另存 `cycleOrder`，
因为上游 flyout 序与循环序不同（槽 16、槽 3）。

*替代方案*：在 `PHOTO_TOOLS` 里加 `group` 字段。否决——平铺数组无法表达「槽索引」与
「段内槽序」，且会让「一个工具属于哪个槽」与「槽在哪个段」两件事都退化成隐式约定。

*替代方案*：直接把上游 `TOOL_SECTIONS` 作为 JSON fixture，运行时读。否决——界面需要图标组件，
JSON 不能携带；fixture 只用做**校验**（D6），不用做渲染来源。

### D2 撤下伪工具 `retouch`，绘画工具都是一级工具

`PhotoEditorTool` 增加 16 个 id（`cloneStamp`、`healingBrush`、`colorReplacement`、`mixer`、
`patternStamp`、`historyBrush`、`spotHealing`、`redEye`、`backgroundEraser`、`magicEraser`、
`blur`、`sharpen`、`smudge`、`dodge`、`burn`、`sponge`），删除 `retouch`。

- `RETOUCH_SPECS` 保持为参数编译器，键类型从 `RetouchToolId` 改为这 16 个 id 的子集；
  `paint.*` 命令名不变，白名单不变。
- `photo-editor-app.tsx` 的 `if (tool === "retouch")` 分支改为
  `RETOUCH_SPECS[tool as RetouchToolId]` 判定，其余分支（画笔/铅笔/橡皮）不变。
- `buildRetouch` 的 `tool` 参数由当前工具 id 直接传入，不再维护独立的 `retouchTool` 状态。
- 选项栏 `painting` 判定改为「该工具在 `RETOUCH_SPECS` 中，或为 brush/pencil/eraser/bucket」。
- 迁移读：`decodeRememberedTool` 若读到旧值 `"retouch"`，映射为 `"colorReplacement"`
  （旧默认子工具），不报错、不只回落到 `marquee`。

*替代方案*：保留 `retouch` 作为「族 id」，槽位按钮只切族、族内再选子工具。否决——这正是当前
错误结构的来源：族与槽不是一一对应，7 个槽无法用 1 个族 id 表达。

### D3 一个通用 flyout 组件

`ToolSlotButton` 取代三份手写组件，对外只有：

```tsx
<ToolSlotButton
  slot={slot} active={tool}           // 高亮与按钮显示
  onChoose={(id) => ...}              // 选中某成员
  onPress={(id) => ...}               // 长按期间选中按钮显示的成员
  disabled/ hidden                    // 清理计时器与弹层
  onDoubleClick={(id) => ...}         // Hand/Zoom 双击
/>
```

内部维护：`open`、`anchor`、`timer`、`held`、`pressed`（pointerId）。
行为契约（350ms、拖出即开、右键切换、释放选取、外部取消、Escape、再点关闭、禁用清理）
只在这里实现一次，由单测直接覆盖。

*替代方案*：保留三份组件、各自加 `members` 参数。否决——bug 已在三处重复三次
（`onPointerLeave` 的 `pressed` 判定、`held` 复位时机），收敛才对。

### D4 每槽记忆与组循环记忆分开

- `slotTool: Record<number, PhotoEditorTool>` —— 每槽显示哪个成员，键是 `slot.index`。
  存 `localStorage`（`photocraft.tools.v1.slots`），只存非默认项。
- `groupTool: Record<string, PhotoEditorTool>` —— 每组上次工具，供字母键返回。
  同样本机持久化。
- 当前工具 `tool` 仍是**唯一事实源**，两者都是从 `tool` 派生的展示记忆：
  `slotTool[i]` 在选中该槽成员时更新；`groupTool[key]` 在选中任意工具时更新。
  不引入「按钮显示 ≠ 当前工具」的第二状态机。

*替代方案*：只用 `slotTool[slot]` 一个映射同时服务字母键。否决——槽 ≠ 组：槽 1（选框族）
   的键是 M，但单行/单列也在槽 1 却没有键；用槽当组会让 M 错误地循环到行列。

### D5 快捷键改为组模型

`photo-editor-shortcuts.ts`：

```ts
export const TOOL_GROUP_KEYS: readonly {key: string; group: readonly PhotoEditorTool[]}[] = ...
```

组由注册表派生（同 `key` 的成员按 **循环序** 排列）。
`resolveEditorShortcut` 不再返回单个 `tool`，而是 `{kind:"toolGroup", key, cycle}`；
App 侧解析成具体工具：

```
若当前工具属于该组：
  shiftSwitch && !shift  -> 当前工具（不动）
  shiftSwitch && shift   -> 组内下一个
  !shiftSwitch           -> 组内下一个（shift 也循环，等于原行为）
否则：
  组内上次工具（groupTool）或组首
```

这个分支与上游 `shortcuts.rs` 的 `match group.iter().position(...)` 逐行对应。

*兼容性*：`Blur/Sharpen/Smudge` 与单行/单列没有组键，`TOOL_GROUP_KEYS` 里不出现，
因此按 B/E/I/M 等不会误入。`Shift+M` 只循环矩形与椭圆，因为槽 1 的组只登记这两个成员。

*替代方案*：继续用 `TOOL_KEYS` 的「字母 → 单个工具」映射加特例分支。否决——特例已经导致
`brush` 一个特判、`marquee` 一个特判，再加 6 个组会变成不可维护的 switch。

### D6 结构门禁：fixture 与投影比对

`tests/fixtures/toolbar-slots.json` 记录上游权威结构：

```json
{
  "sections": [
    {"slots": [[{"id":"move","upstream":"Move","key":"V","cycleOrder":0}, ...]]}
  ]
}
```

`packages/editor/src/toolbar-slots.test.ts` 断言：
1. 项目内注册表的段数、槽数、槽内**上游成员顺序**与 fixture 一致；
2. 每个已支持成员的 `key` 与 `cycleOrder` 与 fixture 一致；
3. 投影后的工具栏恰好是 5 段 16 槽，且每槽的可见成员集合等于「fixture 成员 − 未支持成员」；
4. 未支持成员在每个槽都带上非空 `unsupported` 理由。

fixture 手工从 `panels.rs` 抄录并由测试注释指向行号，不在构建期解析 Rust 源码（避免跨语言构建
依赖）。

*替代方案*：测试里直接 import 一份 TS 常量再和自己比。否决——比较对象必须独立于被测数据。

### D7 未支持成员用标注表达，不删除

注册表列出**全部** 67 个成员的处理（已支持 / 未支持 + 理由），不支持者不渲染。
这样「支持范围扩大」是改一个标注，而不是回忆上游结构。同时与既有
`unsupported-closure.test.ts` 形成互补：那边管命令与菜单入口关闭，这边管工具栏不出现。

### D8 Quick Mask 进工具列底部

现有 `select.editInQuickMaskMode` 命令与 Q 快捷键都已在（I085），视图模型已有 `quickMask`。
本 change 只补一个常驻按钮：读 `documentView.quickMask` 决定按下态与提示文案，点击派发同一命令。
不改命令、不改内核。

## Risks / Trade-offs

- **工具 id 扩 16 个会波及多处判定** → 用类型把它变成编译错误：`EditorToolId` /
  `PhotoEditorTool` / `TOOL_KEYS` / 注册表全部穷举，漏一处则 `tsc --noEmit` 失败；不靠 grep。
- **`retouch` 旧记忆失效导致用户重开后工具变化** → `decodeRememberedTool` 显式映射旧值到
  `colorReplacement`，并在测试里固定这一迁移。
- **快捷键从「单工具」变「组」可能打断既有单选行为** → 先写组模型单测覆盖全部 8 个组与
  两个无键槽，再替换 `resolveEditorShortcut`；`springTools` 的临时切换路径同批覆盖。
- **fixture 手工抄录可能与上游漂移** → fixture 头部注释锚定 `panels.rs` 行号；上游快照
  变更时由 `vendor` 更新流程一并复核，测试失败信息会指出具体槽位。
- **D4 的两个记忆表可能不同步** → 只允许通过「选中工具」这一个动作更新两者，不提供独立写入；
  单测断言「任一选择动作后 `slotTool`/`groupTool` 与当前工具一致」。
- **段分隔线**：上游在 Pro 主题下省略分隔线；本产品只有一套主题，按「有分隔线」实现，并以
  `data-section` 暴露段结构。若将来加入无语义分隔的主题，只需在样式层隐藏线条，不必改结构。
- **视觉回归**：工具栏从 13 个按钮变 16 个按钮，双列占位宽度可能变化 → 布局宽度仍由
  `editor-display.ts` 的 `toolColumn`（52 / 92）决定，不改；新增按钮仍用 36px 方形，双列
  每行 2 个，行数从 7 变 8，仍可滚动。

## Migration Plan

1. 先落注册表 + fixture + 契约测试（不改渲染），测试以「当前实现不符」起步为失败基线，证明
   门禁有效。
2. 扩工具 id 与参数编译接线，保留 `retouch` 兼容读取；此阶段界面不变、测试全绿。
3. 引入 `ToolSlotButton` 与 `EditorToolRail` 重写，切换到注册表投影；删除三份手写组件与
   `PHOTO_TOOLS` 平铺数组。
4. 切换快捷键到组模型。
5. 补 Quick Mask 按钮、图标区分、命令面板与状态栏工具名。
6. 回写 `2026-10-24-resolve-photocraft-interaction-gaps` 的 I004/I106/I210 与 16 条绘画工具证据。

回滚：注册表与渲染都在 `packages/editor` 内，无持久化格式变化；回滚即恢复
`photo-editor-chrome.tsx` 与三个 flyout 组件，`localStorage` 中新增的 `slots`/`groups` 键被旧代码
忽略，不影响可用性。
