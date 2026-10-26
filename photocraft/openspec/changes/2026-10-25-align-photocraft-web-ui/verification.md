# Verification

本轮已完成范围、每个菜单块和能力边界见 [ui-parity.md](ui-parity.md)。文档工作区、顶部窗口标题栏和画布渲染仍由原有实现负责。

## 自动检查

- `pnpm -C photocraft/packages/editor run typecheck`：通过。
- `pnpm -C photocraft/packages/editor exec vitest run`：119 个文件，673 项通过。覆盖菜单层级/门禁、dock 实际菜单与关闭重开、Tab 节点保留、隐藏时取消读取、排序/高度取消、参数对话框、预设参数同步、采样设备数据及时间调度、搜索工具变体身份和精确名称排序。
- `pnpm -C photocraft/integrations/woohaa exec vitest run`：45 个文件，394 项通过。包含 embedded 标识、透明主题根、宿主内容矩形、runtime 更新、编辑/保存流程、工具循环与临时切换、菜单和面板读操作。少量现有 React act 警告不影响测试结果。
- `pnpm -C photocraft/integrations/woohaa run typecheck` 与 `pnpm -C photocraft/dev run typecheck`：通过。
- `pnpm -C photocraft/dev exec vite build --outDir /tmp/photocraft-ui-review-dist`：独立宿主生产构建通过；有单包体积提示。
- `/root/.cargo/bin/cargo test --manifest-path photocraft/rust/Cargo.toml -p photocraft-embed-editor --lib --offline`：236 项通过。
- `node photocraft/scripts/build-wasm.mjs --skip-opt --keep-names`：构建通过，新 WASM 已用于下述真实内核检查。
- `node photocraft/tests/wasm-interactions.mjs`：通过。新增命令表必需元数据、亮度/色相/曲线实际修改与撤销、画笔预设尺寸/混合模式/平滑语义往返、喷枪时间请求/一次提交与撤销检查。
- `pnpm boundary:check`：通过。
- HTTP 体验地址兼容性：在 `http://21.6.210.220:4318/`（`isSecureContext=false`、`crypto.randomUUID` 不存在）导入图片成功；PhotoCraft 使用 `getRandomValues` 生成 UUID v4。主应用运行时 token 同样覆盖该回退路径。
- `openspec validate 2026-10-25-align-photocraft-web-ui --strict`：通过；新增要求仅留在 change delta，避免归档时与 base spec 重复。
- `git diff --check`：通过。

## 实际浏览器检查

使用独立 dev 宿主和真实 WASM 导入 640×480 测试图，按真实 DOM 菜单操作；另用临时 React embedded 宿主检查透出底层 canvas，临时验证页面已移除。测试数据与截图位于 `/tmp/photocraft-*`，不进入 Git。

- 依次打开文件、编辑、图像、图层、文字、选择、滤镜、视图、窗口、帮助，命令表为 302 条已开放记录；没有整表解析失败或空顶级菜单。
- 打开亮度/对比度、曲线、色相/饱和度、图层重命名、新建参考线实际对话框；确认亮度、重命名与参考线成功，撤销内容操作恢复原状态。
- 窗口可打开画笔和画笔设置；实际列出 36 个内置预设；应用 Soft Round 后 native 和下一笔参数为 size 45、hardness 0，列表没有响应解码错误。
- CDP 模拟 pen 拖动保留小数坐标、压力、tiltX/tiltY、twist 和时间戳；原生 begin/append/commit 链路只提交一次，撤销后 dirty=false。
- 应用 Airbrush Soft 后模拟原地按笔 350ms，实际出现同位置 append，抬笔只产生一次 commit；真实 WASM smoke 另验证其 history/撤销。
- embedded 1440 级桌面视口与 1024×768 视口：canvas 矩形与 host canvas 相同，menubar/contextbar/toolrail/sidebar/status 与中间矩形交叠集合为空；从 canvas 到主题根全部 computed background 为透明且无背景图；中心命中 PhotoCanvas 手势层，截图可见其下宿主内容。
- standalone 1440×900 和 1024×768：页面不横向溢出；过长选项栏仅在本区域横向滚动；面板 Tab strip 保持在组标题行内。
- 图层面板在 1440×900 与 1024×768 均保留可见图层列表：列表优先填充组剩余高度，锁定图标栏与底部操作栏固定，1024 宽度仍可见至少一整行图层。
- 最终页面刷新后再次检查真实 WASM：36 个预设可列出，Soft Round 的下一笔 size=45、hardness=0，history 从 1 到 2，恰好一次 commit；搜索“画笔”首项准确，选择“椭圆选框”后工具栏和选项栏同时切为椭圆选框，未出现面板错误。
- 主应用 `http://127.0.0.1:5173/` 与独立宿主 `http://127.0.0.1:4318/` 均 HTTP 200，监听 `0.0.0.0`；本机网络入口为 `http://21.6.210.220:5173/` 和 `http://21.6.210.220:4318/`。独立宿主需要导入图片。

## 硬件验收限制

Linux 检查未发现 `/dev/dri/renderD*`；现成 Chromium 使用 SwiftShader。以上浏览器结果只证明结构、透明叠层、模拟设备事件与 CPU/native 功能，不作为真实 GPU 性能或实体数位笔手感证据。这两项需在有真实 GPU 与实体笔的设备上验收。

## 4318 与真实 Woohaa 节点入口复核

基准为用户确认的 `http://21.6.210.220:4318/`，宿主为 5173 的实际画布，直接双击已有图片进入 PhotoCraft。没有使用临时 embedded harness 代替真实入口。两端协议依赖与本地运行产物按当前分支重建，消除了客户端协议 4 / 后端旧产物协议 6 的混用问题。

- 两端逐个展开十个菜单，编辑/图层/文字/选择/滤镜/视图/帮助的可见条目及顺序一致。Woohaa 的文件菜单额外有新建、打开、关闭、关闭全部、关闭其他文档；图像菜单额外有复制文档；窗口菜单额外列出宿主文档。这些来自宿主端口，独立 dev 未提供多文档能力。
- 十个菜单的项目均为 13px，字体栈一致；选中画笔时，工具列和选项栏按钮的标签、字体、宽高逐项一致。
- 实际发现并修复：宿主字体继承；标签栏重复占用 34/42px；普通选项栏 CSS 48px 与布局 52px 不匹配；内嵌窄选项栏被高优先级选择器强制保留普通高度；嵌入侧栏延伸至菜单栏、菜单未横贯窗口；竖图缩略图超出按钮。
- 1440×900 普通/大标签/大标签加窄栏，1024×768 大标签加窄栏/普通，以及恢复 1440×900 六组实际布局断言通过。交互层 x/y/width/height 全等于宿主 focus content rect；菜单/选项栏/工具列/侧栏/状态栏均不与中央矩形相交；从 canvas 至主题根背景透明且无背景图；标签栏下沿接画布，左右栏上沿接选项栏，无页面横向溢出，缩略图不超出按钮。
- 本次运行：editor 与 Woohaa typecheck 通过；`image-editor-overlay`、`editor-chrome-mode`、`document-tabs` 共 15 项通过；独立生产构建通过（保留已有大包提示）；`pnpm boundary:check` 和 `git diff --check` 通过。
- 本轮浏览器记录在 `/tmp/pc-menu-parity.json`、`/tmp/pc-layout-verification.json`，截图在 `/tmp/pc-final-aligned.png` 与 `/tmp/pc-final-1024.png`。未保存或应用用户图片内容。
