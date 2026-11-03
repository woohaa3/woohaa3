# 性能读数

独立可选扩展，提供画布 FPS 与 3D Draw Call 读数：36 × 26 的 SVG，两行分别为 FPS 和 DC，标签 8px、数值 10px，无独立底板和边框。位置随宿主二选一：**浏览器**通过 `canvas.toolbar-status` 进入画布右下角工具栏的原同步图标位置；**Tauri 桌面壳**注册 `canvas.topbar-status`，由宿主并入窗口横栏右侧的**合并读数**——同步/连接状态与 FPS/DC 共用同一个按钮和一个气泡（向下展开，横栏上方没有空间）。SVG 行高收到 22px 适配 26px 横栏。桌面端右下角工具栏因此不再重复显示同步状态位，只保留功能图标与视图控件；浏览器仍是工具栏状态位、气泡向上。运行宿主由扩展调用 `isDesktopHost()` 判定，宿主不按扩展 ID 分支，两侧不会同时渲染。同步图标移除，原同步状态气泡与异常常驻提示保留；未启用扩展时工具栏入口显示「状态」小字。默认启用，可在插件管理器中关闭「性能读数」。

注册门禁按宿主分两种：**桌面壳无论开发还是打包发行都注册**。发行版由 `--mode desktop` 生产构建，HTML 里没有 `woohaa-development` 标记，但 FPS/DC 正是打包版要长期显示的读数。浏览器仍只认 Vite dev 注入的 `woohaa-development=true` HTML 元数据，生产与 preview 构建不注册读数或采样循环。桌面发行包按目录位置装配：本扩展位于 `web/extensions/`，会随包带上 `browser-dist/`，否则打包版装配不到读数实现。

读数来源同样按宿主开放：[bevy-runtime.ts](../../frontend/src/cordis/plugins/canvas-runtime/bevy-runtime.ts) 的 `frameCountersReadable(dev, target)` 在「开发构建或注入了 `__WOOHAA_NATIVE__` 的桌面壳」时挂载 `getFrameCounters`，浏览器生产与 preview 构建不暴露；渲染三阶段/实例数这类归因字段仍只在 dev 构建附加，不进打包版的读数。

每秒读取 Bevy 已有 `runtime_health` 累计 render/update 计数，不创建额外的逐帧 rAF。读数常显 FPS 与每帧 3D Draw Call；悬停时通过宿主注入的同一个状态气泡显示保留两位小数的完整 FPS、Draw Call、逻辑更新率、平均渲染间隔，不依赖 SVG title 或原生 `title`——工具栏里气泡向上展开，顶栏里向下展开。紧凑读数按三位数留宽，超出时显示 `999+`。Render PostCleanup 完成计数不表示 GPU 呈现确认或 GPU 时间；Web renderer 上限取 `min(120 FPS, 屏幕刷新率)`，由 120 Hz 调度间隔和浏览器 rAF/FIFO 垂直同步共同约束。后台暂停，重新可见后重置窗口，卸载时释放回调和监听。读数继承所在宿主的布局和层级，不创建独立定位浮层。

`DC` 使用所有视图的 Bevy Material 3D 主通道实际绘制 API 调用计数：直接绘制及间接/multidraw 调用各计一次，不按实例数或间接参数槽数推算 GPU 展开后的次数。复用已有 DrawMesh 诊断，不改变合批、裁剪或间接绘制策略；不包含 2D、阴影、深度预通道和后处理，也不是驱动提交数。`runtime_health.drawCalls3d` 在 Render PostCleanup 发布完成帧对应的累计值，读数按窗口内绘制增量除以渲染帧增量；缓存预览没有重绘 3D 时可为 0。无渲染帧、旧 runtime 无字段、诊断关闭或计数不可用时显示 `—`，不影响 FPS。

```sh
pnpm -C web --filter @woohaa3/extension-dev-performance test
pnpm -C web --filter @woohaa3/extension-dev-performance typecheck
pnpm -C web --filter @woohaa3/extension-dev-performance build:browser
```

单元测试验证累计帧率计算、运行时重建、缺失计数、后台恢复、卸载与注册门禁（含桌面发行版无开发标记仍注册、浏览器生产构建不注册）。不依赖 GPU。真实 GPU 的面板显示和画布操作验收待人工验证。

状态贡献以 `wrapsStatus: true` 声明通过宿主 `renderStatus` 装配气泡；旧版只返回 SVG 的贡献由宿主继续包裹，避免 HMR 混用新宿主与旧扩展时丢失 hover。开发验证还需核对运行中 `/extension-releases/current.json` 指向的 artifact 与刚构建的版本一致；仅运行扩展构建或预检不会替换已加载的发布目录。构建后需完成装配、刷新宿主发布目录并重载页面。打包版验证需在真实 GPU 上打开桌面发行包，确认横栏合并读数出现 FPS/DC 且悬停详情完整。
