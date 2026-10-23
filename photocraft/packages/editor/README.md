# @woohaa3/photocraft-editor

PhotoCraft 的 React 编辑器：工具、图层、样式、文字、选区界面与内核会话控制器。
本包**只经公共端口依赖宿主**，不 import Woohaa `frontend` / `services` / `contracts`，也不读取
宿主私有测试 harness。完整的独立开发宿主见 `photocraft/dev`。

## 入口

| 子路径 | 内容 |
| --- | --- |
| `@woohaa3/photocraft-editor` | 控制器、视图模型、端口、文档工作区注册表、工具函数与全部 UI 组件 |
| `@woohaa3/photocraft-editor/ui` | 最小 UI primitives（按钮、滑杆、下拉等） |
| `@woohaa3/photocraft-editor/styles.css` | 编辑器布局与交互样式 |
| `@woohaa3/photocraft-editor/ui/styles.css` / `ui/forms.css` | primitives 与表单控件样式 |
| `@woohaa3/photocraft-editor/wasm` | 构建生成的 WASM glue（`dist/wasm/`，字面量按需加载；宿主会把同一产物复制到自身源码根） |

WASM 与原生核验工具是构建产物，不是源码：先运行 `pnpm run wasm`（或从主仓
`pnpm photocraft:wasm`），产物落在本包 `dist/wasm/` 与 `packages/project-verifier/dist/bin/`。

## 公共端口

编辑器不拥有宿主会话、上传、Dialog 栈或性能系统；宿主通过以下端口接入。

### `EditorWorkspaceController`

```ts
const controller = new EditorWorkspaceController({
  session,          // EditorDocumentSession：净变化、阶段与基线
  save,             // EditorSavePort：上传成对产物并返回权威结果
  dialogOwner?,     // 当前编辑会话身份，供命名弹窗校验归属
  load?,            // 内核加载（缺省走 @woohaa3/photocraft-editor/wasm）
  yieldTask?,       // 让出主线程（测试注入）
  digest?,          // SHA-256 实现（测试注入）
  onState?, onViewModel?
});
```

- `openImage({ name, assetId, bytes })`：纯媒体或旧标注字节 → 工程草稿。
- `openProject({ bytes, baseAssetId })`：打开已核验 `.pcraft` 工程；基线由会话建立。
- `dispatch(id, params)` / `beginStroke` / `appendStroke` / `commitStroke`：所有写操作都经内核
  命令白名单；返回稳定错误而不是抛异常。
- `render(maxSide)` / `renderRegion({ x, y, width, height })`：全图与源像素区域预览。区域读取
  不修改修订、选区和历史，失败保留基础预览。
- `save()`：一次冻结返回同修订工程与 PNG，交给 `EditorSavePort`；只有权威成功才
  `commitBaseline`，失败保留冻结产物供显式重试。
- `dispose()`：关闭内核并递增代际；之后到达的异步结果不得写入新会话。

### `EditorDocumentSession`

宿主实现的最小结构接口：`isDirty`、`beginFreeze`、`resumeEditing`、`beginSave`、
`commitBaseline`、`failSave`、`establishBaseline`、`applyContentState`。编辑器只比较内容身份，
不看取景/工具偏好；旧标注转换、节点身份和权威回执都属于宿主适配层。

### `EditorSavePort`

`(request: { artifacts, sourceAssetIds, isCurrent }) => Promise<EditorSaveOutcome>`。
`artifacts` 含同一修订的工程、PNG、尺寸与文档内容 hash；`sourceAssetIds` 是本次会话引用过的
来源资产。端口可返回 `{ ok: true, status: "history-pending" }`，但编辑器只在 `ok` 时推进基线。
`isCurrent()` 为 false 时宿主必须停止上传/回执，避免迟到写入。

### `EditorDialogPort`

编辑器注册弹窗定义与 renderer，并请求 `open` / `close`；栈顺序、焦点、Escape、遮罩与关闭策略
始终由宿主 Dialog Host 拥有。`editingOwner` 用于拒绝已切换会话的迟到请求。

### `EditorAssetPort` 与字体

`EditorAssetPort = (path) => string` 把 `/assets/fonts/NotoSansSC-Regular.otf` 解析为当前部署的
可访问 URL（根路径或子路径）。缺省内核加载会用同源 `fetch` 注册固定字体；宿主只需保证该路径
随发布资源存在。

### `EditorFilePort` 与本地文件交付

`EditorFilePort = (file) => Promise<EditorFileDeliveryResult>` 让**独立文件文档**把工程或 PNG
交给宿主，而不经过节点上传、`edit-complete` 或画布身份：

- `written`：宿主确认已写入目标磁盘——**只有这一种**自动推进本地保存基线；
- `download-started`：只能发起浏览器下载，**不得**宣称落盘或清除未保存状态；
- `cancelled` / `failed`：保留文档与草稿，可显式重试。

节点文档不配置该端口；它的保存仍走 `EditorSavePort`。`EditorWorkspaceController.deliverFile()`
与 `freezeForPublish()` 共用同一冻结/摘要校验，所以“保存工程”“导出 PNG”“添加到画布”
三处看到的字节必然来自同一修订。

### `EditorDocumentRegistry` 与多文档工作区

同一已加载 WASM 模块可以创建多个独立内核实例；`EditorDocumentRegistry` 只保存轻量的
**文档条目**（身份、名称、状态、代际、可写性），控制器/内核/字节/取景由宿主按 `id` 持有：

- 节点身份为 `(canvasId, nodeId)`：同一节点复用条目，复制节点有新身份；
- 独立文件每次显式打开得到新的不透明 id（同名文件互不覆盖）；
- 关闭后重新打开同一节点会递增 `generation`，旧异步结果据此被拒绝；
- `activate` 在存在活动操作门禁时拒绝切换；关闭活动项优先左邻、其次右邻；
- 上限（`MAX_OPEN_DOCUMENTS = 8`）是工作区运行政策，不写入工程格式。

控制器给宿主两个查询口：`pendingDraftFailure()`（内部 `blockingDraft()` 的唯一权威，含保存阶段）与
`isSaving()`（冻结/上传/待回执窗口）。宿主在切文档、关闭、打开新文档与离页结算上都用它们，
不要另列一份草稿种类清单——否则会出现「保存会拒绝、切标签却放行」。`documentOwner()` 给出
`{ documentId, generation }`，用来判断一份计划/预览是否仍属于当前文档（见下）。

### 文档归属：宿主角色的 `documentId` 与 `documentGeneration`

`EditorWorkspaceOptions.documentId` / `documentGeneration()` 是可选端口，用于区分**数值上完全相同**
的两份文档：关闭后重开同一节点可能又是修订 1、内容指纹也逐字节相同。控制器在每次成功载入文档
（`openImage`/`openProject`/`openPsd`）时自增自己的载入代际，宿主的代际变化也会推进它。
`documentOwner()` 返回当前 `{ documentId, generation }`；域内计划把它记进 `owner`，确认时先比代际、
再比修订、最后比 `contentHash()`。智能对象子文档使用独立归属 id（`…​#smart-child`），不冒用父文档。

核心包只提供纯状态机与端口：节点投影、保存回执、文件选择与关闭确认都在宿主适配层。

### 笔刷库、跨文档剪贴板与嵌入子文档（change: 2026-10-22）

这些能力都**不是**新的全局单例：各自挂在控制器/工作区上，随文档或工作区释放。

- **笔刷库**（`brushLibrary()` → `BrushLibraryController`）：预设保存/覆盖/改名/删除/分组、
  ABR 预检与「仅导入可支持子集」、图片采样笔尖，以及**真实内核笔迹预览**
  （`brushPreview`，与正式笔迹同一 `render_stroke`）。库是工具状态：写入不产生工程 dirty，
  持久化失败保留内存库并报告 `persistence: "failed"`，不宣称已保存。
  持久化经 `EditorWorkspaceOptions.brushStorage`（`load`/`save`）注入；缺省只在会话内。
- **跨文档剪贴板**：`copyLayers()` 导出**自包含** `LayerTransferBundle` 字节；控制器**不缓存**
  它，载荷由工作区持有，因此不同工作区不会串剪贴板，源文档关闭后仍可粘贴。
  `canPasteLayers()` 是只读预检，`pasteLayers(bytes, { inPlace })` 一步原子提交
  （图层/图案/嵌入源身份重映射，等价资源复用，冲突 id 改写）。
- **图片置入**：`inspectPlace(bytes)` 预检真实解码类型与尺寸，`placeAsset({ name, bytes, mode })`
  只往**当前**文档加层（`pixel` 或 `smartObject`）。打开文件 ≠ 置入。
- **PSD**：`psdMatrix()` 是兼容矩阵唯一声明；`inspectPsd` / `openPsd({ flat })` / `inspectPsdExport`
  / `exportPsd({ rasterizeLossy })`。默认拒绝不可编辑结构，`flat`/`rasterizeLossy` 必须显式选择；
  导出只交付文件，**不**推进工程保存基线。
- **栅格交换**（change: `2026-10-22-add-photocraft-raster-interchange`，U05/U06/U07）：域会话是
  `controller.features.io`，入口是本域贡献的「图像 ▸ 格式与导出…」面板，共享「文件」菜单的
  「导出为…」「Save for Web…」也落到同一面板（菜单只发「打开本域面板」，页签/模式语义归本域
  `features/io/menu-request.ts`）。读：`matrix()`（真实构建
  的逐格式读写/位深/布局/Alpha/metadata/feature/准入矩阵）、`openAccept()`（**从同一份矩阵派生**
  的文件选择 `accept` 与扩展名列表：宿主用它替换硬编码的 `image/png,image/jpeg,image/webp`，
  暂缓格式不入列；`<input accept>` 首帧可用值另由协议域 `OPEN_RASTER_ACCEPT` 提供，两者由真实
  产物断言钉住一致）、`inspectOpenRaster(bytes)`（只给预检结论，宿主先预检再把原始字节交给内核，
  实际打开仍走 `openImage`）。写：`previewExport` / `exportRaster`（预览与交付同一编码器、同一设置，
  逐字节相同）、`inspectExport`（只归一化设置与目标尺寸，不编码）、`inspectLayerExport` /
  `exportLayerBundle` / `exportLayerAs` / `inspectImageAssets` / `exportImageAssets` /
  `inspectBundle`。全部交付都是**一次触发 → 一个内存产物**，`report.documentChanged` 恒为
  `false`，不推进保存基线。会话把内核给出的真实反馈原样带出，界面不得只报成功：导出报告的
  `warnings`（量化、DPI 丢弃等不可逆损失；Save for Web 的量化/有损/透明退化由真实编码结果推导，
  不是固定文案）、逐层/资产计划的 `rejected`（超预算、目标层失效）
  与 `renames`（重名、非法字符、保留名）都会显示。打开走与 `inspectRaster` **同一套**真实解码
  准入（16 位/浮点样本按「不自动降位深」拒绝，不会出现预检拒绝而打开成功）；预算唯一权威是
  `@woohaa3/photocraft-protocol` 的 `interchange-budgets.json`。13 个新增 WASM 绑定在
  `features/io/wasm-instance.ts` 声明为可选，旧内核产物缺导出时返回
  `capability-disabled`（提示更新 WASM 产物），不是 `TypeError`。
  逐格式矩阵与暂缓原因见
  [change 证据](../../openspec/changes/2026-10-22-add-photocraft-raster-interchange/evidence/interchange-matrix.md)。
- **智能对象子文档**：`beginSmartChild(layer)` / `updateSmartParent(attemptId, childBytes)` /
  `reloadSmartChild()` / `exportSmartChild()` / `detachSmartChild()` / `closeSmartChild()`。
  `attemptId` 幂等：**同一子会话内**的重试返回原结果（`replayed: true`），不重复提交父历史；
  关闭重开、重载父源、分离副本都会开新会话并作废旧回执（UI 用的是子修订号做键，新会话可能
  回到同一个数，不能把新编辑当成旧回执丢掉）。`detachSmartChild()` 之后会话改绑到新副本自己的
  `contentsId`，继续编辑再 `updateSmartParent` 会写进副本而不是被「共享源已更换」拒绝。父修订
  变化、删层、换源都拒绝覆盖并保留子文档。
- **智能对象源入口**：`smartLayerStateJson(layer)` 给每个父层入口的可用性与确切原因（只读，
  不要求已打开子会话）；`exportSmartSource(layer)` 逐字节导出嵌入源；`convertSmartToLayers(layer)`
  把嵌入源解包成普通层/组（一步历史、其他共享实例不变，无法表示的实例效果明确拒绝而不是栅格化）。
- **P5–P7 草稿入口**：`histogram`（只读、带 `generation`，旧结果被丢弃）、
  `beginSelectionModify`/`commitSelectionModify`、`prepareRefineEdge`、
  `beginRetouch`/`appendRetouch`/`commitRetouch`、`beginFilter`/`commitFilter`、
  `beginCompose`/`commitCompose`、`setViewAids`/`snapPoint`、`filterLayers`、
  `applyTypography`、`vectorCommand`、`guideCommand`、`vectorSnapshot`、`checkFont`。
- **图像模式与颜色表**（`controller.features.modes`）：`modeInfo`（只读）、`planMode`/`applyMode`、
  `planColorTable`/`applyColorTable`。计划是独立会话里的候选与预览，正式文档不动；确认时把
  `baseRevision`/`baseContentHash` 交回内核复算。计划另外带工作区盖的 `owner{documentId,generation}`，
  所以「关闭后重开同一节点」「切到同尺寸同修订的另一份文档」都不会被误认成当前文档。冻结/保存
  期间返回 `frozen`，与其它草稿并存时按 `<draft>-active` 拒绝；只读的 `modeInfo` 不受影响。
- **矢量工具（change: `2026-10-22-add-photocraft-vector-canvas-tools`）**：形状/钢笔/路径编辑
  不是新的控制器端口，而是 `features/vectors/` 的域内实现 + 共享画布的一个指针入口
  （`PhotoCanvas.onVectorPointer`）。画布只把客户坐标换算成文档坐标并转发，几何、命中、命令与
  叠加层都在域内（`vector-tools.ts` 归约器、`canvas-bridge.tsx` 持有状态并**松手才提交**）。
  路径编辑的当前几何来自只读的 `path.info`，不经过 `dispatch`，因此读几何不会制造 dirty。
  面板与画布共享三个域内小 store（形状参数与单击尺寸输入、预设选择、路径目标），它们都是
  **工具状态**：不进文档、不进历史、不影响内容身份。整库恢复（`restoreSnapshotParams`）
  目前没有调用方，属宿主持久化端口，需要时再开口。
  文档归属：未结算的矢量手势通过 `setVectorDraft(active)` 登记进统一草稿门禁；提交时携带
  `token()` 取得的文档代际令牌，换文档后晚到命令返回 `stale` 且不调用内核；矢量写入与
  `dispatch` 共用保存/导出的冻结窗口（`writesFrozen()`）。
  内容身份：已存命名路径 / 工作路径 / 裁切引用经 `document_paths_identity`（Rust）与
  `canonicalizeSavedPaths`/`canonicalizeWorkPath`/`canonicalizeClippingPath`（TS）进入 `contentHash`，
  空值整体省略以保持旧工程指纹不变。

### 参数滤镜、画廊与摄影滤镜（change: 2026-10-22）

滤镜域的入口都在 `controller.features.filters` / `handle.features.filters`，不扩充集中 facade。
草稿四步沿用 P6 的 `beginFilter` / `updateFilter` / `commitFilter` / `cancelFilter`；本 change 追加：

- `filterCatalogue()`：分类、命令、交互形态与参数 schema。**范围只有一份**——内核从上游
  `CommandSpec.params` 记法解析，面板不手写 `min`/`max`/选项；清单不可用时面板不渲染，
  而不是画出半套滑杆。
- `filterLast()` / `repeatLastFilter()`：「重复上次」用内核保存的**规范参数**（含冻结 seed 与
  前后景色快照）重建草稿，目标换成当前可写层，仍需显式确认。
- `filterGalleryDefaultStack()`：滤镜库首次打开就有可预览的默认组合。
- `filterMapSources()` / `filterNormalizePoint()`：置换滤镜只从**已打开文档**取位移图
  （本机路径一律拒绝）；图内控制点用文档像素，换算成 0–1 交给内核。端口按文档带出**可作位移图的
  可见像素图层**——内核 `mapLayer` 收的是位移图文档内的图层 id，只给文档列表时用户只能压平整份
  文档，「用其中某一层」这条能力就没有入口。
- `filterLayerSources()`：消失点粘贴的**图层**来源。内核 `paste[].layer` 只认图层 id，没有这个
  端口时粘贴只剩「先把内容复制到剪贴板」一条路（而本应用尚未开放剪贴板命令）；端口只列可见且
  带像素的图层，并标出活动层。
- `filterPathSources()`：火焰滤镜的 `path` 来源。`path` 是**已保存路径的名字**（留空表示跟随
  工作路径，没有工作路径时用第一条已保存路径），不是坐标数组；端口另外回报是否存在工作路径，
  面板据此改默认项文案。
- `filterDraftState()`：面板重挂载后回读草稿，避免把用户没见过的输入当成「确认」。

图内几何与结构型参数只在命令**声明**了对应参数时才出现：模糊画廊的 `pins`（移轴没有该字段）、
路径模糊的 `paths`、消失点的 `planes` / `clone` / `paste`、自适应广角的 `constraints`、镜头校正的
`straighten`、自定卷积的 `kernel`、Camera Raw 的 `pointCurve*` / `hsl*` / `grade*` / `curveSplits`、
光照效果的 `lights`、火焰的 `path`、切变的 `points`（`[t, offset]` 折线，未自定义时按 `amount` 画出
内核会用到的缺省三点曲线）、位移图的 `mapDocument` / `mapLayer` 两级选择器、画廊的 `glowColor`。
声明驱动而非按 `kind` 猜测，可以避免「面板写了一个内核不读的字段、改动静默无效」；反过来，结构型
参数一旦没有控件，用户就只能用到滤镜的一半。这条由 Rust 侧的 `structured_params_have_an_owner`
**穷举**钉住：目录里每个 `resource` 字段都必须归类（图内编辑器 / 普通选择器 / 会话颜色注入 /
内核旁路），未归类即测试失败，新增字段忘了接控件不会被放过。

结构型参数的面板侧约束照抄内核，避免把注定被拒的输入送出去：点曲线 2–16 点、输入严格递增且每段
差 ≥1、坐标 0–255（写回非法值时收敛成内核接受的空曲线 = 不调整）；HSL 恒为定长 8 段；
色彩分级 `hue` 按 360 取模、`sat` 0–100、`lum` −100–100；光源组至少保留一盏（空数组会让内核
退回顶层单灯字段）；透视克隆缺 `source` 或缺落笔点的条目直接丢弃；切变曲线保持 `t` 单调不减且
1–64 点，乱序输入不送内核而是回退到 `amount`；位移图换文档时清掉旧文档的图层号，选「整份文档」
时删字段而不是写 0（0 会被当成不存在的图层）。

本 change 只新增**命令**，不新增 capability id（`proposal.md` 的 New Capabilities 为空），
因此 `contract.json` 的能力清单不变。

控制器用 `blockingDraft()` 与 `hasActiveDraft()` 统一门禁：任何草稿未结算时，其它写入口、
保存、切换与关闭都返回 `<draft>-active` 原因，不会自动确认旧预览。冻结/保存是另一类拒绝
（`frozen`），由 `isSaving()` 判定；宿主不要把它们合并成一个布尔，否则用户看不出该等回执还是
该先结算草稿。

### 绘画域（change: 2026-10-22-add-photocraft-painting-color-workflows）

绘画功能按域目录交付，面板挂在 `FEATURE_SECTIONS` 的「绘画工具与颜色…」分区：

- **契约在协议包**：`@woohaa3/photocraft-protocol` 的 `features/painting/workflow.ts` 导出混合
  模式归一、采样尺寸/图层策略、对称模式、笔刷大小与预设边界和对应校验器；编辑器与协议共用
  同一份定义，不各写一套。
- **两条命令通道**：`paintCommand` 过草稿门 + 保存冻结门并同步视图（像素写入口），
  `preferenceCommand` 只改工具/偏好、不产生 dirty。两条通道互相拒绝对方的命令 id。
- **9 个工具已发布在工具轨**：铅笔/颜色替换/背景橡皮/魔术橡皮/渐变/油漆桶/吸管与原有的画笔、
  橡皮并列，逐个声明手势（`stroke`/`point`/`sample`）、目标与顺序。唯一的接线表是
  `features/painting/tool-manifest.ts`，域内回归逐条比对它与 `feature.tools`，因此不会出现
  「清单写了但没发布」或「发布了但点了没反应」。逐工具设置与命令编译在
  `gesture-settings.ts`，共享外壳只调编译函数，不复制参数模型。
- **取色写回**：吸管与色板经 `FeaturePanelContext.setColor`（可选端口）写回前景/背景色；宿主不
  提供该端口时面板如实降级为只读报告，不留假控件。
- **验收套件**：`tests/features/painting/run.mjs` 用真实 WASM 跑 14 个文件 / 164 条断言，
  覆盖 U27–U36 的像素结果、一步撤销、工程往返与「偏好不进内容」，末尾的 `cross-domain.mjs`
  跑绘画 × 选区/图层/蒙版/分组/历史/保存/原生核验/PSD 的跨域一致性。

### `EditorInstrumentation` 与测量

`setEditorInstrumentation({ phase, metric, preview })` 注入宿主性能插桩；传 `null` 恢复零成本
直通。内核已对全图/区域读取、像素拷贝和预览阶段埋点，宿主只收集，不参与编辑语义。

### 取景与预览发布

`PhotoEditorApp` 接收 `canvasView: PhotoCanvasView`（`contentSize`、`viewport`、`fitZoom`、
`onChange`）与 `onPreview`；`renderCanvasBackground` 是像素呈现端口——Woohaa 让 Bevy 节点在
透明交互层下呈现，独立 dev 宿主用 Canvas 画同一份 RGBA。`PhotoCanvas` 只处理手势与选区叠加，
不是完整图片 renderer。

### 预设存储

包内提供默认存储适配，键与旧版**逐字一致**，宿主不必迁移数据：

- 等高线库：`localStorage` 键 `woohaa.image-editor.contours.v1`（最多 64 条 / 1 MiB）。
- 图案库：IndexedDB 数据库 `woohaa.image-editor.patterns.v1`，对象仓库 `library`、键 `current`。
- 面板布局：`localStorage` 键 `woohaa.image-editor.panels.v1`。

存储受限时保留当前内存库并提示重新加载可能丢失；坏存储不覆盖已有库。写入顺序由包内串行队列
保证，旧快照不会覆盖新快照；退出或禁用后的迟到写入不落到新会话。

## 取消、释放与重试

- 画布手势、自由变换、文字/调整/属性草稿都可取消；取消恢复正式内容，不新增历史。
- 保存中退出、释放或切换会话后，迟到预览、Dialog、区域读取与上传回执一律不发布。
- 内核缺失、字体/能力不匹配或原生失败进入可操作错误态；PNG 可读时宿主可继续只读查看，禁止
  从 PNG 静默重建丢图层的工程。
- **切换文档不等于销毁文档**：活跃呈现（预览、输入、弹窗）可以解绑，但控制器、内核与撤销历史
  随文档存活；只有关闭文档或页面结算才释放。宿主不能靠挂载多份隐藏编辑器保留状态。

## 提交前检查

```bash
pnpm -C photocraft/packages/editor run typecheck
pnpm -C photocraft/packages/editor test
```

测试里凡是会触摸 `EditorWorkspaceController` 的用例都必须显式给出 `session`
（`EditorDocumentSession`）——多文档工作区让「同一实例可能被多个文档复用」，所以会话身份
不再是控制器内部的隐式单例。

## 开发与测试

```bash
pnpm -C photocraft/packages/editor run typecheck
pnpm -C photocraft/packages/editor test
pnpm -C photocraft/dev dev        # 真实 WASM 的独立宿主（默认 http://localhost:4318）
```

`pnpm -C photocraft test` 按 workspace 顺序跑协议、核验器、编辑器与 dev 的检查；Woohaa 适配包
属于宿主 workspace，单独运行
`pnpm -C web --filter @woohaa3/photocraft-woohaa test`。需要 DOM 的用例在文件头使用
`@vitest-environment jsdom`。

## 领域实现与并行扩展

实现按 `src/features/<domain>/` 分为 18 域。`features/index.ts` 一次装配工具/面板/菜单，
`features/sessions.ts` / `handles.ts` 一次装配全部 typed 会话。现有导出路径继续兼容。
新领域操作通过 `controller.features.<domain>` / `handle.features.<domain>` 接入，
在本域 `workspace.ts` / `wasm-handle.ts` 的工厂中声明，不扩充集中 facade。

文档/历史、指针仲裁、保存/导航门禁和全局协议仍各有唯一权威。
完整归属、输入/输出和共享接口见 [领域边界](../../notes/feature-boundaries.md)。
真实 WASM 构建后运行 `pnpm -C photocraft features:check`：它断言重构前的 8 组状态/内容快照、撤销重做、错误文案与 PNG 字节未变，命令与能力的增量只能来自 `notes/feature-boundary-additions.json` 的登记。
