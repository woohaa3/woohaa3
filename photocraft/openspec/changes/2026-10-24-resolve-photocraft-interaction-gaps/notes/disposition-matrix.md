# 差异处置矩阵

本表与 `interaction-differences-baseline.md` 的 301 行一一对应，B1–B117 后已无「待处置」行，也**不再有「待核验」行**：每行都是补齐、部分补齐、等价或明确不支持之一。B117 复核了 B116 留下的 8 条待核验，能静态证实的差异已补齐实现，须真实设备的结论改写为「补齐/部分补齐 + 待人工验证」，不再用待核验代替交付判断。当前统计：补齐 171、部分补齐 50、等价 8、明确不支持 72（B128 重构工具栏后，I004/I106/I210 与 11 条绘画工具证据按槽位重写，6 条原「部分补齐」因补齐分组结论升为「补齐」）。实现与验证细节见 [verification](../verification.md)。

矩阵由 `scripts/check-disposition-matrix.mjs` 机械校验（301 行唯一、任务列、证据路径、命令白名单），并由 `packages/editor/src/unsupported-closure.test.ts` 断言 72 条不支持项的命令与菜单入口同时关闭。

- **补齐/实现补齐**：入口、命令、取消与回归已接通；真实指针/GPU/IME/Pad 画面仍逐条标注待人工。
- **部分补齐/部分接通**：已交付的子集可用且受门禁；剩余子集在处置列写明缺口，不因本行有进展而关闭。
- **等价**：以不同入口提供同等结果，证据指向实际入口。
- **明确不支持**：附产品/平台理由，并保持菜单、工具栏、快捷键与命令白名单同时关闭。
- **待核验**：静态证据不足，需真实设备或运行时复核；不得计作已交付。B117 后本表已无此类行——能静态证实的已落实现，「需真实设备」写在处置列的后半句而不单独成类。

自动回归通过不等同整个 change 交付；GPU/视觉/系统 IME/Pad/真实相机等项仍为人工验收。

| ID | 基线交互 | 处置 | owner/批次 | 任务 | 验收证据 |
| --- | --- | --- | --- | --- | --- |
| I001 | 产品入口 | 等价：独立文件工作区与节点聚焦入口 | P1 · B116 | I001 | 独立 PhotoCraft 应用入口不在本产品形态内；从图片节点聚焦进入、在编辑工作区内打开独立文件是既有等价入口，工具栏不另设独立产品壳 |
| I002 | 切片工作流 | 明确不支持：共享字节编辑器无切片文档状态与 HTML/图像切片交付 | P1 · B116 | I002 | 切片需要文档级 slice 状态、画布覆盖层与 HTML+图像批量交付；本产品以单文件字节导入/导出为边界，未开放 `slice.*` 白名单，菜单无入口 |
| I003 | 透视裁切工具 | 明确不支持：无透视四边形画布手势 | P1 · B116 | I003 | `image.perspectiveCrop` 与 `image.crop` 保持关闭；本产品不提供透视四边形拖框/四点/角点手势、网格与红色无效提示或尺寸栏，也不以无入口的内核命令充当功能 |
| I004 | 画布工具 | 部分补齐：按上游槽位渲染 5 段 16 槽（移动/选框/套索/魔棒/吸管/修复/画笔/仿制/历史记录画笔/橡皮/油漆桶/模糊/减淡/文字/手形/缩放）；其余上游槽位未开放 | P1/P3/P5/P7 · B128 | I004 | `toolbar-slots.ts` 逐项对应上游 `panels.rs::TOOL_SECTIONS`（5 段 21 槽 67 成员），投影为 5 段 16 槽；`tool-slot-button.tsx` 为唯一 flyout 实现；`toolbar-slots.test.ts` 与 `tests/fixtures/toolbar-slots.json` 机械比对段/槽/成员顺序/组键/循环序；未开放槽位整槽省略不留占位；裁剪/画板/Frame/路径/形状/切片/渐变仍按各自条目关闭 |
| I005 | 颜色替换画笔 | 补齐命令接线与槽位/选项；原生执行由固定引擎提供，画面待人工 | P1/P3/P5/P7 · B128 | I005 | 画笔槽（槽 8）成员之一：`colorReplacement` 是一级工具 id，与画笔/铅笔/混合画笔同槽同 B 组；参数编译`retouch-tools.ts`、选项`retouch-options.tsx`；`paint.colorReplacement` 在白名单；释放整笔一次分派、取消不写；真实笔迹与GPU画面待人工 |
| I006 | Mixer Brush 混合画笔 | 补齐命令接线与槽位/选项；原生执行由固定引擎提供，画面待人工 | P1/P3/P5/P7 · B128 | I006 | 画笔槽（槽 8）成员之一：`mixer` 是一级工具 id，按 B 组循环；参数编译`retouch-tools.ts`、选项`retouch-options.tsx`；`paint.mixerBrush` 在白名单；真实笔迹与GPU画面待人工 |
| I007 | Pattern Stamp 图案图章 | 补齐命令接线与槽位/选项；原生执行由固定引擎提供，画面待人工 | P1/P3/P5/P7 · B128 | I007 | 仿制槽（槽 9）成员之一：`patternStamp` 与仿制图章同槽，按 S 组循环；参数编译`retouch-tools.ts`、选项`retouch-options.tsx`；缺图案时不派发；`paint.patternStamp` 在白名单；真实笔迹与GPU画面待人工 |
| I008 | History Brush 历史记录画笔 | 补齐命令接线与槽位/选项；原生执行由固定引擎提供，画面待人工 | P1/P3/P5/P7 · B128 | I008 | 独占槽 10：`historyBrush` 是独立一键（不与仿制或修复合并），按 Y 组循环；参数编译`retouch-tools.ts`、选项`retouch-options.tsx`；`paint.historyBrush` 在白名单；真实笔迹与GPU画面待人工 |
| I009 | Dodge / Burn / Sponge 色调笔刷 | 补齐命令接线与槽位/选项；原生执行由固定引擎提供，画面待人工 | P1/P3/P5/P7 · B128 | I009 | 减淡槽（槽 14）：`dodge`/`burn`/`sponge` 三者同槽，按 O 组循环；参数编译`retouch-tools.ts`、选项`retouch-options.tsx`；三条命令在白名单；真实笔迹与GPU画面待人工 |
| I010 | Blur / Sharpen / Smudge 局部笔刷 | 补齐命令接线与槽位/选项；原生执行由固定引擎提供，画面待人工 | P1/P3/P5/P7 · B128 | I010 | 模糊槽（槽 13）：`blur`/`sharpen`/`smudge` 三者同槽；上游此槽无组键（`Tool::key()` 为 `'\0'`），本实现同样只从槽位展开列表进入，不占用任何字母；参数编译`retouch-tools.ts`、选项`retouch-options.tsx`；真实笔迹与GPU画面待人工 |
| I011 | Clone Stamp / Healing Brush 与 Clone Source | 补齐命令与工具/面板接线；Clone Source 五槽面板与 Alt 取样已实现，真实笔迹与画面待人工 | P1/P5 · B117 | I011 | `paint.cloneStamp`/`paint.healingBrush` 与 `cloneSource.list|select|set|resetTransform|overlay` 进入能力白名单；`retouch-tools.ts` 新增仿制图章/修复画笔参数（对齐、取样图层、显式来源点或偏移），`retouch-options.tsx` 提供选项，App 在 Alt/Option 按下时取样来源点而不绘制整笔；`clone-source-panel.tsx` 提供五槽选择、宽高/链接/旋转/翻转、重置与清除，以及叠层显示/不透明度/混合/剪贴/自动隐藏/反相，只改会话预设；`retouch_params.rs` 在写路由前拒绝半截来源点、越界笔尖与未知取样范围；`tests/clone_source.rs` 断言预设不推进内容指纹、历史或修订，重开工程后槽位清空，绘制无来源时明确拒绝。真实指针取样、源叠层画面与 GPU 合成待人工 |
| I012 | Spot Healing Brush 污点修复画笔 | 补齐命令接线与槽位/选项；画面待人工 | P1/P3/P5/P7 · B128 | I012 | 修复槽（槽 7）：`spotHealing` 与修复画笔、红眼同槽，按 J 组循环（上游 Remove/Patch/ContentAwareMove 未开放，槽内省略）；选项提供内容感知/创建纹理/近似匹配与跨层取样；`paint.spotHealing` 在白名单；实际修复结果与背景任务取消待人工 |
| I013 | Patch 选区修补工具 | 明确不支持：需要选区拖动取样的专用画布手势与后台任务 | P1 · B116 | I013 | 现有选区拖动只搬移像素；不开放 `paint.patch` 的 Source/Destination 或内容感知参数，避免以普通移动冒充修补 |
| I014 | Content-Aware Move 内容感知移动 | 明确不支持：需放置后变换与内容填补后台任务 | P1 · B116 | I014 | `paint.contentAwareMove` 未进入白名单：Move/Extend、Transform On Drop 与可取消内容填补均未接线；不复制无预览的占位工具 |
| I015 | Red Eye 红眼修复工具 | 补齐命令接线与槽位/选项；原生执行由固定引擎提供，画面待人工 | P1/P3/P5/P7 · B128 | I015 | 修复槽（槽 7）成员之一：`redEye` 是一级工具 id，按 J 组循环；点按类工具只提交一个坐标；参数编译`retouch-tools.ts`、选项`retouch-options.tsx`；`paint.redEye` 在白名单；真实画面待人工 |
| I016 | Remove Tool 移除工具 | 明确不支持：需暂存笔划与内容填补任务 | P1 · B116 | I016 | 现无暂存笔划状态或 `paint.remove` 分派，该命令未进入白名单；橡皮擦只擦除不作周边补全 |
| I017 | 单行/单列选框 | 补齐；DOM/内核通过，实机待核验 | P1 · B3 | I017 | `selection-gesture.ts`、`toolbar-slots.ts`（槽 1 的矩形/椭圆/单行/单列四个成员）、`tool-slot-button.test.tsx`、Canvas 点按/取消测试；`interaction_state.rs` 整行/列权威范围及越界拒绝；真实 WASM 冒烟；[B2/B3 验证](../verification.md) |
| I018 | 移动工具自动选层目标与追加选择 | 补齐；状态/DOM通过，拾取视觉待人工 | P1 · B3 | I018 | Group 默认目标、Layer/Group 切换与 Shift 追加；`editor/transform.rs`、`photo-editor-canvas.test.tsx`、group picker 状态回归；[B2/B3 验证](../verification.md) |
| I019 | Move 拖动预览模式 | 补齐；边界/箭头DOM通过，画面待人工 | P1 · B10 | I019 | 拖动只更新边框，释放最终矩阵一次提交；取消零preview，显式变换仍实时；普通Move和变换框拖动共享位移箭头；[B10](../verification.md) |
| I020 | Move 自动选层的悬停目标预览 | 补齐；CPU/DOM/WASM通过，画面待人工 | P1 · B45 | I020 | 共用原生自动选层/组命中与变换边界，只读不改选择/历史；修饰键静止刷新，离开/失焦/按下/视图变化清理；[B45](../verification.md) |
| I021 | Move 智能参考线距离测量 | 补齐 Move 距离测量覆盖层；单位/DOM 通过，真实指针与画面待人工 | P1 · B117 | I021 | `move-distance.ts` 按上游 `move_distance.rs` 语义计算两框水平/垂直距离：分离取相对边空隙、重叠取对应边、零距离不显示、线端不在目标框时补虚线延长线；悬停空白或自身选择时量到画布边缘，Alt 复制拖动量原件与副本间距。`moveLabels` 复用七种测量单位、文档 DPI 与点/派卡标准；`shouldMeasure` 只在 Move + Extras + 无拖动 + Cmd/Ctrl + 有选中图层时成立。Canvas 只读查询 `moveHoverAt` 并绘制覆盖层，按下、取消、离开、视图变化即清理，不写选择/历史/内容。真实指针悬停距离线与 GPU 画面待人工 |
| I022 | Move 工具锁定目标提示时机 | 补齐；DOM通过，真实鼠标待核验 | P1 · B3 | I022 | Canvas pendingMove 越阈值才申请草稿；点按不报锁定、失败不重复开始、Alt 精确 2px 释放回归；[B2/B3 验证](../verification.md) |
| I023 | 隐藏图层编辑保护 | 补齐；原生拒绝路径通过，画布待人工 | P1 · B3 | I023 | `layer_preview::require_visible` 检查自身与祖先；begin_move/begin_stroke/paint.stroke；`interaction_state.rs` 隐藏父组拒绝无写；[B2/B3 验证](../verification.md) |
| I024 | 画板工作流 | 明确不支持：画板属未协商的持久化结构 | P1 · B116 | I024 | 工程核验显式拒绝画板组；菜单、工具栏与命令白名单均无画板入口，本产品不新增画板文档状态、相邻画板复制或画板导出 |
| I025 | Frame 占位框工作流 | 明确不支持：Frame 需要新的占位框图层语义 | P1 · B116 | I025 | Frame 会引入可接收内容的占位框组与形状遮罩语义，未在工程格式中协商，因此没有工具、菜单或 `frame.*` 命令入口；普通编组保持可用 |
| I026 | 路径与矢量编辑 | 明确不支持：矢量路径与形状属关闭能力 | P1 · B116 | I026 | `vector.path` 显式关闭，无 Pen/Shape/Paths 面板与锚点编辑；套索产生栅格选区 |
| I027 | 裁切流程 | 明确不支持：裁切工具与构图覆盖线未开放 | P1 · B116 | I027 | `image.crop` 与裁切工具保持关闭；无框绘制/旋转/微移、Auto Center Preview、构图覆盖线、Crop Shield、预设或拉直，菜单/快捷键/命令同时不存在 |
| I028 | 图像/画布尺寸 | 补齐；参数/身份/原生回归通过，画面待人工 | P1 · B11 | I028 | 图像像素/百分比、DPI/重采样、约束比例；画布相对尺寸/九锚点/扩展色；scratch原子历史、8192/256MiB预检；[B11](../verification.md) |
| I029 | Image Rotation › Arbitrary | 补齐候选实时预览；状态/DOM/WASM通过，真实合成待人工 | P1 · B11/B14 | I029 | 旋转候选每次从原始文档重算，RAF合帧，确认同步flush并一步历史，取消/卸载隔离迟到帧；非法参数不得提交旧候选，宿主背景色严格校验；[B14](../verification.md) |
| I030 | 数据驱动变量与数据集 | 明确不支持：依赖本机路径的 CSV 导入/导出 | P1 · B116 | I030 | 固定引擎的变量数据集导入/导出只接受本机 path/dir，共享字节端口不提供任意路径读写；菜单与命令白名单均无变量/数据集入口，不复制无效果的 Web 表单 |
| I031 | 文档色彩模式与位深 | 部分补齐：模式与位深转换对话框；32位预览选项、ICC 配置未实现 | P1 · B115 | I031 | `image.colorMode` 表单按模式后位深各分派一次已开放命令（RGB/灰度/CMYK/Lab/位图/双色调/多通道、8/16/32位），未变化禁止确认、命令关闭时不写入一半；仍无 32 位曝光/Gamma 预览与 ICC 文档配置 |
| I032 | Indexed Color 调色表编辑 | 明确不支持：无索引色彩文档模型与 .act 交互 | P1 · B116 | I032 | `image.mode.indexedColor` 未开放，文档仅保存 RGB/灰度/CMYK/Lab 等色彩模式；调色表编辑会引入第二套像素表示 |
| I033 | ICC 颜色管理与软打样 | 明确不支持：Web 导入统一归一为 sRGB/RGBA8 | P1 · B116 | I033 | `color.icc` 显式关闭；宿主先经浏览器解码并归一，没有嵌入配置选择或软打样；导出副本的色彩配置选项另属导出流程 |
| I034 | EXIF ColorSpace 标记解释偏好 | 明确不支持：宿主已归一化 sRGB | P1 · B116 | I034 | 打开流程在进入编辑器前已把像素归一为 sRGB/RGBA8，编辑器无法据此偏好重新解释 EXIF ColorSpace；不提供无效果开关 |
| I035 | 菜单命令 | 部分补齐：Edit/Image/Layer/Type/Select/View/Window/File/Help/滤镜 菜单；Filter Gallery 与高级滤镜仍关闭 | P2 · B121 | I035 | 顶级菜单按能力渲染并可搜索；新增「滤镜」菜单，包含固定引擎已实现的 24 条可单独提交滤镜（模糊/锐化/杂色/像素化/风格化/扭曲/其它）与「重复上一次滤镜」。`filter-catalog.ts` 声明每条的原生参数范围与默认值，`filter-dialog.tsx` 提供参数表单并对越界值禁用确认；无参滤镜直接分派。`filter.lastFilter` 一并进入白名单。Filter Gallery、Camera Raw、液化与智能滤镜堆栈仍按 I168 保持关闭。 |
| I036 | Edit › Purge 内存清理 | 补齐；原生/宿主状态通过，菜单实机待核验 | P2 · B8/B9 | I036 | 五项清理菜单、严格参数和草稿门禁；`DocumentWorkspaceSession.purgePort` 汇总后台控制器并预检，All共享缓存仅清一次；宿主12项/全量278项通过；[B9](../verification.md) |
| I037 | 菜单栏键盘焦点与助记键 | 补齐菜单栏键盘操作（Alt 点按/F10/左右/打开/Esc/Alt+字母）；DOM 通过，不复制菜单行助记键 | P2 · B117 | I037 | `ui/menu-keyboard.ts` 提供 `menuMnemonic`、`moveMenuFocus`、`resolveMenuBarKey` 与 Alt 点按判定；`ui/Menu.tsx::MenuBar` 用 document 级 keydown/keyup 实现 Alt 点按或 F10 聚焦菜单栏、左右键循环切换、向下/Enter/空格打开、Esc 离开与 Alt+字母直达，输入字段、IME 组合与 Mod+Alt 宿主快捷键不抢键；打开后项内导航仍由 Radix 提供。按本项目键盘交互边界不引入读屏/ARIA 契约，也不为固定中文文案伪造菜单行助记键（I216）。`ui/menu-keyboard.test.ts` 与 `ui/menu-keyboard.dom.test.tsx` 通过；真实键盘与 Pad 外接键盘待人工 |
| I038 | 命令搜索与快速执行 | 补齐；搜索和执行回归通过，实机待核验 | P2 · B10 | I038 | Mod+F及编辑/帮助菜单，共享模态栈；中文/路径/id/模糊搜索、最近20项、禁用复核、owner隔离与IME；全局Purge复用宿主聚合状态；[B10/B11](../verification.md) |
| I039 | 快捷键自定义与快捷键集 | 明确不支持：快捷键集依赖本机偏好与 .kys 文件 | P3 · B116 | I039 | 快捷键由静态表定义并受能力门控，偏好设置不提供快捷键编辑页；命名快捷键集与 .kys 导入/导出需要本机文件端口与持久化契约，未开放 |
| I040 | 菜单与工具栏自定义 | 明确不支持：未协商菜单/工具栏隐藏与色标持久化 | P3 · B116 | I040 | 菜单与工具栏按固定目录和命令能力渲染；隐藏项/色标需要新的本机偏好契约，未开放 |
| I041 | 工具栏单/双列布局 | 补齐；DOM通过，桌面/Pad布局待人工 | P2 · B9 | I041 | 单双列工具网格独立滚动、底部颜色固定；本机panelLayout持久化并同步宿主toolColumn占位；[B9](../verification.md) |
| I042 | 文件与保存动作 | 部分补齐：节点应用、独立文件保存工程/另存为/导出 PNG/导出各格式；后台保存与最近文件仍未实现 | P2 · B119 | I042 | 独立文件动作条新增「另存为…」（用户给定文件名，补 `.pcraft`，走同一单文件交付端口且只有可信写入推进基线），`deliverActive` 接受目标文件名；`exportImage` 覆盖各扁平格式。仍无后台保存偏好、保存任务取消与最近文件列表。`tests/file-document-actions.test.tsx` 覆盖文件名规范化、只读禁用与缺少端口时不显示。 |
| I043 | 图层级导出 | 明确不支持：逐层多文件导出需要本机目录或批量下载契约 | P2 · B116 | I043 | 单层/多层 Quick Export 需逐层生成文件并交付；共享宿主只提供单文件下载端口，因此菜单不提供该导出，批量多文件交付未开放 |
| I044 | File › Print 状态 | 等价：共享Web无原生打印服务，入口/命令关闭 | P2 · B83 | I044 | 上游Web native_doc同样禁用；不把浏览器页面打印当图像打印/PDF工作流；原生/真实WASM拒绝与菜单回归通过；[B83](../verification.md) |
| I045 | 导出格式与控制 | 部分补齐：PNG/JPEG/WebP/TIFF/TGA/BMP/GIF/ICO 八种扁平格式与质量/压缩/缩放控制；工程字节另走保存 | P2/P8 · B118 | I045 | `export_request.rs` 严格解析格式与质量/压缩/缩放并编译成固定编码器选项，`Editor::export_image` 在隔离会话里按 `scale` 重采样后编码，`EditorWorkspaceController.exportImage` 只走宿主单文件交付端口。`tests/export_formats.rs` 用固定解码器重新识别全部八种字节、比较 JPEG 高低质量体积、验证缩放只影响导出且正式文档/指纹不变。`export-dialog.tsx` 提供格式与参数表单并在尺寸越界时禁用导出。仍无 Export As 的尺寸/画布锚点选项，也不支持批量多文件。 |
| I046 | File › Export › Save for Web (Legacy) | 明确不支持：GIF/WBMP/切片/动画帧优化导出不在共享编码器范围 | P2 · B116 | I046 | 固定引擎与宿主编码器不提供 GIF/WBMP 索引色、切片 HTML 或动画帧预览；不复制只有占位的优化对话框 |
| I047 | File › Generate Image Assets 开关 | 明确不支持Web无输出的勾选状态 | P2 · B83 | I047 | 固定上游on_saved在wasm32跳过生成；本产品不提供本机目录写入/监听端口，不复制无效果开关；6个文件id拒绝/无状态变化；[B83](../verification.md) |
| I048 | 文件选择器与导入分流 | 部分补齐：多选/自然排序/Mod+O；其余格式与资源分流未实施 | P2/P8 · B20 | I048 | 多文件批次与同一宿主快捷入口已接入；仍仅接受既有PNG/JPEG/WebP/pcraft，PSD/EXR/资源导入差异继续待实施，未批量标为不支持；[B20](../verification.md) |
| I049 | WIA 导入占位菜单 | 明确不支持空设备占位 | P2 · B83 | I049 | WIA为Windows COM平台能力，上游也未接设备枚举/传输；共享字节编辑器不显示可点但无反馈的扫描器入口；原生/真实WASM/UI通过；[B83](../verification.md) |
| I050 | 多文档批量关闭 | 补齐；串行结算/DOM通过，系统操作待人工 | P2 · B26 | I050 | 关闭全部/关闭其他及Mod+Alt+W/P；捕获目标快照，活动项最后关闭，逐项await、取消/错误停止、下载二次确认、dispose/资源代际复核和重入保护；[B26](../verification.md) |
| I051 | 从文件建立图层堆栈 | 等价Web门禁；不提供原生路径堆栈工作流 | P2 · B85 | I051 | 上游native禁用；Paths回调不接ContentsMany且Web目录取消，当前仅独立字节打开，不复制不可用表单；不声称字节堆栈/对齐/智能对象已实现；原生/真实WASM/UI拒绝通过；[B85](../verification.md) |
| I052 | 文件置入入口状态 | 等价：两端Web都不开放原生路径置入入口 | P2 · B83 | I052 | 上游Place Embedded/Linked委托native_doc在Web禁用，当前不列禁用菜单且命令保持关闭；不据此关闭智能对象/未来字节置入任务；[B83](../verification.md) |
| I053 | 文件信息与相机元数据 | 补齐对话框与只读相机数据；设备元数据样本待人工 | P2 · B115 | I053 | File 菜单打开文件信息表单，读取/写入标题、作者、描述、关键词、版权状态/声明/链接，只读展示相机 EXIF；确认一次`file.fileInfo`、取消零写、过期文档与命令关闭拒绝；`file.fileInfo`进入白名单；表单DOM回归通过；真实相机文件待人工 |
| I054 | 应用内剪贴板 | 部分补齐：快捷键/位置/多层Cut/粘贴入外；跨文档共享未完成 | P2 · B84/B102/B103 | I054 | 原生clipboardBounds与实际视口决定普通Paste位置；Cut只清活动像素层且保留蒙版；粘贴入外生成不链接选区/反选蒙版，蒙版目标限定亮度写入；一步历史及最终单选；跨文档共享仍缺；[B84/B102/B103](../verification.md) |
| I055 | 系统图像剪贴板 | 等价：两端Web未装配OS图像服务 | P2 · B85 | I055 | Copy/Cut/Paste事件只进内部图像命令，不提供无服务Export Clipboard开关；上游Web Services无图像读写注入；文字剪贴板独立支持不混淆；原生事件/门禁回归通过，系统权限策略未采集；[B85](../verification.md) |
| I056 | 复制整份文档 | 实现补齐；CPU/DOM/真实WASM通过，画面待人工 | P2 · B100 | I056 | Image直接复制当前正式文档为独立未保存文件并激活；新文档/层身份、原生结构/像素、历史隔离、256MiB预算及草稿/容量门禁；旧运行组件禁用；[B100](../verification.md) |
| I057 | 跨文档复制图层 | 部分补齐：同文档复制图层可用；跨文档/拖到标签未实现 | P2 · B116 | I057 | `layer.duplicate` 等按当前文档；跨文档需要在宿主文档会话间搬运原生层内容与身份重映射，尚未接线 |
| I058 | 从选区定义画笔预设 | 补齐：命名表单、图层面板入口与「从选区定义画笔」共用同一命令 | P2/P5 · B118 | I058 | `brush-preset-panel.tsx` 提供名称输入、存储当前画笔与从选区定义两个动作，`EditorWorkspaceController.defineBrushFromSelection` 走 `brush.defineFromSelection`；缺少选区时按钮禁用并显示命令的禁用原因。`brush-preset-panel.test.tsx` 与真实 WASM 冒烟覆盖拒绝/成功两条路径。 |
| I059 | 从选区定义图案 | 补齐；原生/库/表单/WASM通过，实机待验 | P2 · B95 | I059 | 选区bounds/整画布可见合成、命名表单、1024px/64项/累计4M预算及原生库身份/持久化/PAT管理；文档/历史/hash不变；[B95](../verification.md) |
| I060 | 笔刷/形状预设管理器 | 明确不支持：无自定义形状与跨类别预设管理 | P2 · B116 | I060 | `brush.presets.*` 与命名采样笔尖可用，但自定义形状依赖关闭的矢量路径；工具栏与菜单不提供跨类别预设管理器入口 |
| I061 | 预设集合导入/导出 | 明确不支持：.pcpresets 未被本产品定义 | P2 · B116 | I061 | 该文件名与内容结构属上游专有交换格式，菜单与命令白名单均无 `.pcpresets` 入口；本产品只提供图案/等高线专用交换与画笔预设命令 |
| I062 | 工具预设面板 | 明确不支持：跨工具预设不是已协商状态 | P2 · B116 | I062 | 工具参数按工具类别本机记忆，不提供跨工具预设面板入口；它需要新的偏好契约与批量应用语义，未开放 |
| I063 | 文件拖放 | 明确不支持：浏览器拖放会绕过现有打开端口 | P2 · B116 | I063 | 宿主通过文件选择器和空工作区双击接入，画布与标签不注册 drop 接收；这类拖放需要在宿主层新增置入语义，因此菜单与工具栏均无对应入口，未开放 |
| I064 | 新建文档 | 补齐：新建文档表单（预设/单位/模式/位深/背景/最近设置）+ `file.new` 唯一写入口 | P2 · B118 | I064 | `document.presets.list|get|save|delete` 与 `document.recent.list|add` 进入能力白名单，`new-document-dialog.tsx` 提供预设选择、单位换算（提交仍为像素与 ppi）、模式/位深/背景与最近设置，创建只分派 `file.new`。`new-document-dialog.test.tsx` 覆盖单位往返与严格解码；真实 WASM 冒烟验证预设增删、最近记录与非法设置拒绝。 |
| I065 | 无文档空工作区双击打开 | 补齐；DOM通过，系统文件窗待人工 | P2 · B48 | I065 | 空文档清单/非忙碌时双击背景转交打开端口，单击无动作、控件不重复打开；提供明确打开按钮；[B48](../verification.md) |
| I066 | 有文档时切换 Home Screen | 明确不支持：无覆盖式起始页 | P2 · B116 | I066 | 宿主概览是退出编辑器焦点后的独立页面，不是保留文档的覆盖层；编辑器菜单与工具栏不提供切换入口，不复制半透明 Home 覆盖 |
| I067 | 多文档标签 | 部分补齐：排序/中键/上下文关闭/大标签；浮动文档等待做 | P2 · B97/B98 | I067 | 稳定id/代际排序不重建会话，批量关闭沿用结算；大标签本机确认后同步34/42px占位，保留草稿；当前仍8文档，浮动视图未实现；[B97/B98](../verification.md) |
| I068 | 文档标签标题上下文 | 补齐当前文档模型；DOM/订阅通过，布局待人工 | P2 · B60 | I068 | 实际倍率/活动层/蒙版/模式位深/星号，后台上下文与代际清理；未开放Quick Mask不伪装；[B60](../verification.md) |
| I069 | 打开中文档的进度标签与取消 | 补齐受控打开：临时标签显示真实进度并可取消；DOM/会话通过，真实浏览器解码时序待人工 | P2 · B117 | I069 | `EditorDocumentRegistry.beginOpening/setOpeningProgress/completeOpening` 与 `DocumentWorkspaceSession.beginControlledOpen/cancelOpen` 让文件在读取/解码期间先出现临时标签：进度单调、可取消、取消或失败只移除占位条目且不改变活动文档；`openFileDocument` 在读取、归一、解码后分别上报进度并用占位 id 完成，迟到完成被拒绝。`document-tabs.tsx` 显示「打开中 N%」、进度条与「取消打开」关闭按钮，`image-editor-overlay.tsx::onCancelOrCloseDocument` 区分取消打开与正常关闭结算。`tests/document-session.test.ts` 与 `tests/document-tabs.test.tsx` 通过；真实浏览器解码时序与取消手感待人工 |
| I070 | 右键菜单 | 部分补齐：画布/图层/标签已有上下文菜单；工具与命中分流未实现 | P2 · B116 | I070 | 现有 Canvas 菜单提供变换/选区命令，图层行与标签各有菜单；画笔预设器、Zoom/Hand 视图菜单、pasteboard 颜色与变换模式菜单未实现 |
| I071 | 文字编辑态右键菜单 | 部分补齐：草稿剪贴板/全选/确认取消；高级Type/拼写待做 | P2 · B61 | I071 | 复用UTF16系统剪贴板守卫、IME/内容选择变化关闭、最终flush确认；非编辑命中菜单仍缺；[B61](../verification.md) |
| I072 | 文字编辑时的 Edit 菜单剪贴板命令 | 补齐；真实菜单/草稿状态通过，系统权限待人工 | P2 · B47 | I072 | 纯文字UTF16选区，写成功才剪切；owner/编辑/选择版本与IME隔离迟到粘贴，未提交草稿不写历史；[B47](../verification.md) |
| I073 | 选区构建与精修 | 部分补齐：魔棒/颜色范围/边框平滑扩展收缩/扩展相似/选择相似；Select and Mask、临时选区蒙版和 AI 主体分割未实现 | P3 · B114 | I073 | `select.magicWand`/`colorRange`/`modify.*`/`grow`/`similar` 进入能力白名单；魔棒工具、选项、颜色范围表单、修改半径控件与选择菜单；参数越界先使表单无效，取消零写；工具/对话框/快捷键回归通过；`selection.ai-subject` 与 Select and Mask/Quick Mask 仍关闭 |
| I074 | 选区操作模式指针提示 | 补齐；修饰键DOM回归通过，光标视觉待人工 | P3/P6/P7 · B4 | I074 | `selectionKey` 即时刷新静止指针，统一模式徽标；`photo-editor-canvas.test.tsx` 加/减/交提示；[B4 验证](../verification.md) |
| I075 | 选区拖动动作光标反馈 | 部分补齐：剪切/复制/拖动徽标；持续浮动片状态未开放 | P3/P6/P7 · B4 | I075 | 指针修饰键立即更新 Cut/Copy/Pointer 图标；现有候选手势释放即结算，不宣称已接通持续浮动片工作流；[B4 验证](../verification.md) |
| I076 | 智能选区工具手势 | 部分补齐：魔棒点按与颜色范围命令；Quick Selection、Object Selection 与主体/天空/焦点分割未实现 | P3 · B114 | I076 | 魔棒在按下取文档坐标与Shift/Alt/Ctrl运算，空选区Alt回退替换；原生按可见alpha/蒙版取样；颜色范围表单按取样颜色或色调生成一步选区；`selection.ai-subject`保持关闭，无 Quick/Object Selection 拖动增选 |
| I077 | 移动工具变换框开关 | 补齐；DOM通过，画布显示待人工 | P3 · B9 | I077 | Move独立“显示变换控件”偏好；Extras不覆写此偏好，显式自由变换始终显示；[B9](../verification.md) |
| I078 | 套索路径输入与闭合 | 部分补齐：合并样本/图外路径；多边形/磁性/Alt混合尚待实现 | P3 · B13 | I078 | PointerMove/Up按顺序消费全部coalesced样本和最终坐标，图外路径保留到内核裁剪；DOM回归通过；[B13](../verification.md) |
| I079 | 选框固定比例与尺寸 | 补齐；几何/DOM通过，真实画布待人工 | P3 · B9 | I079 | 正常/固定比例/固定大小，宽高交换、单击放置、方向和居中，空字段关闭创建；[B9](../verification.md) |
| I080 | 选框拖动尺寸读数 | 实现补齐；实机HUD待人工 | P3/P4/P6/P7 · B5/B81 | I080 | 选框候选宽高随指针，支持七种测量单位、文档dpi、72/72.27点标准与各轴百分比，偏好关闭；正式提交仍源像素；[B81](../verification.md) |
| I081 | Move 拖动偏移读数 | 补齐；DOM回归通过，HUD视觉待人工 | P3/P4/P6/P7 · B5 | I081 | 移动越阈值后显示本次整数ΔX/ΔY，未移动/取消/提交后隐藏；本机偏好关闭；[B5 验证](../verification.md) |
| I082 | 点击选区内部取消选择 | 补齐；DOM回归通过，实机待核验 | P3/P6/P7 · B4 | I082 | 边界内部单击取消草稿后路由取消选区，像素临时移动点按保留选区；取消/拖动不误清除；[B4 验证](../verification.md) |
| I083 | 空选区时 Alt/Option 减选回退 | 补齐；几何/DOM回归通过，实机待核验 | P3/P6/P7 · B4 | I083 | 空选区+replace+Alt回退replace并释放居中几何；已有选区和显式减选保持subtract；[B4 验证](../verification.md) |
| I084 | 拖动出画布时自动滚动 | 支持工具补齐；裁切工具待接入，实机待人工 | P3 · B49 | I084 | 真正出界才渐进平移，选区/Move/变换/画笔/铅笔/橡皮/段落框延续同一草稿与源坐标；取消/释放隔离迟到帧；[B49](../verification.md) |
| I085 | 通道与选区通道 | 部分补齐：存储/载入选区、Quick Mask 编辑模式；Channels 面板、Apply Image/Calculations 仍缺 | P3 · B114/B126 | I085 | `select.saveSelection`/`select.loadSelection` 由选择菜单驱动；本轮补上 `select.editInQuickMaskMode`（Q 键、选择菜单、`quickMask` 视图投影），进入时清空普通选区、退出时还原为选区，`{on}` 幂等不写历史。真实 WASM 冒烟验证进出各一步历史、可撤销、同一状态不重复写。仍无 Channels 面板（Alpha/Spot 管理）、Apply Image 与 Calculations 表单。 |
| I086 | 画布导航手势 | 部分补齐：Hand/Zoom/中键/阶梯/拖动/按住/页面键/滚轮偏好/滚动条/Overscroll/触屏双指；模态导航待做 | P3/P7 · B13/B15/B17/B58/B59/B65/B66/B67/B68 | I086 | 锚点Scrubby/矩形/按住/Page/Home/End；滚轮平移/Alt1.1倍率/Shift阶梯、轮缩放交换偏好、Ctrl分数pinch与禁用，local标记避免宿主重复导航；Overscroll关闭统一夹紧与Span滚动条；双指导航/单指耗尽与独立偏好；模态导航待做；[B58/B59/B65/B66/B67/B68](../verification.md) |
| I087 | 工具栏双击执行视图命令 | 补齐；DOM通过，真实设备待核验 | P3 · B13 | I087 | 手形双击适合屏幕、缩放双击实际像素，共用原视图端口，禁用不分派；[B13](../verification.md) |
| I088 | 缩放动画与中心点偏好 | 补齐；几何/DOM通过，设备动画待人工 | P7 · B15 | I088 | 默认220ms缩放动画、点击点保持或居中偏好；新按下/按键/失焦/隐藏/阻塞取消动画，迟到帧隔离；[B15](../verification.md) |
| I089 | Navigator 面板导航与缩放 | 实现补齐；实机视觉/手势待人工 | P3 · B80 | I089 | 256px候选缩略图、实际主视口范围框、点拖平移/Cmd-Ctrl框缩放、百分比/阶梯/连续滑块/滚轮pinch偏好；主画布统一边界与手势门禁；CPU/DOM/真实WASM通过；[B80](../verification.md) |
| I090 | 非破坏性旋转画布视图 | 明确不支持：视口仅保存平移/缩放 | P3 · B116 | I090 | 现有旋转命令改写文档像素；非破坏视图旋转会扩展取景、命中和坐标契约，未开放 |
| I091 | 状态栏缩放与信息选择 | 补齐缩放与信息选择；真实性能效率未采集 | P3 · B25 | I091 | 百分比输入/方向键/滚轮/拖动，非法回退、取消、最终释放位置；八种信息选择持久化，原生只读文档大小/ICC描述，效率明确未采集；[B25](../verification.md) |
| I092 | GPU 显存预算状态入口 | 明确不支持ui-egui专属预算状态；复用宿主实际错误 | P3 · B82 | I092、I299 | 不链接GpuCanvas、不拥有Bevy显存分配/预算测量，不显示推测GPU Memory Full或跳转无效设置；宿主故障提示采用实际runtime issues，GPU偏好写命令保持关闭；[B82](../verification.md) |
| I093 | GPU 画布故障回退与恢复选择 | 等价恢复入口采用宿主有界重建；不支持ui-egui CPU切换 | P3 · B82 | I093 | 连续故障有界自动重建、degraded停止、实际错误详情与手动恢复；14项策略/DOM回归通过，场景/资源重放源码核对；真实设备故障/像素一致性待人工；[B82](../verification.md) |
| I094 | Info 面板实时读数 | 补齐：原生只读读数 + 七种单位/原点相对坐标；参考线拖动由 I096 提供，实机视觉得待人工 | P3 · B77/B81/B118 | I094、I096 | 原生候选RGB/device-CMYK、原点相对坐标、七种单位与选区/文档尺寸；F8与Window入口，逐帧只读、过期结果隔离；参考线/标尺原点读入 `document_json` 并可拖动（I096），因此 B116 记的「参考线拖动未接通」已补齐。原生/真实WASM/DOM通过，实机视觉与真实指针待人工；[B77](../verification.md) |
| I095 | Histogram 面板统计 | 实现补齐；实机视觉待人工 | P3 · B79 | I095 | 原生384px合成缓存、RGB/R/G/B统计与250ms节流/缓存提示，稳定文档标识隔离；原生/真实WASM/DOM/宿主通过；[B79](../verification.md) |
| I096 | 标尺、参考线与吸附 | 补齐：标尺、参考线（新建/移动/编辑/删除/清除）、网格与三种吸附；画面与指针待人工 | P3 · B118 | I096 | `guides.ts` 提供参考线投影/命中/拖出、按可见范围生成的网格、缩放自适应刻度、参考线/网格/画布边缘吸附与显示偏好规范化；Canvas 渲染标尺带、可见网格与参考线（含独占颜色的参考线），从标尺拖出新建、拖动移动/拖出删除、标尺带 Alt 单击设原点。写入分派原生 `view.newGuide|moveGuide|editGuide|deleteGuide|clearGuides|setRulerOrigin|resetRulerOrigin`，`document_json` 投影 `guides`/`rulerOrigin`。`guides.test.ts`、Canvas 2 项与真实 WASM 冒烟验证参考线**不改变内容指纹**。指南颜色预设列表与「新建参考线布局」对话框仍缺。 |
| I097 | 命名工作区布局与锁定 | 部分补齐：布局显隐/尺寸记忆；命名布局与锁定未实现 | P3 · B116 | I097 | Remember Workspace Changes 控制布局记忆；无预设命名布局、保存/删除/重置或结构锁定 |
| I098 | 工具栏/选项栏显隐与 Tab 恢复 | 实现已补齐，窗口/画面待实机 | P3/P7 · B46/B71 | I098 | 三模式、F/按钮长按、全屏Tab原组合、标签/滚动条与窗口状态；DOM/协议/唯一布局矩形通过，真实浏览器/Pad/GPU待人工；[B71](../verification.md) |
| I099 | Window › Modifier Keys 锁存修饰键 | 实现已补齐，实机待验 | P3 · B70 | I099 | 三键独立锁存、关闭保留、物理键OR合并与Canvas/变换指针；DOM/状态回归通过，触控笔/Pad待人工；[B70](../verification.md) |
| I100 | 文档关闭结算 | 补齐；真实宿主弹窗/结算回归通过，设备待人工 | P3 · B28 | I100 | 保存/不保存/取消统一单个、批量与离开；下载二次确认单独文案、代际复核、失败停止、离开中的已放弃项关闭；[B28](../verification.md) |
| I101 | 浏览器刷新/关闭时的未保存保护 | 现有保护加强；同步事件通过，原生提示待人工 | P3 · B43 | I101 | dirty/saving/conflict/error/history-pending及干净文档中的文字/半笔/变换/旋转/图层/调整草稿均请求浏览器通用确认；同步读取并释放监听，不冒充异步保存或恢复；[B43](../verification.md) |
| I102 | 自动保存与崩溃恢复设置 | 明确不支持：Web 无崩溃恢复服务 | P3 · B116 | I102 | 上游 Web 部署同样没有 autosave/crash recovery；本产品保留未保存保护与手动保存，不显示无服务开关 |
| I103 | 历史操作 | 补齐；CPU/DOM通过，合并快照画面待人工 | P3 · B29 | I103 | history.selectState一次修订且保留redo；完整/合并/当前图层快照、恢复/改名/删除，严格参数与scratch原子发布；快照元数据不改内容；[B29](../verification.md) |
| I104 | 图层复合（Layer Comps） | 明确不支持：图层复合是新的持久化状态 | P3 · B116 | I104 | 图层复合会保存可见性/位置/样式快照并需版本协商，`layer.comps.*` 未进入白名单且无面板入口；本产品用历史快照提供一步状态，不伪造复合面板 |
| I105 | 动作录制与自动化 | 明确不支持：动作录制会执行任意命令序列 | P3 · B116 | I105 | `actions.*` 未进入命令白名单，菜单也无动作面板入口；本产品只提供有界的文档字节脚本导入，不提供录制/回放或 .atn |
| I106 | 工具快捷键与 Shift 循环设置 | 部分补齐：8 组字母循环（V/M/L/W/I/J/B/S/E/G/O/T/H/Z 共 15 个字母）+ 无键槽；快捷键自定义仍未开放 | P1/P3/P5/P7 · B128 | I106 | `toolbar-slots.ts` 的组键派生 `TOOL_GROUP_KEYS`（按循环序）；`photo-editor-shortcuts.ts` 返回 `toolGroup`；`photo-editor-shortcuts.test.ts` 覆盖 15 个字母、7 个多成员组（M/J/B/S/E/O/T）逐成员循环与单成员组；`Blur/Sharpen/Smudge` 与单行/单列无组键；`useShiftForToolSwitch` 默认 true 时普通键回组内上次工具、Shift 循环；`toolbar-memory.test.ts` 断言组切换语义；自定义快捷键集仍属 I039 |
| I107 | 按住工具键临时切换 | 补齐现有工具；状态/宿主回归通过，设备待核验 | P3 · B13 | I107 | 短按保持，300ms或使用画布后恢复，半笔等待结束；显式工具点击/失焦/owner变化清理；[B13](../verification.md) |
| I108 | 工具栏项目自定义 | 明确不支持：未协商工具栏隐藏偏好 | P3 · B116 | I108 | 工具栏按已开放工具固定渲染；单双列与紧凑选项栏已支持，逐项隐藏未开放 |
| I109 | 菜单项目自定义 | 明确不支持：未协商菜单隐藏/色标偏好 | P3 · B116 | I109 | 菜单按固定目录与命令能力渲染，偏好设置中不提供隐藏/色标页；色标与隐藏需要新的本机偏好契约，未开放 |
| I110 | 修饰键锁存面板 | 实现已补齐，实机待验 | P3 · B70 | I110 | 三键独立锁存、关闭保留、物理键OR合并与Canvas/变换指针；DOM/状态回归通过，触控笔/Pad待人工；[B70](../verification.md) |
| I111 | 通用偏好设置 | 部分补齐：通用/文字/光标/导航/外观/历史预算/标签/紧凑选项栏/通知/界面动画/网格步长与分区搜索/应用；完整偏好仍未完成 | P3/P4/P6/P7/P8 · B5–B119 | I111 | 偏好对话框新增网格步长字段（2–4096），`normalizeEditorPreferences` 对该字段与其它数值字段一样严格校验并回退默认；视图菜单可直接切换标尺/网格/吸附显示偏好。仍无颜色管理、文件处理、界面语言与快捷键自定义等完整偏好集。 |
| I112 | 工具状态跨会话恢复 | 补齐现有工具；恢复/事件回归通过，设备待人工 | P3 · B34 | I112 | 版本化localStorage只存非默认工具参数及独立笔头、颜色和文字格式；临时工具/变换/草稿/目标/文档不存，字段严格恢复与保存失败提示；[B34](../verification.md) |
| I113 | 透明像素棋盘格设置 | 补齐；偏好/DOM通过，透明合成画面待人工 | P3 · B50 | I113 | 独立文件文档矩形，关闭/三档/上游预设与自定义双色，本机确认保存，缩放不改屏幕网格尺寸；[B50](../verification.md) |
| I114 | 文字属性编辑 | 部分补齐：字体/字号/颜色/粗体/对齐/方向/抗锯齿 + 行距/字距/基线/缩放/字重/下划线/删除线/连字/缩进/段距/连字符 | P4 · B118 | I114 | `text_preview.rs` 的草稿校验并提交全部已开放字符/段落字段（范围复核，未知字段拒绝），`editor-view-model.ts::decodeTextStyleDetail` 与 `text-style-controls.tsx` 提供选项栏控件，`use-text-editing.ts::updateStyle` 写入同一原生草稿。`text-style-controls.test.tsx` 与内核对应用例覆盖往返、越界拒绝与只记一步历史。OpenType 特性表、变体轴与单位切换仍未接入界面。 |
| I115 | 文字框类型转换与 Warp Text | 明确不支持：Warp Text 与形状转换未开放 | P4 · B116 | I115 | 点/段落框可在创建时选择，但没有类型转换、文字转形状或 Warp 预览；`type.convertTo*`/`type.warpText` 未开放 |
| I116 | 文字沿路径排版 | 明确不支持：依赖关闭的矢量路径 | P4 · B116 | I116 | `type.path` 与 `vector.path` 显式关闭；不提供路径文字悬停光标或路径目标 |
| I117 | 新建文字层占位文本 | 补齐；文字状态/宿主回归通过，设备待人工 | P4 · B35 | I117 | 新建点/段落草稿默认Lorem Ipsum并全选；偏好可关闭，已有文字不替换；取消不产生正式内容；[B35](../verification.md) |
| I118 | 默认文字样式保存与载入 | 补齐；原生CPU/实际菜单通过，画面待人工 | P4 · B39 | I118 | 原生Session保存字符/段落默认样式不dirty；新文字草稿沿用且颜色取前景；载入目标一次历史、锁/草稿/参数门禁，默认样式不随工程或偏好保存；[B39](../verification.md) |
| I119 | 刷新全部文字层 | 补齐；原生CPU/实际菜单通过，画面待人工 | P4 · B38 | I119 | 严格无参、全部文字原生重建，scratch原子发布且一步历史；无文字/锁定/后台/草稿拒绝，公开能力协商与菜单/搜索一致；[B38](../verification.md) |
| I120 | 插入 Lorem Ipsum 占位文字 | 补齐；实际菜单回归通过，设备待人工 | P4 · B37 | I120 | 文字菜单插入Lorem Ipsum；编辑态替换UTF16选择，新建态10%内边距段落草稿同步提交；候选确认失败保留；[B37](../verification.md) |
| I121 | 字体选择器滚轮切换 | 补齐当前字体列表；DOM通过，设备待人工 | P4 · B31 | I121 | 自有字体菜单关闭时悬停滚轮切换并夹紧，列表打开/禁用不改字体；共享字体字段立即应用，未借此扩大字体库；[B31](../verification.md) |
| I122 | 打开文档时提示缺失字体 | 补齐；只读查询/实际提示通过，设备待人工 | P4 · B40 | I122 | 基于原生FontDb精确查询缺失family，打开/正式修订后刷新；只读保留替代字体提示，不借DOM字体猜测或暗改工程；[B40](../verification.md) |
| I123 | 批量替换缺失字体 | 补齐；CPU/真实宿主弹窗通过，画面待人工 | P4 · B40 | I123 | 宿主映射窗口或全部改Inter；只接受当前缺失来源和已加载支持字体，锁定目标/未知参数拒绝；单步撤销、空映射不写；[B40](../verification.md) |
| I124 | 字体列表悬停预览 | 补齐当前字体列表；草稿回归通过，画面待人工 | P4 · B36 | I124 | 字体行悬停进入原生文字候选；移开/关闭恢复，自动开启的会话取消；已有草稿保留、选择接入原提交路径，悬停不写工具记忆或历史；[B36](../verification.md) |
| I125 | 文字字号快捷调整 | 补齐快捷键解析与草稿步进；真实排版与IME待人工 | P4 · B114 | I125 | `resolveFontSizeStep` 处理Mod+Shift+`,`/`.`，默认2pt、Alt/Option 10pt；输入层将其写回文字草稿并夹紧0.1–1296pt；单元回归通过；系统输入法与真实字形待人工 |
| I126 | 智能引号输入偏好 | 补齐；键入/粘贴/IME回归通过，真实输入法待人工 | P4/P7 · B16 | I126 | 默认智能引号及本机偏好；只处理insertText，粘贴/替换/组合原文不转换，UTF16选择位置不变；[B16](../verification.md) |
| I127 | Type 编辑格式快捷键 | 补齐字号与格式组合到草稿提交；行距/基线/字距/连字符按相对步进写入原生字段 | P4 · B118 | I127 | `text-format-shortcuts.ts` 解析组合，App 的 `onFormat` 现在把大写/下划线/删除线/伪粗斜体/连字符与行距、基线、字距的相对步进写进文字草稿（`updateStyle`），不再是空分支。真实输入法与字形效果待人工验证。 |
| I128 | IME 预编辑状态反馈 | 补齐预编辑范围显示；DOM/宿主通过，真实IME候选窗待人工 | P4/P7 · B16 | I128 | 组合起点与替换范围保持UTF16身份，更新后向native查询字形簇四边形，下划线随旋转/缩放投影；结束/取消清除，不用DOM估算文字宽度；[B16](../verification.md) |
| I129 | 字形浏览与插入 | 明确不支持：无字形面板数据源 | P4 · B116 | I129 | 固定字体集合不暴露字形网格查询端口，菜单与面板均无 Glyphs 入口；不复制无数据的 Glyphs 面板 |
| I130 | 文档拼写检查流程 | 实现补齐；原生/DOM/真实WASM通过，设备待人工 | P4 · B107 | I130 | 英文SCOWL检查、当前/全部层、逐词建议/忽略/更改、全部更改及本机用户词典；原生字符范围/全目标锁/结果预算/scratch一步历史，文档/owner/top复核；[B107](../verification.md) |
| I131 | 字符/段落样式集合 | 明确不支持：文字样式集合是新的可持久化契约 | P4 · B116 | I131 | 现有默认文字样式与会话默认值可用；命名样式集合需要新的工程/偏好契约，未开放 |
| I132 | 画笔设置与预设 | 部分补齐：可视预设面板（列表/应用/更新/删除）+ 存储当前画笔；无画笔动态设置面板 | P5 · B118 | I132 | `brush-preset-panel.tsx` 列出内置与自定义预设并只对自定义项提供更新/删除；`brush.presets.*` 写入不改内容身份。Brush Settings 的动态参数面板（纹理/散布/动态）仍未实现。 |
| I133 | 工具选项重置 | 现有工具补齐；DOM通过，设备待人工 | P5 · B30 | I133 | 选项栏当前工具图标右键重置当前/全部；全部先宿主确认，保留前后景色、文档和当前工具类别；画笔分别恢复、选区回New；[B30](../verification.md) |
| I134 | 数值字段算术表达式输入 | 补齐现有数值字段；参数/DOM通过，设备待人工 | P5 · B32 | I134 | 有界纯解析器：括号/优先级/幂/科学计数/pi/tau与受支持单位；尺寸/变换/画笔/图层/曲线/偏好/缩放接线，Enter/Tab/失焦确认，非法事务字段先使候选无效；[B32](../verification.md) |
| I135 | 画笔选项数值字段滚轮与拖动调值 | 补齐现有绘画参数；DOM通过，设备待人工 | P5 · B33 | I135 | 尺寸/角度/硬度/不透明度/流量/平滑数字框，悬停或聚焦后同画布滚轮，Shift10；数值/标签拖动、Alt0.1、最终坐标和取消恢复，保留原滑轨；[B33](../verification.md) |
| I136 | 笔刷预设选择与组织手势 | 部分补齐：可视预设列表与选择；无卡片预览与拖放分组 | P5 · B118 | I136 | 预设面板提供列表、应用、更新与删除；不再只有命令。卡片预览、拖放排序与分组仍未实现（属于新的本机布局契约）。 |
| I137 | 画笔光标样式 | 补齐当前圆笔尖；DOM/几何通过，画面待人工 | P5 · B62 | I137 | 标准/精确/50%正常/全尺寸、中心与绘画仅十字，固定上游衰减曲线；未开放形状见I132；[B62](../verification.md) |
| I138 | 其他工具精确光标偏好 | 补齐当前工具；DOM通过，指针待人工 | P5 · B62 | I138 | Move/Type/选区/油漆桶/吸管与文字输入层精确十字，本机候选确认；[B62](../verification.md) |
| I139 | 画笔绘制模式 | 实现补齐；CPU/DOM/真实WASM通过，画面待人工 | P5 · B88 | I139 | LayerModes及Dissolve后Clear、滚轮逐项夹紧、Brush/Pencil独立记忆；原生候选取消/一步历史；不污染图层blend；[B88](../verification.md) |
| I140 | Pencil 起点判色自动擦除 | 补齐；CPU像素/DOM通过，设备笔迹待人工 | P3 · B21 | I140 | 独立铅笔、B/Shift+B循环、独立笔头记忆、原生像素格吸附/硬边满流量、起点前景判色后整笔背景绘制；候选=提交、撤销与取消；[B21](../verification.md) |
| I141 | 橡皮擦模式 | 补齐；CPU像素/DOM通过，设备画面待人工 | P3 · B21 | I141 | Brush/Pencil/Block切换；Block按缩放换算16屏幕像素方块、忽略不适用参数，方形光标并关闭笔头HUD；[B21](../verification.md) |
| I142 | 绘画时临时擦除 | 补齐；宿主事件/参数通过，设备按键待人工 | P3 · B22 | I142 | Brush/Pencil反引号临时擦除，整笔冻结参数且工具不切换；keyup捕获跨字段恢复、失焦/隐藏清理、IME及字段门禁；[B22](../verification.md) |
| I143 | 绘画对称辅助 | 补齐；CPU镜像/DOM/WASM通过，设备轴线和笔迹待人工 | P5 · B23 | I143 | 四种轴与已有路径来源、画布轴线、中心/旋转拖动和15°吸附；候选仅轴线、Enter确认/Escape或失焦取消；模式不改内容/修订/历史；[B23](../verification.md) |
| I144 | 背景/魔术橡皮擦 | 补齐命令接线与工具组/选项；原生执行由固定引擎提供，画面待人工 | P1/P5 · B114 | I144 | 橡皮槽（槽 11）：`eraser`/`backgroundEraser`/`magicEraser` 三者同槽，按 E 组循环（原「背景/魔术橡皮擦被塞进润饰组、而橡皮自己在一级」的问题已修正）；参数编译`retouch-tools.ts`与选项`retouch-options.tsx`；16条`paint.*`命令进入白名单；释放整笔一次分派、点按类只提交一个坐标、取消不写、命令关闭时不派发；参数边界按原生注册表夹紧；真实笔迹与GPU画面待人工 |
| I145 | 数位笔姿态输入 | 部分补齐：同点落笔峰值；倾斜/旋转/笔端切换/压力曲线待做 | P5 · B44 | I145 | 同点pen合并事件/抬笔非零压力取接触峰值，移动笔迹沿用实际尾压；冻结参数重建单点候选、仅最终一步历史，迟到RAF代际隔离；[B44](../verification.md) |
| I146 | 颜色编辑 | 部分补齐：独立选择器/数值/目标颜色组；Color面板与文字范围/动态轨道待做 | P5 · B41/B42 | I146 | 像素与蒙版分别记忆前后景，默认黑白/白黑；宿主选择器含SV/色相/HSB/RGB/Lab/通用CMYK/HEX；取消不写，确认仅改工具色；[B41/B42](../verification.md) |
| I147 | 颜色选择器的 Web 色域与色板动作 | 部分补齐：216色/最近色/原色/色板；印刷ICC色域未支持 | P5 · B42 | I147 | 仅Web颜色限制与最近216色、原色恢复、显式加入本机色板；Lab超sRGB提示夹紧，CMYK通用换算明确无ICC，不伪造印刷色域结论；[B42](../verification.md) |
| I148 | 画布取色 | 部分补齐：独立吸管/尺寸/来源/采样环；应用颜色选择对话框未完成 | P5 · B24 | I148 | I工具，1/3/5/11/31/51/101平均与五来源；Brush/Pencil/Bucket临时吸管共用，Eraser排除；Alt背景色；native严格读取接口，CPU蒙版/DOM/WASM通过，实际合成颜色及颜色选择器联动继续待验；[B24](../verification.md) |
| I149 | 画布颜色取样点 | 明确不支持：无固定取样标记状态 | P5 · B116 | I149 | 吸管只读取当前指针颜色并设置前/背景；多点采样标记需要新的视图状态与 Info 联动，未开放 |
| I150 | 量尺、计数与测量记录 | 明确不支持：无测量/计数工具与记录面板 | P5 · B116 | I150 | 选框/Move/Info 读数共用测量单位，但工具栏与菜单不提供 Ruler/Count 工具，也无记录面板入口；比例设置、CSV 记录与比例尺标记未实现 |
| I151 | 画布便签 | 明确不支持：便签是新的持久化文档结构 | P5 · B116 | I151 | 便签需要文档级注释结构与 Notes 面板，工程格式未协商该结构；工具栏、菜单与命令白名单均无便签入口 |
| I152 | 色板管理 | 部分补齐：本机色板已持久化到 localStorage（最多 256 项）；分组与 ACO/ACT/ASE 导入导出仍缺 | P5 · B117 | I152 | `color-picker.tsx` 的 `readColorSwatches`/`writeColorSwatches` 把本机色板写入 `photocraft.color-swatches.v1`：只接受 `#rrggbb`、去重、小写并按 256 项截断，写入失败（隐私模式/配额）保持会话内可用并提示；`color-picker.test.tsx` 覆盖持久化、去重、损坏回退、上限与写入失败。仍缺上游 Swatches 面板的分组、ACO/ACT/ASE 导入导出与拖动排序——这些需要新的持久化与交换格式契约，保持未实现；两处入口一致，不显示占位面板。浏览器存储策略与真实色板面板画面待人工 |
| I153 | 调整层种类 | 部分补齐：菜单新增破坏性图像调整；调整层仍限三类 | P5 · B114 | I153 | 调整层白名单保持亮度/对比度、曲线、色相/饱和度；新开放的16种为 Image › 调整 破坏性命令，不新增持久化调整层类型或工程字段 |
| I154 | 调整层页脚菜单按下拖放选择 | 既有Radix行为等价；真实组件/控制器通过，设备待人工 | P5 · B57 | I154 | 按下打开、原地释放不执行、拖入释放创建一次；修正静态基线推断；[B57](../verification.md) |
| I155 | 菜单栏按下拖动跨菜单选择 | 补齐；真实组件/宿主通过，设备待人工 | P5 · B57 | I155 | 共享按下状态、跨标题/子菜单释放、空白/取消/失焦不执行，防延迟焦点关闭新菜单；[B57](../verification.md) |
| I156 | 长菜单滚动箭头 | 补齐；DOM/边界通过，设备布局待人工 | P5 · B56 | I156 | 下拉/子菜单/右键共用溢出箭头，悬停RAF、非passive滚轮、边界/取消隔离；[B56](../verification.md) |
| I157 | 调整层参数快速重置 | 补齐当前三类调整；DOM/控制器通过，手感待人工 | P5 · B53 | I157 | 滑杆双击单项0、整层默认值，候选合并/同步flush/只读无写；其它未开放调整见I153；[B53](../verification.md) |
| I158 | 调整层数值字段输入 | 补齐当前支持调整；DOM/控制器通过，设备待人工 | P5 · B55 | I158 | 精确数值/表达式、标签拖动、Shift/Alt、无效候选门禁与最终坐标；[B55](../verification.md) |
| I159 | 曲线控制点快捷操作 | 补齐；DOM/控制器通过，设备待人工 | P5 · B54 | I159 | 方向键1/10级、右键或Ctrl/Cmd删除、图外12px删除与拖回恢复、端点保护/取消；[B54](../verification.md) |
| I160 | 曲线通道与绘制模式 | 明确不支持：调整层仅保存单一 RGB points | P5 · B116 | I160 | 曲线编辑器只提供总曲线控制点，不显示通道选择或绘制模式开关；单通道曲线/铅笔绘制/Smooth 会改变已协商的持久化参数结构，未开放 |
| I161 | 图层样式与混合选项 | 部分补齐：创建/缩放/栅格化/扁平化 + 拷贝/粘贴/清除/隐藏/显示全部效果；Blend If 与样式预设库仍缺 | P6 · B114/B124 | I161 | 图层样式创建/缩放、栅格化图层样式、脚本扁平化全部效果进入白名单；本轮补上 `copyLayerStyle`/`pasteLayerStyle`/`clear`（含按索引删单个效果）与 `hideAllEffects`/`showAllEffects`，全部进入「图层 ▸ 图层样式」菜单。真实 WASM 冒烟验证拷贝→粘贴写文档并可撤销、清除可撤销、未拷贝时粘贴被拒绝。Advanced Blending、Blend If、Knockout、样式预设库、跨层复制样式与效果子行仍未实现。 |
| I162 | 图层效果烘焙、批量开关与缩放 | 补齐：创建图层/缩放效果/栅格化/扁平化全部效果 + 隐藏/显示全部效果 | P6 · B124 | I162 | 四类烘焙/缩放命令进入白名单与菜单；本轮补上 `layer.layerStyle.hideAllEffects`/`showAllEffects`（白名单 + 图层样式菜单），一次原子切换所有含效果的层，各记一步历史。真实 WASM 冒烟验证加效果 → 隐藏 → 显示 → 两次撤销回原状态。画面待人工。 |
| I163 | File › Scripts › Flatten All Masks | 实现补齐；CPU/DOM/真实WASM通过，画面待人工 | P6 · B87 | I163 | 启用像素/矢量蒙版仅烘焙raster；组等skip、禁用保留；全目标锁/预算预检与一步撤销；[B87](../verification.md) |
| I164 | 纯色/渐变/图案填充层 | 明确不支持：填充层是未协商的持久化图层类型 | P6 · B116 | I164 | 工程核验显式拒绝填充图层，图层面板「新建填充图层」菜单项不出现；不新增可持久化 fill 内容，图层样式叠加保持独立 |
| I165 | Gradient 工具画布内编辑 | 明确不支持：依赖填充层与渐变编辑器 | P6 · B116 | I165 | 梯度填充层未开放，工具栏与菜单无 Gradient 工具入口；不提供画布端点/色标编辑或 Gradient Editor |
| I166 | Smart Object 嵌入内容工作流 | 明确不支持：智能对象属关闭能力 | P6 · B116 | I166 | `layer.smart-object` 显式关闭；不提供嵌入内容编辑/替换/导出 |
| I167 | 从历史记录填充 | 部分补齐：独立命令/快捷键、最早或显式状态及像素/蒙版；Quick Mask未完成 | P6 · B105/B106 | I167 | Ctrl/Cmd+Alt+Backspace与菜单同命令，不注入调色盘；严格state范围/锁/预算/目标缺失拒绝，一步历史及undo；上游默认来源即最早保留状态，无需额外标记界面；Quick Mask仍缺；[B105/B106](../verification.md) |
| I168 | 滤镜与智能滤镜 | 明确不支持：复杂滤镜与智能滤镜未开放 | P6 · B116 | I168 | `filter.complex`/`filter.liquify` 关闭；不提供 Filter Gallery、Camera Raw 或智能滤镜堆栈 |
| I169 | 直接图像调整 | 补齐破坏性调整入口；参数/DOM通过，画面待人工 | P6 · B114 | I169 | Image › 调整 接入自动色调/自动对比度/自动颜色、色阶、曝光、自然饱和度、色彩平衡、黑白、照片滤镜、通道混合器、反相、色调分离、阈值、渐变映射、可选颜色、去色、色调均化；表单字段与原生注册表一致、越界拒绝；Replace Color 仍未实现 |
| I170 | Image › Trap 陷印 | 明确不支持：无 CMYK 印刷陷印工作流 | P6 · B116 | I170 | `color.cmyk` 转换虽可执行，但陷印属印刷专有能力与参数契约，本产品不开放 `image.trap` |
| I171 | Edit › Fill 对话框 | 部分补齐：九来源/混合/偏好/重置及像素/蒙版；Quick Mask/通道未接入 | P6 · B105 | I171 | Shift+F5/Shift+Backspace、来源特定参数、确认才记忆/Alt取消重置；strict当前目标/锁/预算及scratch一步历史；Quick Mask/通道仍缺，画面待人工；[B105](../verification.md) |
| I172 | 淡化最近一次操作 | 补齐菜单/表单与命令门禁；画面待人工 | P6 · B114 | I172 | Edit › 淡化 打开不透明度/模式表单，确认分派`edit.fade`，取消零写；提示说明该命令作用于最近一步像素操作；原生行为与无效目标拒绝由固定引擎提供 |
| I173 | 多文字图层查找与替换 | 实现补齐；原生/DOM/真实WASM通过，设备画面待人工 | P6 · B104 | I173 | 原生匹配/游标、当前或全部文字层、大小写/整词/前后搜索及四动作；全目标锁/100000字符预检、scratch原子发布，查找不改内容历史；专属宿主表单与过期归属隔离；[B104](../verification.md) |
| I174 | 选区/图层边缘描边 | 补齐；原生/DOM/真实WASM通过，设备画面待人工 | P6 · B108 | I174 | 1–250px、当前前景/记忆颜色、内中外/混合/不透明度/保透明，选区或raster alpha边缘；填色与样式独立，padding预算/锁/scratch一步历史和确认记忆；[B108](../verification.md) |
| I175 | 按内容修整与显示画布外像素 | 实现补齐；CPU/DOM/真实WASM通过，画面待人工 | P6 · B89 | I175 | 三种原生依据、四边开关及成功后记忆；Reveal All恢复off-canvas像素、noop不写，scratch预算/一步历史；[B89](../verification.md) |
| I176 | 变换模式 | 部分补齐：再次变换/再次变换并复制快捷键与菜单；斜切/透视/扭曲/Warp 未实现 | P6 · B114 | I176 | `edit.transform.again`/`againCopy` 进入白名单并映射 Mod+Shift+T / Mod+Alt+Shift+T；斜切、透视、扭曲、Warp、参考点Alt放置与 Legacy 偏好仍未实现 |
| I177 | 图层列表筛选、面板选项与飞出菜单 | 部分补齐：查找/隔离、Kind/Name 筛选与「重排时在画布预览」开关；面板选项对话框与 Mode 筛选仍缺 | P6 · B117/B127 | I177 | `select.findLayers`/`isolateLayers` 提供查找与隔离；图层列表新增种类与名称筛选栏（仅影响显示，保留命中行的祖先、不派发选择或命令），以及本机偏好 `previewLayerReorder` 控制拖动画布预览。`layer-panel-interaction.test.tsx` 覆盖筛选只改显示。仍无按混合模式筛选、面板选项对话框与缩略图裁剪偏好。 |
| I178 | 活动图层自动展开与滚动定位 | 补齐；自动回归通过，实机待核验 | P6/P7 · B1 | I178 | `photo-editor-panels.tsx` 活动目标祖先展开与局部滚动；`group-panel-interaction.test.tsx` 验证不覆盖手动折叠/滚动；[B1 验证](../verification.md) |
| I179 | 图层面板滚动位置按文档保留 | 补齐；工作区状态回归通过，实机待核验 | P6 · B2 | I179 | `use-layer-scroll-position.ts` 按 controller/session 保存，短列表钳制不覆盖原位置；对应 hook 回归；[B2/B3 验证](../verification.md) |
| I180 | 图层批量选择、查找与隔离 | 补齐；状态/DOM/WASM通过，浏览器待核验 | P6 · B3 | I180 | `layer_selection_commands.rs`、查找宿主弹窗、隔离列表与退出按钮；历史/指纹/clean 不变及过滤间隙拒绝剪贴回归；[B2/B3 验证](../verification.md) |
| I181 | 批量删除隐藏图层 | 补齐；原生事务通过，浏览器待核验 | P6 · B3 | I181 | `layer_cleanup_commands.rs` 完整候选树、锁定后代/最后一层预检、剪贴基底修复；菜单和一步撤销回归；[B2/B3 验证](../verification.md) |
| I182 | File › Scripts › Delete All Empty Layers | 补齐；原生事务通过，浏览器待核验 | P6 · B3 | I182 | 文件 > 脚本 > 删除全部空层；完整候选树保留带蒙版/效果像素层，空组递归清理；全删拒绝与撤销回归；[B2/B3 验证](../verification.md) |
| I183 | File › Scripts › Browse | 补齐当前文档Web字节脚本；原生/WASM通过，实机待验 | P6 · B94 | I183 | UTF-8 JSON/txt/pcdroplet、256KiB/32步、现有命令逐步门禁、隔离执行全成功发布；路径/JS/递归/生命周期/全局清理不开放；[B94](../verification.md) |
| I184 | 图层重排拖动启动区域 | 部分补齐：行/内容/眼睛/像素蒙版；效果专用拖动未完成 | P6/P7 · B1–B3 | I184 | 整行拖动回归，眼睛扫动见 I201，像素蒙版见 I219；效果/智能滤镜专用拖动仍待实施；[B2/B3 验证](../verification.md) |
| I185 | 图层拖放到面板页脚 | 补齐；自动回归通过，原生拖放待实机 | P6/P7 · B1 | I185 | `layer-panel-interaction.test.tsx` 页脚删除/复制/编组、落点提示、过期选择/只读/能力关闭；[B1 验证](../verification.md) |
| I186 | 图层垃圾桶删除确认 | 补齐；宿主弹窗回归通过，实机待核验 | P6 · B2 | I186 | `layer-action-dialogs.tsx` 默认确认/Alt bypass/成功后持久 skip；owner、selection、顶层实例复核；菜单/键盘保持原路由；[B2/B3 验证](../verification.md) |
| I187 | 图层行空白区域单击选择 | 补齐；DOM 回归通过 | P6 · B1 | I187 | `layer-panel-interaction.test.tsx` 行内空白修饰键选择、专用控件隔离；[B1 验证](../verification.md) |
| I188 | 图层列表拖动边缘自动滚动 | 部分补齐：图层边缘/视口外滚动；效果/智能滤镜未接入 | P6 · B2–B3 | I188 | `use-layer-drag-scroll.ts` 限速600px/s、帧间隔钳制、全局拖动追踪与结算清理；hook 回归；原生拖放待实机；[B2/B3 验证](../verification.md) |
| I189 | 点击图层列表空白区取消选择 | 补齐；DOM/状态/WASM通过 | P6 · B2 | I189 | 列表纯空白点击路由 select.deselectLayers；不改内容/历史；readonly/allowed/enabled 门禁；[B2/B3 验证](../verification.md) |
| I190 | 图层间 Alt/Option 单击剪贴切换 | 补齐；DOM/原生/WASM通过，光标视觉待人工 | P6 · B3 | I190 | 显式 layer.toggleClippingAt 双目标严格参数、相邻同级/过滤间隙验证、锁定链预检、候选一次提交；释放选择上层，创建保留原选择；[B2/B3 验证](../verification.md) |
| I191 | 新建图层入口与选项 | 补齐；参数/弹窗/原生通过，中性色画面待人工 | P6 · B2–B3 | I191 | `new-layer-dialog.tsx` 内核 nextLayerName、颜色/混合/不透明度/剪贴/中性色；页脚修饰键与 new_layer_options 严格预检；[B2/B3 验证](../verification.md) |
| I192 | 图层颜色标签管理 | 补齐；身份/持久化/DOM通过，标签视觉待人工 | P6 · B3 | I192 | protocol 标签枚举、右键颜色子菜单/组传播、眼睛事件冒泡同一路径；新能力版本及共享metadata fixture、无渲染往返；[B2/B3 验证](../verification.md) |
| I193 | 通过剪切新建图层 | 补齐；事务/容量/历史通过，像素画面待人工 | P6 · B3 | I193 | Layer via Cut 菜单与 Mod+Shift+J；活动像素/隐藏/锁定/蒙版预检；成功取消选区、一步历史/撤销重做、64层拒绝；[B2/B3 验证](../verification.md) |
| I194 | 非破坏式合并盖印 | 已接通；参数/容量/菜单回归通过，合成结果待人工 | P3/P4/P6/P7 · B5 | I194 | stampVisible/stampDown候选会话一次publish，快捷键与Alt合并菜单变体；能力关闭不回退破坏性合并；无GPU未执行成功合成测试；[B5 验证](../verification.md) |
| I195 | 背景图层转普通图层的手势 | 补齐；DOM/内核回归通过 | P6 · B1 | I195 | `layer-panel-interaction.test.tsx` 整行双击/解锁；`interaction_state.rs` 权威背景标记与可撤销转换；[B1 验证](../verification.md) |
| I196 | 从普通图层创建背景层 | 部分接通：普通无剪贴链图层；合成验收与剪贴链仍缺 | P3/P4/P6/P7 · B5 | I196 | backgroundFromLayer菜单/候选/既有背景与锁定预检；保留标签链接；相关剪贴链先拒绝，未声称全分支闭环；成功画面待GPU；[B5 验证](../verification.md) |
| I197 | 透明边缘去杂色 | 补齐；CPU像素事务/参数/弹窗通过，边缘视觉待人工 | P3/P4/P6/P7 · B5 | I197 | Defringe宽度、黑白matte、Color Decontaminate数量/半径；严格参数、像素锁/蒙版目标门禁、候选一步撤销及alpha保持回归；[B5 验证](../verification.md) |
| I198 | 图层内容缩略图双击快捷入口 | 部分补齐：文字/调整/像素样式；其他层类型未接入 | P6 · B3 | I198 | 内容双击和行空白双击分流，pending layerEditRequest 等待权威活动层再打开；智能对象/填充/形状入口继续待实施；[B2/B3 验证](../verification.md) |
| I199 | 图层名称连续重命名导航 | 补齐；DOM 回归通过，真实 IME 待核验 | P6 · B1 | I199 | `layer-panel-interaction.test.tsx` Tab/Shift+Tab、全选、边界、失败保留、Escape/IME、blur 不重复提交；[B1 验证](../verification.md) |
| I200 | 图层导航快捷键 | 补齐；键盘解析/内核回归通过，实机待核验 | P6 · B1 | I200 | `photo-editor-shortcuts.test.ts` 物理键码/Mac/IME；`interaction_state.rs` 折叠行、扩选去重、内容/历史与 clean 状态不变；[B1 验证](../verification.md) |
| I201 | 图层眼睛列修饰键与扫动 | 补齐；取消/异常/一步历史通过，原生扫动待人工 | P6/P7 · B1–B2 | I201 | `beginLayerVisibility` 独立草稿、FrameEditSession 合帧、跨行含跳过行、锁定眼睛可编辑；pointercancel/blur/Escape/卸载/readonly 取消；启动失败不回退单击；[B2/B3 验证](../verification.md) |
| I202 | 图层对齐与分布控制 | 补齐Move入口；原生/DOM通过，实机待验 | P6 · B96 | I202 | 六按钮、六对齐/八分布菜单；有选区优先selection，否则单层画布/多层组合边界，复用原生门禁与一步历史；[B96](../verification.md) |
| I203 | 反转所选图层堆叠顺序 | 补齐；原生历史/锁定回归通过 | P6 · B3 | I203 | Layer Arrange Reverse；selected_roots 同级/全成员锁定预检，反序与一步撤销；[B2/B3 验证](../verification.md) |
| I204 | 图层链接与选择已链接层 | 补齐；身份/持久化/选择回归通过，链接移动画面待人工 | P6 · B3 | I204 | 菜单/右键/页脚链接和选择已链接层；内容指纹用树遍历归一链接组；transform_targets 包含已链接层，独立蒙版保持单目标；[B2/B3 验证](../verification.md) |
| I205 | 图层行混合模式摘要 | 已实现摘要；视觉/布局待人工验证 | P6 · B1 | I205 | `photo-editor-panels.tsx` 非默认混合摘要；`photo-editor.css` 容器宽度不足时隐藏；DOM 已验证，桌面/Pad 视觉未采集；[B1 验证](../verification.md) |
| I206 | 按图像内容自动对齐与混合图层 | 明确不支持：自动对齐/混合需内容配准流水线 | P6 · B116 | I206 | 图层对齐/分布只按几何边界；`edit.autoAlignLayers`/`autoBlendLayers` 未开放 |
| I207 | 混合模式预览与下拉手势 | 补齐；候选/DOM/WASM通过，菜单布局待人工 | P3/P6/P7 · B4 | I207 | `layer-blend-field.tsx` 按下展开/悬停候选/离开取消/拖放确认/滚轮不越界；多层内核草稿、PassThrough严格门禁、noop保留redo；[B4 验证](../verification.md) |
| I208 | 混合模式快捷键循环 | 部分补齐：图层/Brush/Pencil循环；Gradient未开放 | P3/P6/P7 · B4/B21/B72 | I208 | Shift加减按图层或独立Brush/Pencil参数循环；Pencil真实paint.pencil/Dissolve参数回归通过，Gradient仍待实现；[B72](../verification.md) |
| I209 | 图层不透明度/填充的调整控件 | 补齐；批量草稿/DOM通过，弹层定位待人工 | P3/P6/P7 · B4 | I209 | 数值与标签scrub、Shift加速/Alt细调、anchored弹出range、滚轮180ms合帧及聚焦画布路由；取消和全选锁预检；[B4 验证](../verification.md) |
| I210 | 工具组 flyout 的拖动选取 | 补齐；DOM 回归通过（槽位成员与手势同测），真实指针待核验 | P1/P3/P5/P7 · B128 | I210 | `tool-slot-button.test.tsx` 覆盖长按 350ms/拖出即开/释放选取/外部释放取消/Escape/再点关闭/禁用与卸载清理；`photo-editor-chrome.test.tsx` 断言 5 段 16 槽、单成员无三角、多成员有三角、槽内任一成员高亮；`toolbar-slots.test.ts` 断言每槽成员与上游一致（原「只测选框组机制却推断全部分组」的问题已由结构门禁补上）；真实指针待人工 |
| I211 | 面板 | 部分补齐：属性/图层/历史及导航/直方图/信息；Channels/Paths/Actions/Comps 等未实现 | P7 · B116 | I211 | 现有面板可控显隐与折叠；不渲染无数据源的面板壳 |
| I212 | 面板自由停靠与分组 | 明确不支持：侧栏为固定分组 | P7 · B116 | I212 | 只支持整体侧栏浮动/停靠与单一分栏，面板不提供拆分/合并控点；不提供任意组拆分/合并布局引擎 |
| I213 | 时间轴面板与帧播放 | 明确不支持：无视频时间轴文档模型 | P7 · B116 | I213 | `timeline.*` 未开放；不复制无内容的时间轴面板 |
| I214 | 视频图层逐帧操作 | 明确不支持：无视频图层类型 | P7 · B116 | I214 | 图层内容为静态图像/工程支持的种类，时间轴与视频图层菜单项不出现；视频层与帧操作未开放 |
| I215 | 历史面板与快照 | 部分补齐：状态跳转/删除、快照创建/选择/重命名/删除与历史跟随、History Brush 来源状态；快照缩略图与新文档来源仍缺 | P7 · B29/B91–B93/B121 | I215 | 已有原生单命令历史跳转、三种来源快照及严格参数/会话生命周期；当前/过去状态删除及上限同名历史跟随已回归；双击/右键/本次拖动垃圾桶删除已回归。History Brush 的来源状态由 I011 的润饰选项提供（`historyState` → `paint.historyBrush` 的 `state`），因此 B116 记的「History Brush 来源仍缺」已补齐。快照缩略图与新文档来源仍未实现。[B29/B91–B93](../verification.md) |
| I216 | 界面语言 | 明确不支持：界面文案固定中文 | P7 · B116 | I216 | 编辑器文案固定中文，偏好设置不提供语言选择（不显示无效果的下拉框）；CJK 字体回退由固定字体集合覆盖 |
| I217 | Alt/Option 拖放复制图层 | 补齐；DOM 回归通过，浏览器拖放待实机 | P7 · B1 | I217 | `layer-panel-interaction.test.tsx` Alt 复制光标/选中集合/自身边缘复制/释放 Alt 恢复移动/外部载荷拒绝；[B1 验证](../verification.md) |
| I218 | 图层重排的画布预览 | 补齐重排画布预览；原生候选/DOM 通过，真实拖放画面待人工 | P6/P7 · B117 | I218 | `rust/crates/editor-core/src/reorder_preview.rs` 提供只读候选：按落点执行与提交相同的 `layer.moveTo` 参数，`Editor::begin_reorder_preview/preview_reorder/end_reorder_preview` 暴露给 WASM（`beginReorderPreview`/`previewReorder`/`endReorderPreview`），候选文档只进入 `preview_document` 供合成，正式文档、历史、修订与内容指纹不变；`tests/reorder_preview.rs` 断言候选不改正式状态、非法落点保留上一次有效候选、释放后正式 `layer.moveTo` 才记一步历史。面板在 dragOver 时更新候选，Alt 复制不预览；本机偏好可关闭。真实拖放画面与 GPU 合成待人工 |
| I219 | 蒙版缩略图拖到垃圾桶 | 部分补齐：像素蒙版；矢量蒙版未开放 | P7 · B3 | I219 | 独立 mask MIME、目标复核、垃圾桶应用/删除宿主弹窗；直接垃圾桶按mask目标删除；取消/readonly/目标失效无写；原生拖放待实机；[B2/B3 验证](../verification.md) |
| I220 | 图层/蒙版缩略图载入选区与蒙版查看 | 部分补齐：缩略图载入选区 + 反斜杠红色叠加视图；叠加颜色/密度偏好仍缺 | P7 · B119 | I220 | `layer.toggleMaskOverlay` 进入白名单、图层蒙版菜单与反斜杠快捷键，`editor-view-model.ts` 投影 `maskOverlay`（只有活动层确有蒙版且模式为 overlay 才报告）。真实 WASM 冒烟断言叠加**不改变内容指纹、不产生历史**并在再次切换后回到 null。红色/自定义叠加颜色、密度与持久化 Mask Options 仍未实现。 |
| I221 | 活动调整/填充层行名的编辑目标 | 部分补齐：活动调整层目标分流；填充层未开放 | P7 · B3 | I221 | 名称/空白再次单击带蒙版的活动调整层切mask；内容缩略图切pixels，多选修饰键保留选择规则；DOM回归；[B2/B3 验证](../verification.md) |
| I222 | 选区工具上的 Cmd/Ctrl 临时移动 | 部分补齐：选区内像素/外整层移动复制；参考线优先级未接入 | P3/P6/P7 · B4 | I222 | `TransformPreview` 复用CutParts候选，像素复制不复制整层；wholeLayer保留原选区，2px Alt阈值；状态/DOM/WASM回归，参考线工具尚未开放；[B4 验证](../verification.md) |
| I223 | 羽化选区边缘的拖动命中 | 补齐；真实覆盖度状态/DOM/WASM通过，羽化视觉待人工 | P7 · B3 | I223 | `Editor::selection_contains`/selectionContains 直接读取floor像素覆盖度>0，有限/边界校验；稀疏1024²/低覆盖度 fixture，UI轮廓不再参与权威命中；[B2/B3 验证](../verification.md) |
| I224 | 选区工具方向键移动边界/像素 | 补齐；快捷键/原生状态通过，实机待核验 | P3/P6/P7 · B4 | I224 | `nudgeTarget` 将选区工具普通方向键路由边界、Mod路由所选像素，Shift10px；活动手势不打断，无选区不执行；[B4 验证](../verification.md) |
| I225 | Type 编辑的画布外点击提交 | 补齐；原生文字框/DOM通过，真实排版待人工 | P3/P4/P6/P7 · B5 | I225 | point text使用native logical bounds四边形，paragraph box保留原框；框外提交且不创建新文字，IME/无布局保护；[B5 验证](../verification.md) |
| I226 | Type 编辑 Escape 提交偏好 | 补齐；偏好/DOM通过，真实IME待人工 | P3/P4/P6/P7 · B5 | I226 | Escape默认提交，可在本机偏好关闭后取消；App捕获及textarea共用同值，确认/取消/持久化回归；[B5 验证](../verification.md) |
| I227 | Type 编辑期间保存 | 补齐；检查点/保存事务通过，画面与真实IME待人工 | P4/P7 · B10 | I227 | 文字检查点scratch原子发布并rebase，保存不结束输入；无变化不加history，保存后取消保留检查点；非法候选不得导出旧内容；[B10](../verification.md) |
| I228 | Type 编辑中的 Tab 输入 | 补齐；DOM回归通过，真实IME/排版待人工 | P3/P6/P7 · B4 | I228 | 未修饰Tab替换当前UTF16选择，更新插入点并保留编辑；ShiftTab/IME不插入、不触发面板快捷键；[B4 验证](../verification.md) |
| I229 | Move 工具双击文字进入编辑 | 已接通；DOM/类型通过，拾取与插入点待人工 | P3/P4/P6/P7 · B5 | I229 | Move画布无修饰双击只读pickAt，命中文字后选择并带坐标beginText，切Type；非文字不创建新层；[B5 验证](../verification.md) |
| I230 | Type 编辑中的连续多击选取 | 补齐；内核范围/DOM通过，真实连续点击待人工 | P3/P4/P6/P7 · B5 | I230 | 连续1–5击后循环；Unicode词、原生visual line、paragraph、全文；range按UTF16返回，点按释放不折叠范围；[B5 验证](../verification.md) |
| I231 | Type 编辑段落框缩放 | 补齐段落框八手柄缩放与 Alt 中心对称；原生/DOM 通过，真实指针与字形画面待人工 | P7 · B117 | I231 | `text_preview.rs` 的草稿 `update` 接受 `box`：严格校验四个有限坐标与正尺寸，只在候选文档上把框原点/尺寸写入原生 `TextShape::Box` 并保留线性变换；`tests` 覆盖缩小、Alt 中心镜像、非法框保留上一候选、点文字保持点文字、新建段落草稿采用候选框。`text-box-resize.ts` 按上游 `box_handle_at`/`resize_box` 语义实现八个手柄命中（6 屏幕像素容差、4 文字空间像素最小尺寸）、旋转矩阵还原与 Alt 镜像；`text-input-overlay.tsx` 在命中手柄时冻结框与变换、拖动写草稿、取消不提交，`use-text-editing.ts::resizeBox` 走同一原生 `previewText` 路径。真实指针命中、旋转框与 GPU 字形画面待人工 |
| I232 | Type Mask 文本转选区 | 补齐命令门禁；无 Type Mask 工具输入流程 | P7 · B114 | I232 | `type.createSelection` 进入能力白名单，文字菜单"文字蒙版转选区…"复用原生字形覆盖度生成一步选区；仍未提供临时 Type Mask 工具或输入后自动删除临时图层的画布工作流 |
| I233 | Shift 单击在现有文字上新建文字 | 补齐；DOM/原生容量与取消通过，画布待人工 | P3/P4/P6/P7 · B5 | I233 | Shift按下锁存forceNew，严格布尔/互斥已有layer、64层拒绝；草稿取消无写，不调用字形栅格化测试；[B5 验证](../verification.md) |
| I234 | 画布拖动调整笔刷 | 已接通当前Brush/Eraser；DOM/纯几何通过，原生手势待人工 | P7 · B7 | I234 | CtrlAlt左拖/非Mac Alt右拖、固定HUD、抬起一次工具设置、取消不写；垂直硬度/不透明度偏好；25%尺寸与硬度刻度、德语符号键；保持现有512px资源上限；[B7 验证](../verification.md) |
| I235 | 绘画笔迹的 Shift 拖动约束 | 补齐；几何/DOM通过，真实笔压与绘画视觉待人工 | P7 · B6 | I235 | Shift从起点/中途按下位置锁定八方向，3屏幕像素阈值、压力保留、抬笔同路由；同文档跨图层/工具/目标保留连接锚点，Shift悬停线预览；[B6 验证](../verification.md) |
| I236 | Move 工具方向键修饰与变换框微移 | 部分补齐：Alt复制微移与Mod临时移动；历史合并/变换框未完成 | P3/P6/P7 · B4 | I236 | 平台解析保留Alt/Shift/Mod，Move所选像素与整层区分；仍按键释放结算，1秒合并偏好和自由变换框微移待实施；[B4 验证](../verification.md) |
| I237 | 绘制中选区空格移位的边界约束 | 补齐；几何/DOM通过，越界操作待人工 | P7 · B6 | I237 | 空格平移全部手势几何且不夹紧文档边界；释放后保留新起点，自动平移不重新夹紧；marquee/lasso越界及取消回归；[B6 验证](../verification.md) |
| I238 | 画笔角度方向键调整 | 补齐当前Brush/Eraser；参数/宿主回归通过，笔尖画面待人工 | P3/P7 · B19 | I238 | 无修饰←/→1°、Shift15°，Alt/Mod不旋转；本机笔尖角度和native brush patch，半笔不改参数；[B19](../verification.md) |
| I239 | 多文档排列与视图匹配 | 明确不支持：单画布只呈现活动文档 | P7 · B116 | I239 | 工作区可持多文档但只渲染活动项，窗口菜单不提供排列/视图匹配项；平铺/级联与第二视图未开放 |
| I240 | 多文档键盘循环切换 | 补齐；DOM通过，平台按键投递待人工 | P7 · B9 | I240 | Ctrl+Tab / Ctrl+Shift+Tab循环与绕回；字段capture、草稿先提交，失败/IME/半笔拒绝；浏览器是否保留Ctrl+Tab须实机核验；[B9](../verification.md) |
| I241 | 图层状态与编辑目标快捷键 | 补齐；快捷键回归通过，原生键盘待人工 | P7 · B6 | I241 | Mod逗号显式活动层显隐、/透明锁、Mod反斜杠蒙版与Mod2合成目标；遵守已有命令能力、全部锁与草稿门禁，IME/Alt/Shift排除；[B6 验证](../verification.md) |
| I242 | 数字键百分比快捷键 | 部分补齐：当前绘画/桶/图层分派；Gradient/build-up未实施 | P3/P6/P7 · B4/B72 | I242 | 800ms、0/00、作用域隔离；桶自身1%下限/Shift无写，Pencil无flow、Brush/Eraserflow最低1%，图层opacity/Shift fill独立；[B72](../verification.md) |
| I243 | View 屏幕模式 | 实现已补齐，窗口/画面待实机 | P3/P7 · B46/B71 | I243 | 三模式、F/按钮长按、全屏Tab原组合、标签/滚动条与窗口状态；DOM/协议/唯一布局矩形通过，真实浏览器/Pad/GPU待人工；[B71](../verification.md) |
| I244 | Pasteboard 颜色与快捷循环 | 补齐；偏好/Canvas/宿主DOM通过，画面待人工 | P7 · B64 | I244 | 六档色/自定义、投影/线/无边界、默认主题点纹与空工作区订阅；Space+F/Shift反向和输入/半笔门禁；不遮节点宿主，不改透明网格或内容；[B64](../verification.md) |
| I245 | 仅镜像画布视图 | 明确不支持：视口无镜像状态 | P7 · B116 | I245 | 菜单中的水平翻转改写像素；非破坏视图镜像未开放 |
| I246 | 固定缩放与适配所选图层 | 补齐；阶梯/DOM通过，设备取景待人工 | P7 · B17 | I246 | View 200%、Print Size（本机屏幕PPI/文档DPI）、Fit Layer(s)及Alt内容缩略图；native内容边界居中，空内容回退整图；[B17](../verification.md) |
| I247 | 非正方形像素比例预览 | 明确不支持：无像素宽高比显示状态 | P7 · B116 | I247 | 画布横纵同比例呈现，视图菜单不提供像素宽高比项；像素宽高比预设/校正属视图参数，未开放 |
| I248 | Pattern Preview 平铺编辑 | 明确不支持：无平铺视图与边缘环绕绘画 | P7 · B116 | I248 | 画布只渲染单份文档，View 菜单不提供 Pattern Preview 开关；图案库仅作效果素材 |
| I249 | Pixel Art Preview 占位开关 | 明确不支持；入口/命令关闭已验证 | P7/P8 · B73 | I249 | 无渲染消费者的菜单勾选不复制；逐像素网格I250保持独立；12id原生/真实WASM拒绝且状态不变，菜单回归通过；[B73](../verification.md) |
| I250 | 高倍率像素网格呈现 | 实现补齐；真实GPU视觉待人工 | P7 · B78 | I250 | 超过500%物理像素倍率；可见区域候选原生合成、透明跳过、亮度/alpha适配、单物理像素线；预算和过期帧/Extras门禁；原生3项、真实WASM、DOM/宿主通过；[B78](../verification.md) |
| I251 | Type 字体预览大小与语言选项占位开关 | 明确不支持；入口/命令关闭已验证 | P7/P8 · B73 | I251 | 无shaping消费者的语言/预览壳状态不复制；真实字体样例由I282提供；12id原生/真实WASM拒绝且状态不变，菜单回归通过；[B73](../verification.md) |
| I252 | 编辑器主题与界面亮度 | 补齐；主题/portal/快捷键DOM通过，画面待人工 | P7 · B27 | I252 | 14种上游配色，跟随系统并记忆最近深浅主题，四档Pro亮度快捷键与命令搜索；局部菜单/宿主注册renderer继承，不改宿主主题；[B27](../verification.md) |
| I253 | 撤销/重做快速切换 | 补齐；菜单/快捷键/内核/WASM 回归通过 | P7 · B1 | I253 | `photo-editor-chrome.test.tsx` 历史任一方向/只读/能力；`photo-editor-shortcuts.test.ts` Mod+Alt+Z；`interaction_state.rs` 两态往返；[B1 验证](../verification.md) |
| I254 | 新建组按钮的选择分流 | 补齐；DOM 回归通过 | P7 · B1 | I254 | `group-panel-interaction.test.tsx` 多选、Shift 单选、普通单选及能力门禁；[B1 验证](../verification.md) |
| I255 | 保存进度百分比反馈 | 补齐保存进度百分比；只在宿主上报真实字节进度时显示，实机保存耗时待人工 | P7 · B117 | I255 | `EditorSaveRequest.onProgress` 与 `EditorWorkspaceState.savePercent` 把真实进度带到界面：`editor-workspace.ts` 只接受有限、单调、0–100 的宿主上报并在离开 saving 后清除；`project-save.ts` 按工程对象 0–50、输出对象 50–100 转发宿主上传进度，摘要校验与回执等待不折算成假百分比；宿主 `mediaRemote.upload` 的 `onProgress` 接入两段上传。`document-tabs.tsx` 显示「保存中 N%」、状态栏显示「正在保存 N%」，未上报时保持原文案。`save-progress.test.ts` 与 `tests/project-save.test.ts` 覆盖上报、缺少进度、失败清除与重试不重复上报；真实网络耗时与百分比平滑度待人工 |
| I256 | Move 工具空白处框选图层 | 补齐；CPU/DOM/WASM通过，拖框画面待人工 | P7 · B114 | I256 | Move按下只读pickAt未命中后回退框选，Shift追加；释放前复核文档key/修订/命令门禁，原地单击不改选择、pasteboard单击清除图层选择；`layer.selectInRect`原生整行/列外相交测试、单次手势所有权与零内容/历史写入；宿主104项与core524项通过；真实拖框视觉待人工 |
| I257 | Move 拖动 Shift 轴约束 | 补齐；几何/DOM 回归通过，画布视觉待人工 | P7 · B1 | I257 | `photo-editor-tools.test.ts` 四/八方向与 8° 迟滞；`photo-editor-canvas.test.tsx` 预览/释放一致、释放 Shift 自由移动；[B1 验证](../verification.md) |
| I258 | Move Alt 拖动复制触发阈值 | 补齐；DOM 回归通过，画布视觉待人工 | P7 · B1 | I258 | `photo-editor-canvas.test.tsx` Alt 复制 <2 屏幕像素取消、恰好 2 提交；只改变 Move+Alt 阈值；[B1 验证](../verification.md) |
| I259 | 像素蒙版双击快捷入口 | 部分补齐：双击打开蒙版属性；精修工作流未完成 | P7 · B3 | I259 | 双击先定位目标再显示属性；Select and Mask 及双击偏好尚未实现，不能按完整等价关闭；[B2/B3 验证](../verification.md) |
| I260 | Cmd/Ctrl 点击背景层缩略图 | 补齐；DOM回归通过 | P7 · B3 | I260 | 背景内容缩略图Ctrl/Cmd强制replace，普通内容缩略图的载入透明度操作不套用背景；[B2/B3 验证](../verification.md) |
| I261 | 手势平移甩动惯性 | 补齐；状态机/DOM通过，设备手感待人工 | P7 · B15 | I261 | Hand/临时Hand/中键，80ms速度窗口、阈值/上限/指数减速，默认开启，可本机关闭；按键/新按下/失焦/阻塞/取消/卸载停止；[B15](../verification.md) |
| I262 | Layer › Rasterize › Type | 补齐命令与像素工具询问恢复；CPU/DOM/WASM通过，画面待人工 | P7 · B52/B63 | I262 | 原生批量/单层scratch事务；文字像素目标按原点击询问，确认先栅格化再单点绘画/油漆桶，两步历史；取消/旧修订/锁/只读/失败不恢复，迟到指针隔离；[B52/B63](../verification.md) |
| I263 | Layer › Rasterize › All Layers | 补齐命令与菜单；CPU/WASM状态通过，画面待人工 | P7 · B52 | I263 | 原生遍历可转换内容/矢量蒙版，保留结构与效果，预检后一步历史；不新增高级内容创建/导入；[B52](../verification.md) |
| I264 | 多选图层统一显隐 | 补齐；菜单/DOM/内核/WASM 回归通过 | P8/P6 · B1 | I264 | `photo-editor-menu.ts` Layer 菜单；`photo-editor-panels.tsx` 图层行右键；`layer-panel-interaction.test.tsx` 选择变化关闭；`interaction_state.rs` 混合→全隐藏→全显示和一步撤销；[B1 验证](../verification.md) |
| I265 | Properties › Quick Actions 移除背景 | 明确不支持：主体分割不在已承诺范围 | P7 · B116 | I265 | `layer.removeBackground` 与 `selection.ai-subject` 保持关闭；属性面板不提供主体识别快捷操作，手动选区/蒙版仍可用 |
| I266 | Layer › Mask All Objects | 明确不支持：主体分割不在已承诺范围 | P7 · B116 | I266 | `layer.maskAllObjects` 保持关闭且无菜单入口；不把固定引擎的本地分割算法计作已承诺能力 |
| I267 | Properties › Transform 数值编辑 | 部分补齐：整体所选目标 X/Y/W/H、比例/七单位；活动层单独语义待复核 | P7 · B113 | I267 | 几何/文字专项与核心/宿主全量通过（见 [B113](../verification.md)）；活动层单独属性语义与真实桌面/Pad 控件、GPU 画面待人工 |
| I268 | Edit › Content-Aware Scale 工作流 | 明确不支持：内容感知缩放需要新的预览与保护参数 | P8 · B116 | I268 | `edit.contentAwareScale` 未开放；自由变换只提供几何重采样 |
| I269 | Select › Color Range 颜色范围选区 | 部分补齐：对话框、原生命令与画布取样点；灰度预览/Localized 覆盖仍缺 | P8 · B121 | I269 | 颜色范围支持 12 种预置、取样颜色、容差、局部群集、反相与 `sampleAllLayers`；`buildColorRange` 现在把画布取样的 `points`/`subtractPoints` 编译进命令（仅取样颜色模式、空数组不下发），`color-range-dialog.tsx` 显示取样点数量并可清除。`color-range-samples.test.ts` 覆盖编译规则，真实 WASM 冒烟验证取样点生成局限在取样区域的选区、减点、越界/非有限点拒绝。仍缺预览/灰度底/Quick Mask 覆盖与画布取色指针交互。 |
| I270 | Properties › Layer Mask 密度与羽化 | 补齐；事务/存档/双语言身份通过，蒙版画面待人工 | P8 · B6 | I270 | 密度0–100%、羽化0–1000px的数值/滑块草稿，一次确认、取消、锁定与无效参数拒绝；mask.properties能力与新版本，默认身份不变；11组跨语言fixture、CPU元数据往返/历史及上传核验；[B6 验证](../verification.md) |
| I271 | 多选图层锁定操作 | 补齐；宿主确认/取消与原子锁定回归通过 | P6/P8 · B2 | I271 | 五项locks对话框初始All，confirm才提交；防止自动嵌套对应artboard标志；owner/selection/gate复核；[B2/B3 验证](../verification.md) |
| I272 | 文字抗锯齿模式 | 实现补齐；原生/DOM/真实WASM通过，字形画面待人工 | P4/P8 · B111 | I272 | 七模式菜单/选项、活动文字草稿和选中层批量、原生状态投影/记忆；全目标锁/文字边界预算、无效候选与一步历史，Windows/LCD遵循原生Sharp等价；[B111](../verification.md) |
| I273 | 竖排文字方向切换 | 实现补齐；原生/DOM/真实WASM通过，字形视觉与IME实机待人工 | P4/P8 · B112 | I273 | Type菜单/方向选项、所选文字层批量与草稿方向切换；原生簇/光标/命中/换列，布局预算、锁、无效候选拒绝、工程核验及一步撤销；[B112](../verification.md#b112横竖排方向竖排工具与输入几何) |
| I274 | Vertical Type 工具新建竖排文字 | 实现补齐；点/段落文字原生/宿主/WASM通过，设备输入待人工 | P4/P8 · B112 | I274 | 工具组短按记忆方向、长按/拖出/右键选择；竖排能力关闭禁用，点按/段落框新建、取消零写与方向记忆；[B112](../verification.md#b112横竖排方向竖排工具与输入几何) |
| I275 | 智能对象 Stack Mode 统计合成 | 明确不支持：依赖关闭的智能对象 | P8 · B116 | I275 | `layer.smart-object` 关闭；不提供 Stack Mode 子菜单 |
| I276 | Paint Bucket 油漆桶工具 | 补齐；原生CPU/DOM/WASM通过，全部图层取样合成待人工 | P3/P8 · B18 | I276 | 油漆桶前景色/图案、容差/不透明度/连续/抗锯齿/全部图层取样、G快捷键；strict参数/锁/可见性/预算及scratch一次发布；[B18](../verification.md) |
| I277 | 数值字段焦点与应用快捷键 | 补齐；DOM事务/目标变化回归通过，原生键盘待人工 | P8 · B8 | I277 | 普通input捕获平台注册菜单组合；先确认字段草稿再以最新回调执行，无效输入/目标变化/IME/文字编辑保护；[B8 验证](../verification.md) |
| I278 | 单色通道显示模式 | 明确不支持：无 Channels 面板与通道目标显示 | P8 · B116 | I278 | 通道目标与独立通道显示的命令与面板入口均未开放，因此也没有灰阶/彩色切换 |
| I279 | 缺失字形保护偏好 | 明确不支持：字形回退不可配置 | P8 · B116 | I279 | 同源文字引擎默认开启回退，但偏好设置中不提供该开关；默认渲染行为不因此不同 |
| I280 | 字体菜单名称语言 | 补齐名称偏好/双语搜索；字体集合仍限已开放两种 | P4/P8 · B51 | I280 | 默认英文、按显示名排序，族名保持稳定，搜索匹配英文/本地名；真实菜单/状态通过，实机待人工；[B51](../verification.md) |
| I281 | 最近使用字体菜单分组 | 补齐；会话/真实菜单通过，实机待人工 | P4/P8 · B51 | I281 | 置顶去重/保留全列表位置、搜索去重、默认10和0–50数量，0清空；不写工程或Recent本机存储；[B51](../verification.md) |
| I282 | 字体菜单样例预览大小 | 补齐；原生CPU/DOM/WASM通过，画面待人工 | P8 · B69 | I282 | 独立本机偏好Off及14/18/24/32/40五档，默认18；同一固定原生字体生成AaBbCc、DPI1–4、界面主题着色与比例行高，缺失字体不伪装fallback；[B69](../verification.md) |
| I283 | 多文件 Open 的顺序与失败处理 | 补齐；批次/错误隔离通过，原生选择器待人工 | P2/P8 · B20 | I283 | multiple、自然排序、逐文件等待/逐文件错误，失败继续，不同批次串行、不交错标签；dispose停止后续读取，Mod+O同入口；[B20](../verification.md) |
| I284 | Web Open 选择器扩展名边界 | 格式边界明确；筛选修正，原生选择器待人工 | P8 · B20/B74 | I284 | 仅PNG/JPEG/WebP/核验pcraft，去octet-stream泛选，扩展名兼容无MIME；XCF/ACT非File Open入口；分类/版本/批次30项通过；[B74](../verification.md) |
| I285 | File › Import › Video Frames to Layers Web 占位入口 | 明确不支持；入口/命令关闭已验证 | P7/P8 · B73 | I285 | 共享图像编辑器无视频帧协议/目录端口，不复制Web无声取消入口；12id原生/真实WASM拒绝且状态不变，菜单回归通过；[B73](../verification.md) |
| I286 | File › Export › Color Lookup Tables | 明确不支持：上游 Web 流程也无法写出文件 | P8 · B116 | I286 | 该菜单在固定引擎 Web 分支调用本机写文件并失败；本产品文件菜单不出现该导出，也不注册对应命令 |
| I287 | File › Export › Paths to Illustrator | 明确不支持：无路径编辑且上游 Web 无文件系统 | P8 · B116 | I287 | 无 Paths/Work Path 能力，Web 分支不能完成 .ai 交付；不提供菜单 |
| I288 | File › Automate › Photomerge / Merge to HDR Pro | 明确不支持：需全景配准/HDR 合成流水线 | P8 · B116 | I288 | 未开放自动对齐/融合/HDR 色调映射命令；不复制参数表单 |
| I289 | File › Automate › Crop and Straighten Photos | 明确不支持：需多照片检测与批量建文档 | P8 · B116 | I289 | 无照片检测/透视批量裁剪命令，文件菜单不出现该入口；不复制空入口 |
| I290 | File › Automate › Fit Image | 实现补齐；CPU/DOM/真实WASM通过，画面待人工 | P8 · B86 | I290 | 最大宽高等比/Bicubic/禁止放大，严格预算、scratch一步历史与noop不写；[B86](../verification.md) |
| I291 | File › Automate › Conditional Mode Change | 补齐：条件模式转换表单与命令；按来源模式判断，不满足时不写文档 | P8 · B119 | I291 | `conditional-mode.ts` 编译 `{from,to}` 并预判是否真的会转换，`conditional-mode-dialog.tsx` 提供来源多选/任意来源/目标模式表单，命令 `file.automate.conditionalModeChange` 进入白名单与「文件 ▸ 自动」菜单。`conditional-mode.test.ts` 覆盖任意来源、未知来源过滤、目标白名单与回执解码；真实 WASM 冒烟验证「已是目标模式不写」「来源不匹配不写」「匹配时转换并只记一步历史」。 |
| I292 | File › Automate / Scripts 本机路径批处理菜单 | 等价Web门禁；本机目录/可执行生成明确不支持 | P8 · B85 | I292 | Contact Sheet/Lens Correction/Image Processor/Create Droplet依赖native目录读写或启动脚本，当前共享字节端口不提供任意路径/本机执行；五id原生/真实WASM/UI拒绝且无写；[B85](../verification.md) |
| I293 | Edit › Presets › Migrate Presets Web 占位入口 | 明确不支持；入口/命令关闭已验证 | P7/P8 · B73 | I293 | 无公开本机preferences路径迁移端口，不复制空参必失败菜单；12id原生/真实WASM拒绝且状态不变，菜单回归通过；[B73](../verification.md) |
| I294 | Workspace › Remember Workspace Changes | 已有布局记忆门控补齐；DOM通过，设备待人工 | P8 · B90 | I294 | 默认开启；关闭跳过布局保存/恢复，当前会话不跳变；显隐/尺寸/折叠/停靠记忆、Tab临时组合不持久化；自由停靠/命名布局仍属I097/I212；[B90](../verification.md) |
| I295 | Workspace › Open Documents as Tabs | 明确不支持：浮动文档视图未实现 | P8 · B116 | I295 | 多文档始终以标签呈现，工作区菜单不提供该偏好项；浮动文档视图与默认打开方式偏好未实现 |
| I296 | Performance › History States | 补齐；原生/参数回归通过，设备操作待人工 | P8 · B12 | I296 | 本机设置1–1000，每文档上限，后续编辑裁剪旧状态；不改内容身份或修订，草稿期间拒绝；[B12](../verification.md) |
| I297 | Performance › Memory Usage | 实现已补齐；原生/DOM/WASM预算状态通过 | P8 · B75 | I297 | 默认8192、整数256–1048576MB，当前及后建文档history预算，和historyStates原子确认；哈希/修订不变、草稿拒绝；非RAM预分配/宿主GPU预算；[B75](../verification.md) |
| I298 | Performance › Rendering Mode | 明确不支持；对应入口/通用命令关闭已验证 | P8 · B76 | I298 | ui-egui渲染策略不适用于宿主Bevy/注入预览端口；不提供无效后端切换；原生/真实WASM拒绝且偏好/状态不变，UI回归通过；[B76](../verification.md) |
| I299 | Performance › GPU Memory | 明确不支持；对应入口/通用命令关闭已验证 | P8 · B76 | I299 | 当前快照无独立gpuMemoryMb；ui-egui预算由Memory Usage派生，非本产品显存配置；原生/真实WASM拒绝且偏好/状态不变，UI回归通过；[B76](../verification.md) |
| I300 | Performance › GPU Cache Tile Size | 明确不支持；对应入口/通用命令关闭已验证 | P8 · B76 | I300 | ui-egui专有GPU纹理瓦片不适用于宿主Bevy或本产品局部预览块；原生/真实WASM拒绝且偏好/状态不变，UI回归通过；[B76](../verification.md) |
| I301 | Performance › Low Resolution Previews | 明确不支持：预览降采样不可配置 | P8 · B116 | I301 | 预览底图与细节瓦片策略固定；未提供关闭降采样的偏好，也不声称可强制全分辨率 |
