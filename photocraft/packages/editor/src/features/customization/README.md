# 定制域（U78 命令搜索与工作区定制）

change: `2026-10-22-add-photocraft-workspace-customization`。

## 职责

- 命令搜索：只索引内核命令表里 `allowed` 的记录，执行仍走 `EditorWorkspaceController.dispatch`
  的同一门禁（只读、草稿、冻结、未开放命令都在那里拒绝）。搜索不是第二条写入口。结果显示的是
  界面菜单的中文标签（`MENU_LABELS`），内核自报的英文名保留为关键字——否则中文用户搜「撤销」
  会 0 结果，而菜单里明明写着「撤销」。
- 本机偏好：快捷键覆盖、工具栏隐藏/顺序、菜单隐藏、工具选项记忆、命名工作区，版本化保存在
  `woohaa.image-editor.customization.v1`。偏好**不进入**工程字节、内容身份、历史或撤销栈。
- 命名工作区：保存当前自定义状态与面板几何快照；应用时把几何交回布局所有者。
- 外壳适配：把偏好翻译成共享外壳**已有**的分派/渲染形状，外壳不需要第二套实现。

## 模块

| 文件 | 内容 |
| --- | --- |
| `preferences.ts` | 组合键解析/规范化、出厂动作清单、冲突检测、解码/预算、`CustomizationStore`、按键匹配 |
| `command-palette.ts` | 模糊评分、`allowed` 过滤、中文标签替换（内核自报英文名保留为关键字）、最近使用、结果排序 |
| `panels.tsx` | 搜索/快捷键/工具栏/菜单/工作区/存储面板；导出走宿主端口或浏览器下载 |
| `sections.tsx` | 高级面板 section（菜单入口「窗口 ▸ 工作区、快捷键与命令搜索…」） |
| `workspace.ts` | 领域会话端口（偏好快照、订阅、按键解析、快捷键/工作区/工具选项、外壳适配转发） |
| `shell-adapter.ts` | 偏好 → `EditorShortcut`、完整按键解析（改绑后旧出厂组合失效）、菜单隐藏过滤、工具栏顺序、工作区面板几何、画笔选项恢复 |
| `use-customization-preferences.ts` | 外壳渲染用的偏好订阅 hook（变化即重渲染，快照引用稳定） |

## 外壳接入（已落地）

共享外壳已接入本域端口；下面记录每处接入口，便于后续改动对齐（回归见
`shell-consumption.test.tsx` 与 `integrations/woohaa/tests/customization-interaction.test.tsx`）。

1. `photo-editor-app.tsx` 键盘分派：
   ```ts
   const customizer = useCustomizationPreferences(); // 偏好变化即重渲染
   const action = resolveWithPreferences(customizer, event.nativeEvent, isEditorMac());
   ```
   `resolveWithPreferences` = 偏好优先 + 出厂兜底，但**用户改绑/解绑过的出厂组合不再触发**
   （只接 `preferredShortcut(...) ?? resolveEditorShortcut(...)` 会让旧键位继续生效，等于改键位无效）。
   命中后仍走既有 `applyShortcut` 与只读/草稿/IME 门禁（`editorInputConsumesKeys` 保持在最前）。
2. `photo-editor-chrome.tsx` 菜单：`items` 先经 `filterHiddenMenuItems(entries, preferences.menuHidden)`；
   快捷键提示经 `shortcutHint(preferences, id, isMac, factory)`，解绑后不再显示出厂组合。
3. `photo-editor-chrome.tsx` 工具栏：`toolbarRenderGroups(preferences)` 决定渲染顺序、隐藏与
   共用按钮的工具组（魔棒/快速选择、修复/修饰各折成一个按钮，隐藏组内一项不会带走整组）。
4. `photo-editor-app.tsx` 应用工作区：`workspacePanelLayout(layout, 当前布局)` →
   `display.updatePanels(...)`（经 `FeaturePanelContext.applyPanelLayout` 端口），因此当场重排；
   未提供端口时面板如实提示「重新打开编辑器后生效」。
5. 工具面板：切换画笔类工具时 `restoreBrushOptions(preferences, tool, brush)` 恢复最近值，
   数值变化时 `rememberToolOptions(tool, brushOptionValues(brush))` 写回（工具状态，不造 dirty）。
6. 「窗口 ▸ 工作区、快捷键与命令搜索…」：`sections.tsx` 的 `menu` 为「窗口」，外壳为窗口菜单渲染
   `featureMenuSections("窗口")`。

## 明确不做

手机布局、无障碍专项、独立应用外壳；不重做已交付的标签位置、面板浮动与滚轮语义。
