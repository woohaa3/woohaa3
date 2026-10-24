# PhotoCraft 子项目

独立的图像编辑器子项目：固定上游快照、无 UI Rust 内核、WASM 绑定、原生工程核验、纯协议包、
React 编辑器界面与工程核验的 Node 适配。

本目录**自成一套构建**：有自己的 pnpm workspace、锁文件、Cargo workspace、构建脚本、
测试与 OpenSpec。核心部分不允许读取 `web/`、`bevy/` 或仓库根 `scripts/`；Woohaa 的宿主
接入在 `integrations/woohaa/`（通过宿主 workspace 安装），不是核心的前置条件。

change: `2026-10-21-extract-photocraft-subproject`（design D1/D2/D8）。

## 目录

```text
photocraft/
  vendor/photocraft/   上游固定快照（逐字节原样，含来源/许可/SOURCE.md）
  rust/                独立 Cargo workspace：editor-core（无 UI 内核）+ project-verify（原生核验）
  assets/fonts/        随包中文字体与许可（固定 digest，不依赖 bevy 路径或系统字体）
  packages/protocol/    @woohaa3/photocraft-protocol —— 纯协议，零宿主依赖
  packages/editor/      @woohaa3/photocraft-editor —— React 编辑器界面与内核端口
  packages/project-verifier/ @woohaa3/photocraft-project-verifier —— Node-only 工程核验
  tests/fixtures/       跨语言语义 fixture（Rust 与 TS 共读同一份）
  scripts/              子项目自己的构建入口
  openspec/             子项目正式 OpenSpec（见下）
```

`integrations/woohaa/` 不在本 workspace 里：它依赖宿主 `@woohaa3/contracts`，由
`web/pnpm-workspace.yaml` 以精确成员路径安装，见[宿主装配](#宿主装配)。

## 快速开始

```bash
cd photocraft
pnpm install --frozen-lockfile   # 只用本目录的锁文件
pnpm run build                   # 构建 packages/*
pnpm run typecheck
pnpm run test                    # 包内单元/回归（不需要 Rust）
```

Rust 侧（需要 rustup 与 `wasm32-unknown-unknown`；本目录的 `rust-toolchain.toml` 固定 1.97.1）：

```bash
pnpm run rust:check              # cargo check --workspace
pnpm run rust:test               # cargo test --workspace（非渲染）
pnpm run wasm                    # 产出 packages/editor/dist/wasm/（glue + wasm + .d.ts）
pnpm run verifier                # 产出 packages/project-verifier/dist/bin/（当前平台，Windows 为 .exe）
```

`wasm-opt` 缺失时 WASM 构建会打印告警并保留未优化产物，不静默宣称优化完成。

## 与 Woohaa 的边界

- **核心**（`packages/*`、`rust/`、`vendor/`）只依赖包内代码与已声明工具链，可在只含本目录的
  副本里安装、构建与测试。
- **宿主装配**（`integrations/woohaa/`）依赖 `@woohaa3/contracts` 与宿主平台端口，负责节点身份、
  旧标注转换、资源授权、保存基线、权威回执与预览呈现（Woohaa 仍由原 Bevy 节点显示图片）。
- 两端共享的**语义数据**只有两份：`tests/fixtures/contract.json`（引擎/能力/版本/旧指纹）与
  `rust/project-limits.json`（资源上限）。Rust 与 TS 各有一个测试读同一份，谁都不读对方源码。

## 宿主装配

宿主侧的安装顺序是「先核心、再 web」：核心包必须先 `pnpm install` 并 `pnpm run build`，
`web/` 才能通过 `link:` 解析它们的公共 exports。仓库根提供转发入口：

```bash
pnpm photocraft:setup   # 核心 frozen 安装 + 构建
pnpm photocraft:check   # 核心 typecheck + test + 非渲染 Rust 检查
pnpm photocraft:dev     # 独立编辑宿主（真实 WASM，不接 Canvas 服务）
```

本仓的 Rust 构建不做隐式联网：`pnpm install` / `prepare` 不会触发 cargo。

## OpenSpec

子项目有**自己**的 OpenSpec（`photocraft/openspec`）：编辑器内部语义（`editor-workspace`、
`project-format`、`project-verification`）在此维护；Woohaa 主仓只保留集成行为（聚焦与输入归属、
Bevy 呈现、上传/认证/存储、画布权威事务与历史）并引用这些契约。

迁移台账见主仓 change 的 [notes/migration-ledger.md](../openspec/changes/2026-10-21-extract-photocraft-subproject/notes/migration-ledger.md)。

## 上游快照

上游 `storytold/photocraft` 的固定提交、许可与裁剪清单见 [vendor/photocraft/SOURCE.md](vendor/photocraft/SOURCE.md)
与 [vendor/photocraft/woohaa3-vendor.json](vendor/photocraft/woohaa3-vendor.json)。快照逐字节原样，
**没有任何上游源码补丁**；升级需重新快照并重跑两端测试。


## 图层与工具交互

图层列表的名称、内容缩略图及行内空白支持选择/拖动；Shift 范围选择，名称上的 Ctrl/Cmd 增减选择。
Ctrl/Cmd 点击普通内容或蒙版缩略图载入透明度/蒙版选区，可加 Shift、Alt/Option 做添加、减去和相交；背景缩略图保持单独选择。
Alt/Option 拖放复制所拖集合，拖到页脚可删除、复制或编组。新建组按钮按多选或 Shift 单选执行编组，普通单选创建空组。
重命名支持 Tab/Shift+Tab 连续导航，遇到背景层或列表边界停止；背景层整行双击或解锁使用内核转换。
活动层改变时展开祖先并滚入列表，同一目标下保留手动折叠与滚动位置。

Alt/Option+方括号选择相邻层，Alt/Option+句点/逗号选择顶/底层；加 Shift+方括号追加相邻层。
Alt/Option 点击眼睛独显或恢复原可见性；Layer 菜单/图层行右键统一切换选择集合显隐。
Edit 菜单及 Ctrl/Cmd+Alt/Option+Z 切换上一次历史状态。所有新增动作仍受内核 allowed/enabled、草稿和只读门禁控制，旧 WASM 未开放的命令不会绕过门禁。

选框工具组支持短按、按住拖出选取、长按和右键切换菜单。Move 按住 Shift 约束方向并保留迟滞，Alt/Option 复制拖动阈值为 2 个屏幕像素。
这些交互已有 DOM/状态回归；原生浏览器拖放、真实 IME、桌面/Pad 视觉和 GPU 画布效果仍需真实设备验收。

图层眼睛列支持可取消扫动，释放只提交一步历史；属性的不透明度/填充共用批量草稿，支持滑块、标签拖动、键入与滚轮。按住 Alt/Option 点击相邻同级图层分隔线切换剪贴；释放剪贴链也只提交一步，锁定成员会整次拒绝。
页脚垃圾桶默认确认，Alt/Option 可绕过，“不再提示”仅在成功删除后保存到本机；蒙版拖入垃圾桶可选应用或删除。新建图层按钮普通点击立即创建，Alt/Option 打开完整选项，Ctrl/Cmd 在当前层下方创建。
选择菜单提供全部非背景层、名称查找和列表隔离；隔离与文档各自的列表滚动位置均属于工作区状态。图层菜单可一次删除隐藏层，文件 > 脚本可删除空层；锁定或将删光文档时整次拒绝，并维护幸存层的剪贴关系。
标签与图层链接由内核持久化，当前写入能力版本为 `woohaa-layer-metadata-v1`；无标签/链接的旧内容指纹不变，旧能力版本仍可读取。标签枚举和归一化链接组进入两端内容身份，核验器拒绝不安全的链接编号。
选框组含矩形、椭圆、单行与单列；Shift+M 循环，线形点按即提交整行/列。现有选区的交互命中读取真实覆盖度，显示轮廓的降采样不参与命中。
执行 `pnpm wasm:debug -- --skip-opt` 后可用 `pnpm wasm:smoke` 运行真实 WASM 状态冒烟，不调用绘图、缩略图或导出。

混合模式菜单支持悬停候选、离开取消、按下拖放确认和滚轮逐项确认；Shift+加减循环当前图层或Brush模式。图层百分比字段可键入、拖动、滚轮调值，箭头展开滑块。

选区工具的Ctrl/Cmd拖动在选区内移动像素，Alt复制所选像素；选区外临时移动整层并保留选区。普通方向键移动选区边界，Ctrl/Cmd移动像素，Shift增至10像素。空选区Alt可居中绘制，普通选区内单击取消选择。数字键采用800ms两位百分比，00为0%；其他工具调整图层不透明度，Shift调整填充。

文字编辑中点击文字框外提交，未修饰Tab插入制表符并继续编辑；组合输入期间不触发这些结束动作。上述状态/DOM回归不代替真实GPU画面、系统IME或桌面/Pad验收。

编辑菜单的偏好设置可保存Escape提交文字、拖动读数与Shift切换工具组选项。文字框内连续1–5击选择插入点、词、行、段落和全文；Move双击文字进入Type，Shift单击强制新建文字。图层菜单已接通盖印、背景转换和去边；背景转换需先释放相关剪贴链。盖印/背景成功合成及所有新增视觉行为仍待真实GPU设备验收。


交互补齐B6：像素蒙版密度/羽化已接入属性草稿、严格命令、内容身份与存档验证；当前可写版本为`woohaa-mask-properties-v1`，旧metadata工程仍可读。选区空格越界平移、笔迹Shift锁轴/悬停连线和图层状态快捷键已接入。真实GPU/笔压/桌面与Pad验收待人工，301项差异仍有未实施项，详见当前change的处置矩阵与verification。

交互补齐B10/B11：命令搜索、文字编辑中保存检查点、仅边界Move偏好、图像/画布大小和任意角度旋转已接入。当前可写版本升级为`woohaa-resolution-v1`，新增`image.resolution`；默认72 DPI保留旧内容指纹，旧mask-properties工程继续可读。图像/画布尺寸不超过8192单边及256MiB像素资源预算。任意角度旋转已接入可取消候选实时预览，画布真实合成及桌面/Pad操作待人工验收，具体证据以当前change为准。

历史状态数量可在编辑器偏好设置为1–1000（默认50），本机保存；降低上限后于下一次编辑裁剪旧状态，不修改工程内容。


交互补齐B14–B17：旋转候选预览、缩放动画、点击位置居中和惯性平移已接入；文字智能引号可在本机偏好关闭，IME预编辑范围使用原生几何画下划线。View新增200%、打印尺寸（屏幕PPI/文档DPI）、所选图层适配和Alt缩略图适配；缩放使用33档阶梯、短边2px下限与12800%上限。以上均需真实GPU设备补完视觉和原生输入验收。

油漆桶现支持前景色/图案与区域取样选项（G），当前Brush/Eraser可用方向键调整笔尖角度。宿主打开支持自然顺序多选批次，单个失败继续处理并列出原因；Mod+O复用该入口。图像格式白名单尚未扩展，全部取样合成、笔尖画面和真实文件选择器仍待人工验收。

Pencil and Eraser modes: B/Shift+B selects Brush/Pencil; Pencil uses native pixel-grid dabs and optional start-color Auto Erase. Eraser offers Brush/Pencil/16-screen-pixel Block. Hold Backquote to temporarily erase with Brush/Pencil; tool parameters stay fixed for each stroke.

Painting symmetry: Brush/Pencil/Eraser offer vertical, horizontal, dual and diagonal axes plus existing document paths. Transform the preset center/rotation on canvas (Shift snaps 15°); Enter confirms, Escape or focus loss cancels. Symmetry is session tool state and does not dirty the project.

Eyedropper (I): point or 3–101 pixel averages, five layer sources and Alt background sampling; Brush/Pencil/Paint Bucket share the settings for temporary Alt sampling. The application color-picker sampling workflow is still pending.

状态栏支持百分比输入、拖动/滚轮调值与八种信息选择；文档数据大小为逻辑字节，效率未采集。文件菜单可串行关闭全部/其他文档，取消或保存失败会保留剩余项。窗口主题提供14种配色、跟随系统和Mod+Shift+F1/F2四档亮度；配色仅应用编辑器及其菜单/对话框内容。

关闭文档可选保存/不保存/取消，下载后仍须确认落盘。历史面板支持一次跳转及会话快照（完整/合并/当前图层，恢复/改名/删除）；快照不随工程存档。选项栏当前工具图标右键可重置当前或确认重置全部，保留颜色。

现有数值字段支持算术、括号、幂和受支持的单位；Enter或失焦确认，无效事务字段不能确认旧候选。绘画数值支持滚轮和拖动（Shift加速、Alt精调），字体列表关闭时也可悬停滚轮逐项切换。

工具与非默认参数在本机恢复，绘画工具各自记忆笔头；临时工具、输入文字和文档内容不写入工具记忆。新文字默认全选Lorem Ipsum，可在偏好中关闭。字体菜单悬停使用原生文字候选，移开恢复；文字菜单可向选择范围插入Lorem Ipsum，未编辑时创建内缩段落文字。

文字菜单提供刷新全部文字图层，以及会话内保存/载入默认文字样式。新文字继承默认格式、颜色取当前前景色。工程缺失字体时显示原生查询提示，可逐项映射到已加载字体或全部替换为Inter；替换可撤销。

像素和蒙版分别记忆颜色。工具色块打开独立颜色选择器，支持HSB/RGB/Lab/通用CMYK/HEX、216色和本机色板；CMYK没有印刷ICC配置。浏览器刷新/关闭保护同时覆盖正式未保存状态和干净文档中的未确认候选，不承诺自动恢复。

Move自动选层可悬停预览原生命中边界，Ctrl/Command反转自动选择时同步更新，查询不改文档。窗口菜单可分别切换工具栏、选项栏和侧栏，Tab恢复隐藏前的组合；尚未增加全屏chrome模式。

文字编辑时，编辑菜单剪切/复制/粘贴和选择菜单全选操作当前字符范围；系统剪切写入失败保留原文，迟到粘贴不会覆盖新输入。空工作区可双击背景或点打开文件。绘画和段落框拖出可视区时沿同一候选自动平移，指针在可视区内不触发。

透明像素网格可在偏好中关闭，或选择小/中/大、预设配色与自定义双色；只显示在独立文件文档矩形内，不影响导出。

字体菜单支持英文/本地名称与双语搜索，Recent在当前页面会话共享、按选择置顶；偏好可设0–50项，0清空。可编辑族仍为Inter与思源黑体，尚无上传/系统字体集合和字形样例。

图层菜单支持栅格化所选文字或全部可转换图层，文字菜单/图层右键也有文字入口；转换保留层级与实时效果，原子确认一步撤销。像素工具前的栅格化询问/继续笔划尚未接入。调整滑杆双击复位单项，属性面板可恢复当前调整的默认值。

曲线点支持方向键/Shift微调、右键或Ctrl/Command删除，中间点拖出图形12px删除、拖回恢复。现有调整字段可直接输入数值或算术表达式，也可拖动标签（Shift加速、Alt精调）；无效表达式不能提交旧预览。

长菜单溢出时提供上下滚动箭头，可悬停连续滚动，也可直接在箭头区域使用滚轮。

菜单栏支持按住标题、拖到其它标题或子菜单后松手执行；普通点击仍保持菜单展开。调整页脚也可按住拖入项目后松手选择。

Zoom支持左右拖动连续缩放、关闭该选项后的框选缩放，以及按住300ms连续缩放。Hand按下时配合Mod/Alt可临时放大/缩小。Page Up/Down翻页、Mod横向、Shift10px，Home/End移到文档角落，保持倍率。

文档标签显示实际倍率、活动图层/蒙版、模式与位深；后台标签保留最近上下文，关闭重开不串用。文字草稿右键可剪切/复制/粘贴/全选、插入Lorem Ipsum或确认/取消；拼写建议与高级Type菜单尚未开放。

光标偏好支持标准工具图标、精确十字、正常50%覆盖圆笔尖或全尺寸笔尖，可加中心十字或在半笔期间只显示十字；其它编辑工具可统一精确十字。当前仍只开放圆笔尖。

画布外工作区可选六档颜色/自定义色、投影/线/无边界与默认主题点纹，Space+F/Shift反向循环；空工作区共享偏好。滚轮默认平移、Alt锚点缩放，支持独立滚轮缩放与触控板捏合偏好。底/右滚动条可拖动/翻页；关闭Overscroll后限制取景边界。触屏Enable Gestures开启时双指导航取消未提交的工具候选，剩余单指不续画；油漆桶单指触屏在释放执行。模态背景导航仍未开放。

在文字层pixels目标使用像素工具时先询问栅格化，确认在原点击位置继续，栅格化与绘制分别撤销。蒙版绘画不转换文字。

字体菜单样例由当前固定原生字体引擎生成；本机偏好可关闭或选14/18/24/32/40五档，默认18。缺失字体不使用浏览器替代样例，不修改文字内容或工程。

修饰键面板（Window）可锁存Shift、Cmd/Ctrl、Alt/Option，关闭面板保留锁存，重复点击按键解除；仅应用到画布指针工具，不写工程。

视图屏幕模式支持标准、带菜单栏全屏、全屏；F循环，工具栏底部按钮长按/右键直接选择。全屏Tab临时显示chrome，返回标准恢复面板组合。窗口经公开EditorScreenModeWindowPort适配；默认浏览器Fullscreen API，拒绝时保持标准并报告。

不提供上游仅改变勾选的Pixel Art Preview、Type预览/语言占位开关，也不提供Web缺少目录端口的视频帧导入或依赖本机preferences路径的旧预设迁移菜单；相应写命令保持关闭。真实字体样例由Preferences控制。

偏好提供每文档内存预算（默认8192MB，256–1048576整数），和历史数量一起原子确认；降低后按原生预算裁剪旧历史，当前/后建文档继承。不预分配RAM，不设置宿主Bevy显存或改变固定变换输出像素上限。

不提供ui-egui GPU画布专用的渲染后端、独立显存预算及GPU纹理瓦片偏好：节点使用宿主Bevy，独立文件使用公开预览端口；编辑器内存预算仅作用于共享核心，通用prefs.set/reset命令保持关闭。

信息面板可由Window或F8打开，实时显示当前候选的RGB/device-CMYK、px坐标、选区与文档尺寸；仅只读取样，不产生历史。参考线拖动与标尺单位尚未接通。

View像素网格在超过500%物理像素倍率时覆盖当前候选的可见像素；透明像素不画线，线色适配明暗，Extras可临时隐藏。区域与线段数量受硬预算限制。

Window直方图提供RGB/R/G/B分布与原生统计，采用最长边384px合成缓存；文档变化最多每250ms重算，等待时明确显示缓存数据，不产生文档历史。

Window导航器显示256px候选缩略图与主视口范围框，点拖平移，Ctrl/Cmd拖框缩放；提供百分比、加减、连续滑块及独立滚轮缩放，pinch遵从偏好。所有操作复用主画布取景和手势门禁。

偏好中的测量单位控制选框、移动和Info读数，支持七种单位与72/72.27点标准；物理单位按文档dpi计算，百分比各轴独立，正式编辑几何仍为源像素。

GPU状态遵从宿主真实故障信息；图片编辑器不显示ui-egui专属显存预算或CPU/GPU后端选择。节点预览故障采用宿主有界自动重建与手动“重建画布预览”，保留编辑现场；真实设备恢复待实机验收。

共享Web编辑器不提供原生打印、Windows WIA扫描、本机路径Place Embedded/Linked或Web无输出的Image Assets开关；相关命令保持关闭，普通字节导入/导出走已有宿主交付端口。

F2/F3/F4为内部剪切/复制/粘贴备用键。普通粘贴在复制区域仍可见时保留原位，离开视口后居中；跨文档共享及粘贴入/外部仍未开放。

原生路径型堆栈/批处理、目录输出与Droplet启动脚本不进入共享Web编辑器；系统图像剪贴板也未装配。内部图像剪贴板与系统纯文字剪贴板是独立通道，不能据此推断跨应用图像交换。

File自动菜单支持Fit Image最大宽高等比适配和禁止放大；Scripts支持全局蒙版烘焙，保留不适用图层及禁用蒙版，锁定/超预算整批拒绝。Brush/Pencil模式提供Clear及悬停滚轮切换，独立于图层混合模式。

Image修整支持透明/角点颜色依据和四边开关，成功后记忆；显示全部恢复画布外像素。工作区记忆开关控制布局保存与下次恢复，关闭时仍可调整当前布局；Tab临时隐藏和锁存修饰键不持久化。

历史面板可删除当前状态及后续历史，保留快照；当前位置变化时仅在行不可见时自动滚入，手动滚动和快照选择不强制跟随。

历史快照支持双击/右键重命名、右键删除和拖到垃圾桶删除。File脚本浏览读取UTF-8 JSON/txt/pcdroplet（256KiB、最多32步），仅执行当前文档已支持命令；失败整批无写，成功逐步撤销。不执行JavaScript、路径I/O、递归脚本、文档新建/关闭或全局清理。

Edit定义图案可将选区范围或整张画布的可见合成加入本机用户图案库，支持命名、透明区域和现有PAT管理；单边1024px、最多64项、累计4,194,304像素。创建图案不修改文档内容或历史。

Move选项栏提供六个快速对齐按钮及完整分布菜单：有选区时以选区为参照，否则单层以画布、多层以组合边界为参照。图层面板仍可显式选择参照。

PhotoCraft B97–B98: document-workspace.moveBefore owns presentation-only tab ordering with live generation/gate checks. Woohaa DocumentTabs owns token-bound drag placement, middle close and context batch-close routing; image-editor-plugin retains settlement/resource ownership. workspace-layout-memory and editor-display synchronize confirmed Large Tabs preferences across local/storage events; overlay applies the 34/42px strip through the existing runtime content rectangle without reopening drafts. Floating document views remain pending.

PhotoCraft B99: confirmed Narrow Options Bar preferences flow through editor-display to both contextbar CSS and the host's single content rectangle (52/44px options; 96/88px combined toolbar). Hidden/fullscreen modes avoid redundant viewport preservation; controls and drafts retain their existing ownership.

PhotoCraft B100: editor/duplicate.rs exports a fresh, verified project through an isolated native Session; duplicateProject is an optional WASM byte capability, while generic image.duplicate stays closed. Core controller and App guard drafts/gestures. DocumentWorkspaceSession owns independent unsaved file creation and capacity checks; the plugin owns activation and file bytes. ProjectSession.initiallyUnsaved prevents an initial open from clearing the new file's save requirement; only commitBaseline clears it.

PhotoCraft B101: notification-preferences owns confirmed local auto-hide/duration settings and cross-window updates. Woohaa WorkspaceNotification owns hover/reset/dismiss timers with event identity and cancellation guards; workspace-store preserves distinct same-text notification events, and the plugin clears only the matching notice. Document status and settlement remain independent.

PhotoCraft B102: clipboard_commands routes Cut to active layer pixels while preserving mask targeting and native multi-root copy behavior; paste publishes only the last inserted layer as selected, including history selection metadata. paint-tool-state exposes the separate pixel background to Cut without changing the current mask palette. Cross-document clipboard sharing is still pending.

PhotoCraft B103: clipboard_commands exposes Paste Into/Outside through the same bounded scratch transaction and strict clipboard gates. Native selection/inverse masks, current mask luminosity writes, one-step history and final selection remain engine-owned; App guards partial gestures and the shortcut resolver keeps Alt+Shift+V distinct from Paste In Place. Cross-document clipboard sharing remains pending.

PhotoCraft B104: text_find_replace preflights all affected text locks and UTF16 result sizes, then publishes an isolated native find/replace transaction and its native search cursor. find-replace-dialog owns current/all layer scope and case/word/direction options, explicit search/replace actions and owner/top-instance guards. App excludes each form’s own modal status from its external blocking inputs, including Define Pattern; opening still uses the host modal gate.

PhotoCraft B105: general_fill owns strict current pixel/mask routing, source validation, bounded history indices and isolated native Fill publication. fill-dialog owns nine source choices, blend/opacity/transparency, success-only local memory and Alt+Cancel reset; App guards partial gestures before opening. Content-Aware is bounded to 262144 canvas pixels and normal fill work to256MiB. Quick Mask and colour-channel UI remain pending.

PhotoCraft B106: edit.fillHistory is a strict alias into the same bounded native Fill transaction, accepting only an optional retained state index. Its Mod+Alt+Backspace shortcut and Edit menu action do not consume the palette and reject partial gestures. The pinned source defines the default history source as the oldest retained state; a new history-source marker interface is not a baseline requirement. Quick Mask remains pending.

PhotoCraft B107: text_spelling performs bounded SCOWL English scans and per-word suggestions; replacements preflight all target locks and native character ranges, then publish a scratch document in one history step. spelling-dialog owns current/all-layer checks, ignore/change workflows and a local user dictionary (2000 words, 128 characters each), with document/owner/top-instance guards. Dictionary changes never enter projects or native session preferences.

PhotoCraft B108: edge_stroke writes current raster selection/alpha edges in one native scratch transaction, with inherited locks, visibility and padded 256 MiB working-area guards. stroke-dialog owns width/color/location/blend/opacity/transparency and remembers only successful confirmations. B109 adds local enableAnimations preference: editor theme roots and host-registered dialog/menu portals share scoped chrome-motion policy and cross-window updates, with explicit confirm/cancel and listener cleanup.

PhotoCraft B110: PreferencesDialog filters supported settings by section or global search without losing drafts, resets only the selected section, and validates the entire draft for Apply/OK. Apply keeps the host dialog open; Cancel preserves prior successful applications. No inactive preference shells are added.

PhotoCraft B111: text_antialias exposes the seven pinned native AA commands for current selected text layers with full lock/resource preflight and atomic history. TextPreview carries the same strict modes through cancellable drafts and native metadata; tool options, Type menu and local tool memory preserve them. Windows/LCD retain upstream Sharp rendering semantics.

PhotoCraft B112: text_orientation exposes atomic selected-layer orientation commands. TextPreview uses the same native vertical layout for point/paragraph drafts, with layout-only source/candidate preflight before raster cache allocation (8192px / 256 MiB). the shared tool-slot flyout (`tool-slot-button.tsx`, driven by `toolbar-slots.ts`) owns pointer-bound horizontal/vertical tool selection from the Type slot; native caret, hit, selection, column navigation and UTF16 cluster offsets drive the input overlay and IME anchor. Orientation lives in existing native text fields; local tool memory is not project content.

PhotoCraft B113: native document inspection projects `layerTransformFrame` from whole selected layer targets independently of pixel selections. Properties `layer-geometry-controls` edits X/Y/W/H in the configured ruler unit and document DPI with linked dimensions; confirmed fields use the existing whole-layer transform draft/commit path, preserving pixel selections and one-step undo. Typed expressions remain local until confirmed; failed candidates cancel and keep the input for retry. Old runtimes without the whole-layer field expose the fallback only without a pixel selection.

PhotoCraft B114–B115: the selection catalogue, fourteen retouching brush commands and the destructive image adjustments now have visible entries compiled from the pinned native parameter registries (`selection-modify-controls.tsx`, `magic-wand-options.tsx`, `color-range-dialog.tsx`, `retouch-tools.ts`, `retouch-options.tsx` (the sixteen painting/retouching tools are each a first-class toolbar id; the shared `tool-slot-button.tsx` owns their flyout), `adjustment-dialog.tsx`, `fade-dialog.tsx`). Whole strokes commit once on release and single-click tools on press; cancelling, readonly, blocked drafts and closed commands never write. File Info reads document XMP and camera EXIF through the new read-only controller call, and the image mode dialog dispatches only already-opened mode/depth commands. Still unsupported: Select and Mask, Quick Mask, live retouching previews, Replace Color, ICC assignment/soft proofing and 32-bit preview options. Selection and retouch real-device visuals remain manual checks.

PhotoCraft B117: the eight interaction rows previously marked as needing runtime verification were re-checked against the pinned v0.14.0 sources. Clone Stamp/Healing Brush and the five-slot Clone Source panel now run through already-present native `paint.cloneStamp`, `paint.healingBrush` and `cloneSource.*` commands (`retouch-tools.ts`, `clone-source-panel.tsx`), with Alt/Option sampling and `retouch_params.rs` rejecting half parameters before the write route. Move smart-guide distances are a read-only overlay (`move-distance.ts`) computed from the existing `moveHoverAt` query and the shared measurement units. The menu bar gains Alt-tap/F10 focus, cross-title arrows and Alt+letter mnemonics (`ui/menu-keyboard.ts`); menu-row mnemonics are intentionally not fabricated for the fixed Chinese labels. Controlled file opens register a cancellable placeholder tab with monotonic real progress, and `project-save.ts` forwards only host-reported byte-upload progress (project 0–50, output 50–100) into `EditorWorkspaceState.savePercent` for the tab and status bar. Drag-reorder previews use a read-only native candidate (`reorder_preview.rs`, `beginReorderPreview`/`previewReorder`/`endReorderPreview`) behind a local preference, and paragraph-box handles resize the native text draft through `text-box-resize.ts`. `scripts/check-disposition-matrix.mjs` and `unsupported-closure.test.ts` keep the 301-row matrix and the 72 unsupported rows mechanically honest. GPU/visual, real pointer, IME and Pad checks remain manual: this Linux container has no `/dev/dri/renderD*`.

PhotoCraft B118–B126: filters, conditional mode change, new-document presets, eight export formats, rulers/guides/grid with snapping, deeper text style fields, brush dynamics and presets, layer-style copy/paste/clear, hide/show-all effects, Quick Mask and colour-range canvas samples are now wired to already-present pinned commands rather than reimplemented. Every write path validates ranges in the editor before dispatch (the engine clamps some values), every new capability is added to the single whitelist, and `scripts/check-disposition-matrix.mjs` plus `unsupported-closure.test.ts` fail the build if the matrix, the task list or the closed capability set drift apart. Guides and the ruler origin deliberately stay out of the content fingerprint. GPU visuals, real pointers, IME, tablets and external services remain manual checks.
