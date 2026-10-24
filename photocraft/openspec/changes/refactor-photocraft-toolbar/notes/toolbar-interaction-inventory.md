# 工具栏交互盘点（重构前的权威对照）

本文件是 `refactor-photocraft-toolbar` 的输入，不是实现规格。规格条款见
[delta spec](../specs/editor-workspace/spec.md)，做法见 [design](../design.md)。

两处权威来源：

- 上游 UI：`crates/ui-egui/src/panels.rs`（`TOOL_SECTIONS`、`toolbar()`、`slot_tool()`、
  `visible_sections()`、`tool_flyout_drag_open()`、`tool_flyout_release()`、`color_chips()`）、
  `crates/ui-egui/src/state.rs`（`Tool::ALL` 67 项、`Tool::key()`、`Tool::label()`）、
  `crates/ui-egui/src/tool_memory.rs`、`crates/ui-egui/src/tool_shortcuts.rs`、
  `crates/ui-egui/src/shortcuts.rs`、`crates/ui-egui/src/spring_tools.rs`。
- 本仓库现状：`packages/editor/src/photo-editor-chrome.tsx`（`PHOTO_TOOLS`、
  `EditorToolRail`）、`marquee-tool-group.tsx`、`retouch-tool-group.tsx`、
  `text-tool-group.tsx`、`retouch-tools.ts`、`photo-editor-shortcuts.ts`、
  `photo-editor-app.tsx`、`tool-option-memory.ts`、`command-search.tsx`、`tool-reset.tsx`。

## 1. 上游工具栏的权威结构

`TOOL_SECTIONS` 是 5 段 21 个槽位。槽位（slot）是 flyout 的边界，段（section）是细线分隔的
边界。下表同时给出本产品当前是否支持，以及槽位顺序与快捷键循环顺序的差异。

| 槽位 | 段 | 成员（flyout 顺序） | 本产品支持 | 组键 | 循环顺序 |
| --- | --- | --- | --- | --- | --- |
| 0 | 1 | Move, Artboard | Move | V | V: Move, Artboard |
| 1 | 2 | RectMarquee, EllipseMarquee, SingleRowMarquee, SingleColumnMarquee | 全部 | M | M: Rect, Ellipse（行列无键） |
| 2 | 2 | Lasso, PolygonLasso, MagneticLasso | Lasso | L | L 全部 |
| 3 | 2 | ObjectSelection, QuickSelection, MagicWand | MagicWand | W | W: MagicWand 在前（`Tool::ALL` 序） |
| 4 | 2 | Crop, PerspectiveCrop, Slice, SliceSelect | 无 | C | — |
| 5 | 2 | Frame | 无 | K | — |
| 6 | 2 | Eyedropper, ColorSampler, Ruler, Note, Count | Eyedropper | I | I 全部 |
| 7 | 3 | Remove, SpotHealing, Healing, Patch, ContentAwareMove, RedEye | SpotHealing, Healing, RedEye | J | J 全部 |
| 8 | 3 | Brush, Pencil, MixerBrush, ColorReplacement | 全部 | B | B 全部 |
| 9 | 3 | CloneStamp, PatternStamp | 全部 | S | S 全部 |
| 10 | 3 | HistoryBrush | 支持 | Y | — |
| 11 | 3 | Eraser, BackgroundEraser, MagicEraser | 全部 | E | E 全部 |
| 12 | 3 | Gradient, PaintBucket | PaintBucket | G | G 全部 |
| 13 | 3 | Blur, Sharpen, Smudge | 全部 | 无（`'\0'`） | 不参与循环 |
| 14 | 3 | Dodge, Burn, Sponge | 全部 | O | O 全部 |
| 15 | 4 | Pen, FreeformPen, CurvaturePen, AddAnchorPoint, DeleteAnchorPoint, ConvertPoint | 无 | P | — |
| 16 | 4 | Type, VerticalType, VerticalTypeMask, HorizontalTypeMask | Type, VerticalType | T | T: Type, VerticalType, HorizontalTypeMask, VerticalTypeMask |
| 17 | 4 | PathSelection, DirectSelection | 无 | A | — |
| 18 | 4 | Rectangle, EllipseShape, Triangle, Polygon, Line, CustomShape | 无 | U | — |
| 19 | 5 | Hand, RotateView | Hand | H / R | H: Hand；R: RotateView（不同键，不构成组） |
| 20 | 5 | Zoom | Zoom | Z | — |

**槽位顺序 ≠ 循环顺序。** 槽 16 的 flyout 是 `… VerticalTypeMask, HorizontalTypeMask`，而
`shortcuts.rs` 的循环组取 `Tool::ALL` 序（`… HorizontalTypeMask, VerticalTypeMask`）。槽 3 同理：
flyout 是 `ObjectSelection, QuickSelection, MagicWand`，循环是 `MagicWand` 在前。两者必须分别
保真，不能用一个数组兼任。

按本产品支持范围投影后，工具栏应为 5 段 16 个按钮：

```
段1  [移动]
段2  [选框▾] [套索] [魔棒] [吸管]
段3  [修复▾] [画笔▾] [仿制▾] [历史记录画笔] [橡皮▾] [油漆桶] [模糊▾] [减淡▾]
段4  [文字▾]
段5  [手形] [缩放]
```

槽 1、7、8、9、11、13、14、16 投影后仍有多个可见成员，才画 flyout 三角；槽 0、2、3、6、10、
12、19、20 投影后只剩一个可见成员，按上游 `slot.len() > 1` 规则不画三角、不弹 flyout。

按本产品支持范围投影后有 **15 个字母键**：其中 7 个是可循环组（M/J/B/S/E/O/T），8 个只有一个
可见成员（V/L/W/I/Y/G/H/Z）。槽 1 有 4 个可见成员，但只有矩形与椭圆有组键，因此 M 只在两者
之间循环，单行/单列仅从 flyout 进。

## 2. 上游的槽位与 flyout 机制

实现集中在一个循环里，语义如下（行号指 `panels.rs`）：

1. **可见性投影**（`visible_sections`，62–80）。先按被隐藏的工具名过滤每个槽，槽空则丢弃，
   段内槽全空则整段丢弃；每个槽携带它在 `TOOL_SECTIONS` 中的**原始下标**，因此隐藏别的槽不会
   让某个槽丢失记住的工具或改变 flyout 身份。
2. **槽位显式工具**（`slot_tool`，49–55）。当前工具属于该槽时，显示它并把该槽的记忆更新为它；
   否则显示该槽上次记住的工具；再否则显示 `slot[0]`。
3. **高亮**。`sel = slot.contains(app.ui.tool)` —— 组内**任一**成员是当前工具，按钮即高亮。
4. **提示**。`"<工具名>  (<快捷键>)"`，快捷键经 `tool_shortcuts::shortcut` 解析（可被用户重绑，
   未重绑用 `Tool::key()` 默认值；`'\0'` 的工具不显示括号）。
5. **单击**。选择当前显示的工具。若这次按下正处于「长按/拖出已开 flyout」的持有态
   （`held_id`），则单击不选择。
6. **双击**。Hand 双击选工具并跑 `view.fitOnScreen`；Zoom 双击选工具并跑 `view.actualPixels`。
7. **flyout 打开条件**（`slot.len() > 1` 且非「再点关闭」）：右键；按住 ≥ 0.35s；按下后指针
   离开按钮矩形（`tool_flyout_drag_open` = 主键按下 && 按下原点在按钮内 && 当前指针在按钮外）。
8. **再点关闭**（#4932）。自己的 flyout 已开时，再点该按钮（左键或右键）关闭；用于结束长按的
   那次释放不算。
9. **长按即选中**（#4453）。长按打开期间按钮显示的工具会被选中。
10. **拖出释放选取**（`tool_flyout_release`）。释放位置命中某行且本次手势起于按钮，则选中该行。
11. **关闭**。flyout 与其按钮之外的任何按下、或 Escape，关闭。
12. **无提示态**。flyout 打开时、或任一指针键按下时，不显示任何工具 tooltip。
13. **列布局**。`toolbar_double` 决定宽度 `w1` 或 `w1 + bx + 2`；段内槽按 2 个一行分块；
    非 Pro 主题在段间画一条细线并留 4pt；Pro 主题合并成一段、无分隔线。
14. **固定页脚**。工具列可滚动，滚动区高度 = 可用高度 − 页脚；页脚自下而是颜色块、
    Quick Mask 按钮、屏幕模式按钮。
15. **颜色块**。前景/背景色块叠放，点击任一色块打开对应 Color Picker；旁/上是默认色与交换色
    控件。
16. **Quick Mask**。工具列底部的按钮切换快速蒙版，提示文案随状态在
    `Edit in Quick Mask Mode (Q)` / `Edit in Standard Mode (Q)` 之间切换。
17. **屏幕模式**。单击循环三种模式；右键或长按展开三模式列表；展开用的那次释放不算循环。
18. **Edit Toolbar…**。工具列末尾的省略号按钮打开 `edit.toolbar` 对话框（本产品明确不支持，
    见 I108）。

### 快捷键组

- 组由 `Tool::key()` 决定，同键工具构成一个循环组（表中「循环顺序」列）。
- `Preferences › Tools › Use Shift Key for Tool Switch` **默认开启**：普通按字母 = 回到该组的
  上次工具（`group_tool(key)`，无记录则组首），**Shift+字母** = 在组内循环。
- 关闭该偏好后：普通按字母即循环。
- `Blur/Sharpen/Smudge` 与 `Single Row/Column Marquee` 的键为 `'\0'`：只能从 flyout 进，
  不参与任何字母循环。
- 按住工具键 ≥ 0.3s，或按住期间使用了画布，则这次切换是**临时**的：松开还原原工具及其选项。
  普通轻点不按住则保持（`spring_tools.rs`）。Shift/Option 组合的切换不临时。
- 字母键重复事件被丢弃，不得当成连击去循环组。

### 工具记忆

- `selected_tool`：当前工具，指针抬起后写盘，下次启动恢复。
- 每槽记住的工具：`slot_tool` 里按槽写临时态；`group_tools` 按组键记住上次工具，供字母键
  回到组内上次项。
- 每个绘画工具自己的笔头（`tool_brushes`）与选项（`tool_options`，只存与默认不同的字段）
  分别持久化；恢复时逐字段校验并把数值夹紧到该字段允许的范围，坏字段回落默认而不整体失败。

## 3. 当前实现盘点

### 3.1 渲染结构

`EditorToolRail`（`photo-editor-chrome.tsx`）把 `PHOTO_TOOLS` 平铺进
`.photo-editor__tool-list`（一个 CSS grid）：

```ts
export const PHOTO_TOOLS = [
  { id: "move", … }, { id: "marquee", … }, { id: "lasso", … },
  { id: "magicWand", … }, { id: "brush", … }, { id: "pencil", … },
  { id: "eyedropper", … }, { id: "bucket", … }, { id: "eraser", … },
  { id: "retouch", … }, { id: "text", … }, { id: "pan", … }, { id: "zoom", … }
] as const;
```

`id` 命中特殊分支时才渲染 flyout 组件（`marquee` / `retouch` / `text`），其余渲染单个
`IconButton`。**没有段概念**：13 个按钮同属一个 grid，无分隔线，`:first-child` 也无分组语义。

### 3.2 差异清单

| # | 现象 | 上游 | 严重度 |
| --- | --- | --- | --- |
| G1 | 画笔与铅笔是**两个**一级按钮 | 同在槽 8，主图标随上次使用 | 高 |
| G2 | 16 个润饰工具塞进**一个** `retouch` flyout | 分属 7 个槽（7/8/9/10/11/13/14） | 高 |
| G3 | `retouch` 组里含 `eraser` 家族的 `backgroundEraser`/`magicEraser`，而 `eraser` 自己又在一级 | 三者同槽 11 | 高 |
| G4 | `colorReplacement` 在「润饰」组 | 属槽 8 画笔组 | 中 |
| G5 | 无段分隔线；`Pro` 与非 Pro 一致 | 非 Pro 段间细线，Pro 无 | 中 |
| G6 | 无「每槽记住的工具」；改用全局 `ellipse`/`marqueeLine`/`retouchTool` | 每槽独立记忆 | 中 |
| G7 | 文字组显示的是**文字草稿的 orientation**，不是该槽上次所选工具 | 每槽上次工具 | 低 |
| G8 | `retouch` 组按钮的可访问名固定为「润饰」，不反映当前子工具；16 个工具在无障碍与提示层共用一个名字 | 按钮名 = 该槽当前工具名 | 中 |
| G9 | `Shift+M` 循环**四**个成员（矩形→椭圆→单行→单列） | M 只循环矩形/椭圆；行列无键 | 中 |
| G10 | `Shift+L`、`Shift+E`、`Shift+T` 等被解析器直接丢弃（只在 `!shiftKey` 或 `marquee`/`brush` 特例下放行） | 所有组都支持 Shift 循环 | 高 |
| G11 | J/S/Y/O 组**没有任何键位**：`TOOL_KEYS` 里没有修复/仿制/历史/减淡组的字母，润饰工具只能用鼠标在 flyout 里点 | J/S/Y/O 分别循环对应组 | 高 |
| G12 | `decodeRememberedTool` 白名单不含 `retouch`，重开后退回 `marquee` | 记住当前工具（含所有绘画工具） | 中 |
| G13 | `command-search.tsx` 的工具清单漏 `magicWand`、`retouch` | 命令面板能切到所有工具 | 中 |
| G14 | `retouch` 与 `magicWand` 共用 `WandSparklesIcon`，两个不同入口同图标 | 每工具自己的图标 | 中 |
| G15 | 工具列底部的 Quick Mask 入口缺失（只有 Q 键与选择菜单） | 工具列底部有常驻按钮与状态提示 | 中 |
| G16 | 颜色块：宿主提供 Color Picker 端口时点击打开编辑器自有取色器，否则回落到原生 `<input type=color>` | 点击打开自有 Color Picker | —（既有等价，不改） |
| G17 | 双击 Hand/Zoom 有实现（`onDoubleClick`） | 一致 | — |
| G18 | 长按 350ms、拖出即开、右键切换、外部释放取消、Escape 关闭、再点关闭 | 一致 | — |
| G19 | 单/双列切换按钮在工具列**顶部**，用 `ChevronRightIcon` 旋转 180° | 头部 chevron，朝向随状态 | 低 |
| G20 | 无 `Edit Toolbar…` 按钮 | 有，打开自定义对话框 | 明确不支持（I108） |
| G21 | 无 flyout 三角的语义缺失：`text`/`retouch` 有三角，单成员按钮没有 | 仅 `slot.len()>1` 才画 | 已一致 |

### 3.3 为什么自动化检查没抓到

- `retouch-tools.test.ts` 断言 `retouchToolIds()` 长度为 16，把错误分组写成了预期。
- `marquee-tool-group.test.tsx` 只验证 flyout **机制**（长按/拖出/释放/Escape），不验证槽位
  **成员**，却被用于闭合「工具组 flyout」条目。
- `check-disposition-matrix.mjs` 校验命令白名单与证据路径存在，不校验 UI 结构。
- 基线原文其实已写明分组（"Brush 工具组 flyout"、"Clone Stamp 工具组 flyout"、
  "独立 History Brush"、"独立 Blur、Sharpen、Smudge 工具组"、"Dodge、Burn、Sponge 工具组"、
  "修复工具组"），但没有被当成结构规格使用。

## 4. 处置决定

1. **以槽位为唯一结构来源**：新建一份工具槽位注册表，逐项对应上游 `TOOL_SECTIONS`（含原始
   下标、槽内顺序、组键、循环顺序、支持状态），界面只做投影。未支持成员在注册表里标注
   `unsupported` + 理由，不渲染；支持范围变化时只改标注。
2. **把绘画工具提升为一级工具 id**。`retouch` 假工具下线，`colorReplacement`/`mixer`/
   `cloneStamp`/`patternStamp`/`historyBrush`/`spotHealing`/`healingBrush`/`redEye`/
   `backgroundEraser`/`magicEraser`/`blur`/`sharpen`/`smudge`/`dodge`/`burn`/`sponge` 各自成为
   `PhotoEditorTool`。参数编译仍共用 `RETOUCH_SPECS`，但工具身份、快捷键组、记忆、选项栏、
   命令搜索、图标都按工具走。
3. **一个通用 flyout 组件**替换三个手写组件，行为（长按 350ms / 拖出 / 右键 / 释放选取 /
   外部释放取消 / Escape / 再点关闭 / 禁用与隐藏清理计时器）集中一处。
4. **快捷键改为组模型**：`TOOL_GROUPS` 由槽位注册表派生，字母 → 组；`useShiftForToolSwitch`
   默认开启时普通键回组内上次工具、Shift 键循环；`'\0'` 组不参与。
5. **不改能力白名单**：本重构不新增、不删除任何命令，只改入口结构与工具身份。
6. **不实现 I108**（工具栏逐项隐藏）与 I040（菜单自定义），保持明确不支持。
7. **补一道结构门禁**：把上游槽位表落成共享 fixture，投影结果与 fixture 比对；分组漂移即失败。
