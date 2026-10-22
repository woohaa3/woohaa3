# 开发性能面板

独立浏览器可选扩展，通过 `canvas.toolbar-status` 在画布右下角工具栏的原同步图标位置提供性能读数：36 × 26 的 SVG，两行分别为 FPS 和 DC，标签 8px、数值 10px，无独立底板和边框。该位置只在**浏览器**使用；Tauri 桌面壳改为注册 `canvas.topbar-status`，由宿主并入窗口横栏右侧的**合并读数**——同步/连接状态与 FPS/DC 共用同一个按钮和一个气泡（向下展开，横栏上方没有空间）。SVG 行高收到 22px 适配 26px 横栏。桌面端右下角工具栏因此不再重复显示同步状态位，只保留功能图标与视图控件；浏览器仍是工具栏状态位、气泡向上。运行宿主由扩展调用 `isDesktopHost()` 判定，宿主不按扩展 ID 分支，两侧不会同时渲染。同步图标移除，原同步状态气泡与异常常驻提示保留；未启用扩展时工具栏入口显示「状态」小字。开发模式默认启用，可在插件管理器中关闭「开发性能面板」。只在 Vite dev 注入的 `woohaa-development=true` HTML 中注册读数；生产和 preview 不注册读数或采样循环。

每秒读取 Bevy 已有 `runtime_health` 累计 render/update 计数，不创建额外的逐帧 rAF。读数常显 FPS 与每帧 3D Draw Call；悬停时通过宿主注入的同一个状态气泡显示保留两位小数的完整 FPS、Draw Call、逻辑更新率、平均渲染间隔，不依赖 SVG title 或原生 `title`——工具栏里气泡向上展开，顶栏里向下展开。紧凑读数按三位数留宽，超出时显示 `999+`。Render PostCleanup 完成计数不表示 GPU 呈现确认或 GPU 时间；Web renderer 上限取 `min(120 FPS, 屏幕刷新率)`，由 120 Hz 调度间隔和浏览器 rAF/FIFO 垂直同步共同约束。后台暂停，重新可见后重置窗口，卸载时释放回调和监听。读数继承所在宿主的布局和层级，不创建独立定位浮层。

`DC` 使用所有视图的 Bevy Material 3D 主通道实际绘制 API 调用计数：直接绘制及间接/multidraw 调用各计一次，不按实例数或间接参数槽数推算 GPU 展开后的次数。复用已有 DrawMesh 诊断，不改变合批、裁剪或间接绘制策略；不包含 2D、阴影、深度预通道和后处理，也不是驱动提交数。`runtime_health.drawCalls3d` 在 Render PostCleanup 发布完成帧对应的累计值，读数按窗口内绘制增量除以渲染帧增量；缓存预览没有重绘 3D 时可为 0。无渲染帧、旧 runtime 无字段、诊断关闭或计数不可用时显示 `—`，不影响 FPS。

```sh
pnpm -C web --filter @woohaa3/extension-dev-performance test
pnpm -C web --filter @woohaa3/extension-dev-performance typecheck
pnpm -C web --filter @woohaa3/extension-dev-performance build:browser
```

单元测试验证累计帧率计算、运行时重建、缺失计数、后台恢复、卸载与开发模式门禁。不依赖 GPU。真实 GPU 的面板显示和画布操作验收待人工验证。

状态贡献以 `wrapsStatus: true` 声明通过宿主 `renderStatus` 装配气泡；旧版只返回 SVG 的贡献由宿主继续包裹，避免 HMR 混用新宿主与旧扩展时丢失 hover。开发验证还需核对运行中 `/extension-releases/current.json` 指向的 artifact 与刚构建的版本一致；仅运行扩展构建或预检不会替换已加载的发布目录。构建后需完成装配、刷新宿主发布目录并重载页面。
