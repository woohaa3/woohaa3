# 本机 Bevy 画布基准

## 在当前主画布采集退化现场

针对「初始空场约 111 FPS → 看过片场 → 回到空场仍约 40 FPS」，在发生问题的同一应用窗口、同一次运行内采集，保留真实构建和用户画布。打开 DevTools，把 [capture-session.js](capture-session.js) 全文粘贴到 Console 或 Sources Snippet 执行。脚本只按需读取已有诊断、在内存保留最多 12 段，不自动上传、不改画布，也不开常驻采样循环。

每个状态稳定后执行对应一行，等待返回表格再进入下一阶段：

```js
await __canvasPerfProbe.sample("initial-empty"); // 初始空场，默认采 20 秒
await __canvasPerfProbe.sample("world-camera");  // 主画布中查看共享世界镜头后
await __canvasPerfProbe.sample("returned-empty"); // 返回原空白区域或原空画布后
await __canvasPerfProbe.sample("returned-after-60s"); // 返回空场等 60 秒，再采一段
```

阶段之间按真实复现路径移动/切换画布；采样的 20 秒内保持应用可见、停止输入，不刷新、不切主题、不缩放窗口，保持缩放和显示器一致。DevTools 使用独立窗口，避免挤压画布导致比较尺寸变化。缺失字段保留 null；切后台、采样期间切画布/文档 revision 变化、渲染器重建或无出帧的阶段标为 invalid。最后在 Console 执行 `copy(__canvasPerfProbe.json())` 保存完整 JSON；没有 `copy` 的 DevTools 可查看 `__canvasPerfProbe.json()` 的返回值。刷新会清空内存，先保存报告。

报告每段保存阶段前后原始健康计数、Rust 工作诊断、JS 工作计数、资源驻留、总览缓存，以及轻量场景身份/节点数/视口。桌面新版前端使用异步诊断 RPC；旧版前端回落到同步读取，仅在两端各读一次，边界读取耗时单列为 `boundaryReadMs`。当前工具测量的是 20 秒平均完成帧率，没有逐帧尾延迟数据。

比较 initial-empty 与 returned-empty：

| 差异 | 下一步检查 |
| --- | --- |
| 返回后 `modelEntities` / 活跃预览 / `drawCalls` 仍高 | 屏外裁剪、预览相机停用、片场根与缓存呈现生命周期；驻留数量单独偏高不能证明仍在绘制 |
| `prepareMs` 上涨，`models.nativePreparation` 仍有排队/retiring | 准备或退役任务未收敛；结合两端快照观察进度 |
| `queueMs` / `renderMs` 上涨 | 渲染排队、资源提交或阶段内驱动等待；这些都是 CPU 墙钟，不能称 GPU 耗时 |
| JS `sceneBuilds` / `sceneSubmits` / `modelPrepareCount` 持续增长 | 场景重复失效、模型重复准备或业务订阅未停止 |
| 工作量和 CPU 阶段恢复，但 FPS 持续较低 | 在同一真机追加浏览器 Performance trace 或原生 profiler，检查帧间等待、主线程、驱动与系统调度 |

`renderFps` 与性能徽标同源（Bevy PostCleanup），不是 GPU present；不同来源的耗时不可相加。资源预算中的 GPU bytes 是估算，不能当实测显存。`perf.frame` 本机遥测仍按原有 60 秒窗口聚合，本脚本不把短窗伪装成该事件；需要同时复盘时，在采完现场后查看 `/telemetry` 或 `/api/telemetry/events?window=1h&names=perf.frame&names=perf.lod&limit=200`。

工具只在客户端内部运行；真实 GPU + headed Chromium + performance WASM / production frontend。它不会调用在线生成服务或触碰用户画布。浏览器与宿主每个 attempt 重建，E2E 服务使用独立临时 SQLite、内存媒体存储和确定性 provider。基准专用宿主关闭可选后端 Agent/付费 Provider 扩展，保留真实 Canvas/Media/Task 路径。

## 准备

在客户端根目录：

```sh
pnpm -C web install --frozen-lockfile
pnpm -C web run build:units
node scripts/build-bevy-wasm.mjs --mode performance
pnpm -C web/frontend exec vite build --outDir dist-benchmark --sourcemap
pnpm -C web exec playwright install chromium
node --test scripts/canvas-benchmark/*.test.mjs
```

运行时需保持测试窗口可见、接电和显示器配置不变，避免编译、视频会议及其它重负载。不要把未安装浏览器、缺显示会话或软件 renderer 写成“无 GPU”。本机平台检测之外，还会核对实际 Chromium adapter。

WSL2 / 容器里没有 DRM 设备与显示会话：设置 `WOOHAA_E2E_CDP`（宿主浏览器 CDP，例如
`http://127.0.0.1:9222`）与 `E2E_BASE_URL`（宿主可达的基准服务地址，配合
`ssh -L <port>:127.0.0.1:<port>`）后，`run.mjs` 会把这些变量透传给用例，基准改用
`connectOverCDP` 驱动宿主浏览器；GPU 证据仍取该连接的 `SystemInfo.getInfo`。仅连接成功不算
硬件通过。

## 计划与运行

计划为 JSON 数组，例如：

```json
[
  {"label":"A","cell":{"nodes":1000,"visible":24,"kind":"text","round":0},"duration":10000,"warmup":10000},
  {"label":"B","cell":{"nodes":1000,"visible":24,"kind":"text","round":0},"duration":10000,"warmup":10000}
]
```

`A`/`B` 只是标签；同一构建的 A/B 属于 A/A 校准，不能声称有代码优化。正式对照先冻结构建与配置，再随机 AB/BA。

kind 支持 text、image-shared、image-unique、model、model-unique。图片是确定性的真实 PNG，经真实媒体接口上传；模型是自包含 box/sphere Scene 脚本。资源组只转换起点/远处工作集，剩余离屏节点仍为文本；`mediaCount` 可限制每个区域模型数量。图片默认 1024²，显示档位由原有 residency 策略决定。visible>24 使用显式重叠布局；密度与 overdraw 联合变化，不能称为纯可见量效应。

`cell.layout:"fit-grid"` 是独立无重叠总览：20 列正常世界尺寸卡片，初始视口 `{x:48,y:35.2,zoom:0.32}`，支持同屏完整容纳 200/300 节点；与旧的 dense-overlap 不混算。连线生成器 v2 保证必需 `data:{}`，由真实 public contracts parser 和 Yjs 往返校验。主要带线组使用每节点 1/4 条出边，E=0 仅作控制；保存 accepted 总边数与可见端点计数，端点计数不是贝塞尔曲线精确可见量。

计划项 `inputIntervalMs` 和 `zoomInputIntervalMs` 分别控制普通手势与滚轮节奏，默认沿用 32ms；本轮普通手势 32ms、滚轮 64ms。`cell.visualProbe:true` 额外保存 overview/details/roundtrip 截图，通过真实滚轮往返及命中验证；该类 attempt 超时上限420秒（测试自身360秒）。完整往返若调度超容差，仍保留状态/总耗时诊断，但排除受控帧率比较，不以可读性或状态正确代替性能达标。普通卡片是否有 LOD/是否可读依据实际画面，不强制修改产品表现。

```sh
node scripts/canvas-benchmark/run.mjs artifacts/canvas-benchmark/official artifacts/canvas-benchmark/plan.json
node scripts/canvas-benchmark/report.mjs artifacts/canvas-benchmark/official
```

缺省端口 4398，可用 BENCH_PORT 调整。启动时自动散列实际 served assets（排除 source map），验证唯一 Bevy WASM 被 JS 引用且匹配 performance/release 构建 stamp，保存 build-identity.json；不依赖手工填写 build-id。每项最长 300 秒后终止其自有进程组；不停止用户其它服务。所有 attempt 和执行日志均保留，报告读取 execution.json 补齐启动失败与未产生 run.json 的记录。只有“空场景 nodes=0/visible=0”或 nodes≥2×visible 合法；最大 50k 节点、200k 边。

补充计划项可加 `"supplement":"distance"`（也支持 selection、groups、residency、cache-state），保留 cell 与 round。runner 自动切换补充配置，单项上限 660 秒，以容纳五分钟趋势。cache-state 只使用两个真实模型，以 retained 数量和当前模型 readiness 验证预览缓存保留/淘汰，不推断重型 IR payload 已淘汰。补充产物单独存放，不能直接混入主阶段的帧统计；其原始 run.json 明确记录每个探针的测量边界。直接运行补充配置时必须显式设置 BENCH_SUPPLEMENT，避免全部 skip 的空成功。

## 指标边界

- `renderInterval` / completedFps 是 Bevy RenderSystems::PostCleanup 的调度完成间隔/频率，不是 GPU present 或 GPU 时间。
- browserRafInterval 是浏览器 rAF 调度。inputToObservedApplied 是输入到首次 rAF 观察到匹配 accepted 视口与 applied generation 的上界；合并输入不填零。它只适用于视口交互，不代表拖动像素呈现。
- handlerMs 为一个事件所有被包装 canvas 监听器的同步时间之和；未包含其它 DOM 监听器。
- 定位记录命令处理、目标视口对应调度完成、真实 Rust 点命中与媒体就绪；模型媒体就绪由预览 generation readiness 判断，图片由实际上传纹理标记与加载状态判断。
- 进程 RSS、JS heap、CPU/GPU 资源预算估值分开保存；不能相加作为显存。系统温度不可用时不估算。
- sceneBuildMs/fingerprintMs 在本次被测源码中没有 production timing writer，报告标为 unavailable，原始默认零值不代表零成本。lastSceneJsonCodeUnits 是最新值、modelPrepareMaxMs 是历史高水位，报告展示阶段前后值；其余累计计数的零差分只表示该上报计数无增长，不能直接推断 GPU 无工作。
- 前端 mergeRustWorkDiagnostics 目前未被生产路径调用，其镜像默认零值也标为 unavailable。Rust 的实际工作量从阶段前后 `work` 快照直接计算为 `workDelta.*`；缺失/非单调计数保留原因，stage-wall-elapsed 属于所有 render views 的 CPU 阶段墙钟，不能当 GPU 时间，也不与 TS/WASM 耗时直接相加。
- 逐帧采样显式开启，有 16,384 行上限；溢出/页面隐藏/无帧/操作无效会使阶段无效。正常应用不开该采样。
- p99 少于 1000 个实际样本不纳入正式 p99；比较按独立 run 聚合，不池化全部帧。
- `sampling:"off"` 是 Rust 帧缓冲开销对照，浏览器 rAF/输入观测仍启用；不能代表全部 instrumentation 的零开销。
- `profile:true` 为额外 CPU profile 诊断，不与正式低干扰样本混算。
- 回放按计划与实际送达事件数、迟到 p95 复核；超过 20% 容差时报告标记 replay-invalid，仅保留诊断证据，不声称完成相同输入负载。

产物包含 manifest、GPU/环境、每阶段原始帧/输入/观察、系统采样、定位结果、截图、run.json，以及汇总 HTML/JSON/CSV。源文件由 build-id 与环境清单追溯。媒体首次访问仅表示新宿主/浏览器上下文中首次执行该目标定位；产品可能在初始预热中已预取/准备离屏资源，不能称作 asset-cold。后续回访也不证明缓存仍驻留，不能直接称作 warm-cache。OS 文件缓存不清空，不能称作 OS-cold；确认淘汰的补充探针只按其实际证据声明。

### Portable installed-app scene packages

With Node 24 (development generator only), run:

```sh
pnpm -C web/contracts build
node --experimental-strip-types scripts/canvas-benchmark/scene-package.mjs text /tmp/text.woohaa-scene
node --experimental-strip-types scripts/canvas-benchmark/scene-package.mjs image /tmp/image.woohaa-scene
node --experimental-strip-types scripts/canvas-benchmark/scene-package.mjs model3d /tmp/model3d.woohaa-scene
node --experimental-strip-types --test scripts/canvas-benchmark/scene-package.test.mjs
```

Each version 1 ZIP contains `manifest.json`, `scene.json`, and PNGs under
`media/<sha256>.png`. The fixed recipe creates 3,000 nodes and 12,000 edges.
Image/model recipes place 200 unique resources at origin and 200 at the distant
region; an adjacent row block of 100 text nodes makes the 300-node origin view
complete without overlap. Image resources are 400 distinct 512×512 PNGs;
model resources are distinct box+sphere scripts, using the existing preview policy.

The manifest's `contentHash` is SHA-256 of canonical sorted-key JSON containing
`{manifest,canvas}`, omitting `manifest.contentHash`. It includes media digests,
not ZIP timestamps or the external file name. The host separately hashes the
complete uploaded file. Asset URLs use `scene-media:<assetId>` until import
publishes host-owned media. No credentials, local paths or host settings are
embedded. Packages accept only the versioned built-in text/image/model subset;
this is deliberately not a general arbitrary-canvas export format.

Version 1 media is explicitly restricted to metadata-free noninterlaced RGBA8
PNG (`IHDR`, consecutive `IDAT`, `IEND` chunks), at most 8192 per dimension and
64 MiB of decoded scanlines per image. The decoder verifies every chunk CRC,
zlib completeness, exact decoded length and scanline filter bytes; JPEG and
other PNG variants are unsupported. Declared asset dimensions must match PNG
headers. All allowed JSON fields also have explicit primitive type checks.

Required manifest metadata includes `scene: {sha256,size}` for exact `scene.json`
bytes, `inventory: {nodes,edges,media}`, and
`compatibility: {minAppVersion,capabilities}`. The builder targets app 0.1.6 and
records only used built-in node capabilities. Unsupported app versions or
capabilities are rejected before publication. Use `finalizeScenePackageManifest`
from the archive helper to calculate all derived fields and intrinsic identity.

The package-wide decoded image budget is 512 MiB, counting full RGBA scanlines
including filter bytes. The decoder preflights every PNG's IHDR and sums this
budget before inflating any PNG, then validates each image exactly once and
reuses its dimensions for asset checks. The 400-image 512×512 recipe uses about
400.2 MiB of this budget.
