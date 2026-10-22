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

核心包只提供纯状态机与端口：节点投影、保存回执、文件选择与关闭确认都在宿主适配层。

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
