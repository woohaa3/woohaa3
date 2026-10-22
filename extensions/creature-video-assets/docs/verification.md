# 验证记录

## 合入 master 后真实接口复测（2026-10-22）

当前分支 `feat/creature-asset-workflow` 已 rebase 到 `origin/master` 的 `b52af900`，HEAD 为 `82de0e45`。原有未提交内容已恢复，额外保留 `codex-pre-master-rebase-20261022` stash 备份；未推送改写后的分支。

临时画布为 `canvas-creature-real-1792604331985`，主节点 `creature-real-e2e`。真实鼠标将临时图片拖入首步参考容器后，引用写入且来源位置恢复；文本产物双击打开 Markdown 弹窗。最新浏览器截图的 Bevy 区域仍为黑色，DOM 面板和命中交互可用，因此不宣称产物卡片、连线或 GPU 画面验收通过。本机检测到 Intel UHD 770 和 RTX 4060；这不是无 GPU 环境，也未使用软件渲染替代。

真实调用中修复的衔接问题：

- Media import 插件补齐 `canvasScope` 注入，避免真实文件导入时缺依赖。
- LiteLLM `/v1/models` 不提供视觉能力字段，`/model/info` 和 `/model_group/info` 返回 403。LiteLLM 语言模型统一走文本/图片消息入口，`modelType: language` 表示文本输出，不再用 `visionModels` 白名单限制图片输入；真实图片请求确认 `gpt-6.1-sol` 能读取参考内容。
- 生图参数适配 master 的家族契约：`aspectRatio/resolution/quality`，恢复源配置 4K 意图。身份板实际返回 2880 × 2880，checksum 校验通过且无画幅警告；1681 × 936 的历史宽图仍允许带警告验收。
- LLM 的完整 schema 放入 `system`，前序结构化结果不再与文本产物重复拼接，避免第四步超过普通 prompt 的 8000 字限制。补充动作图分段语义，格式校验失败返回具体原因。
- Ark 目录补齐实际支持的首尾帧 role；扩展改用 `durationSeconds/ratio/resolution/generateAudio`，单首帧同样使用首尾帧模式。
- 首轮方向图被模型误画成动作表，虽然接口和媒体检查通过，但抽取视频首末帧后判为内容不合格。补充单主体、单视角及禁止拼图/文字/动作序列的制图指令，再重做方向图和下游视频；不把首轮自动推进视为视觉合格。

本次真实接口已完成前六步：设计说明、身份板、方向计划、动作设计、方向站定图、RGB 视频（pilot 与 batch）。仅选择 `6_00` 一个方向和 idle/death 两个动作，减少验收变量；两个视频使用 `ark:doubao-seedance-2-5-260628`，文本使用 `litellm:gpt-6.1-sol`，图片使用 `litellm:gpt-image-2.5-sunburst`。批量阶段复用了 pilot 的两项任务身份，没有新增远端生成；多方向新增批量调用由原生两方向 fixture 覆盖，不算真实远端多方向验证。

重做后两段视频均为 960 × 960、24 FPS、24 帧、无音轨。直接抽取首末帧确认画面为单只生物，不再是动作表；但 death 末帧仍为站立/轻微下沉，未达到动作合同要求的倒地静止，因此只记录接口和媒体结构通过，**动作内容验收未通过**。该测试动作要求 1 秒内完成，模型最短请求 5 秒，当前 `trim` 按合同截取前 24 帧；不能将截取结果、自动批准或 checksum 通过视为动作语义合格。后续需重新生成合格候选，或在人工确认后调整动作时长/时间线；不擅自把 `trim` 改成整体压缩而改变已批准动作合同。

重做 idle checksum 为 `b2e22d68b6729a487f77a9c05d82db249416da7f44c582550c464a94bac8cecb`，death 为 `260bf42c6bbdfdc199f7a9e8b9c9bc0f5a65d1b1cd30d47438e35d41c529a36b`。状态恢复通过已有 operation 继续核对，没有重新购买未知状态的任务。最终构建后重启本 worktree 的 5320/5321 服务，加载最新制图/视频提示词和 Ark role 声明。

原生八步回归 30/30 通过（真实 FFmpeg、sharp、Node worker、Python、toktx；Task/GPU 响应受控），LiteLLM 39/39、Ark 36/36 通过，相关三个扩展类型检查与构建通过。rebase 后的 contracts、Media、Application、Backend、frontend 类型及 units/browser 构建通过；Media 7 项、local 12 项、COS 20 项通过。boundary 6/6，extensions strict 为 0 错误/0 告警，codemap 为 49 个 manifest、11 篇地图。片场完整测试初次 423 通过/3 失败，重建 contracts 后相关 45 项中 43 通过/2 失败：两个旧创建弹窗用例仍使用旧选择器/会话服务 fixture；不将片场全套标为通过。

GPU 服务 `http://9.135.14.44:8800/health` 返回 200，未带凭据的 `/v1/tasks` 返回 401。环境变量、宿主隔离秘密仓库和已检查源项目 token 文件均未配置，实际第七步在提交前停为 blocked，第八步尚未执行；没有用假 Token 或 mock 冒充真实付费整链路。原生全八步回归不能替代 SAM3、VideoMaMa、Cosmos 的真实验收。

本机证据在 `.local/creature-paid-e2e/`：各步骤/门的 run 快照、模型与提示词、真实产物、首末帧、`summary.json` 与浏览器截图。会话和配置文件含本机凭据，不纳入 Git。费用未取得账单明细，不估算为实付费用。

## 内置生产链路（2026-10-22）

### 身份板画幅修正

真实任务 `litellm:gpt-image-2.5-sunburst` 曾返回 1681 × 936；源 stage02 对画幅偏差采用 `pass_with_warnings`，此前移植成硬失败有误，现已恢复为记录实际尺寸/警告，内容 checksum 错误仍阻断。此前版本使用的像素参数适配已被本次 rebase 后的家族契约适配替代，最新实际制图结果见上节。

新增两项回归覆盖真实返回尺寸、待验收结果和实际 Task 提交参数。对这次已成功生成的图片重新读取并校验 checksum，通过 owner-scoped 文档 CAS 从失败恢复到待验收，保留原 stage revision/任务身份，未提交生成请求，也未替用户验收；修改前文档备份在本机 `.local/identity-aspect-before-*.json`。

已实现第 4–6 步直接走宿主 Task，第 7–8 步的 GPU 客户端、内部 Node worker、FFmpeg、Python cooker、完整六层通道包和独立 Relight 预览。最终批准通过同一份文档 CAS 更新 current/previous 发布指针，支持回滚。验收只保留文字提示，用户点下一步即通过。

本轮验证：

- 扩展单元/协议/控制器覆盖 Task 所选模型、unknown 不重复 POST、GPU remoteRef 恢复、取消保留远端身份、发布 CAS/回滚、像素 straight alpha、AlphaHint 数序、分段边界、ZIP 穿越和预览路由鉴权。
- 原生八步 fixture 使用两个方向、两个动作，pilot 后 batch 只新增另一个方向的两个视频任务；真实运行 FFmpeg 9.0.2、sharp、内部 Node worker、Python 3.12.9/Pillow 11.3.0/numpy 2.2.6、toktx 4.4.2。检查完整通道包、导出 viewer 和最终发布；另测生产帧包的流式解压与穿越拒绝。Task/GPU 响应受控，**不是付费服务整链路**。
- Media 5 项：17 MiB 流式 roundtrip、稳定 hash/类型冲突、超限/中断/取消、相同内容并发类型保护，以及真实 HTTP 二进制往返和服务身份 scope 拒绝。小资源读取在物化大文件前拒绝。local-storage 11 项与 COS 19 项测试通过；新增中断/取消覆盖。COS 使用注入 SDK fixture，未连接真实 COS。
- contracts、Media、Application、Backend、local/COS、扩展类型检查；扩展构建、浏览器 artifact；boundary/codemap/extensions 门禁。具体最后执行结果见 change tasks 的收尾记录。
- Windows x64 执行 `pnpm deploy --prod --legacy`，独立目录内成功 import 扩展后端、加载 sharp、执行真实单帧 Node worker；在目标目录重新建立 Python venv、导入 toktx 后 doctor 通过。依赖位于目标目录内。pnpm 产生既有前端工具 tsc/vite/msw bin 链接告警；本次 runtime smoke 未依赖这些开发命令。未完成独立发行目录中的全部八步或 Apple Silicon 部署验证。
- 重建相关宿主包并重新 assemble 扩展后，重启本 worktree 的 5320/5321 开发服务；前端 HTTP 200，Application snapshot 中 `creature-video-assets.actualState=active`。这是启动 smoke，不是原画布付费工作流验收。

真实 GPU 探测：Intel UHD 770、NVIDIA RTX 4060 均为 OK。较早一次浏览器运行使用 Intel D3D11，完成 Original/normal/roughness/depth/Relight、动作切换、Stop 和离线 ZIP 重开，仅出现 favicon 404；其后已加 data favicon。最新版复测中 Chrome 与 Edge 无法建立可用 WebGL 上下文，shader validation 失败且 renderer 为 null，因此**不将最新版硬件画面验收标为通过**。没有使用软件渲染替代。证据位于本机 `.local/creature-native/`，画面为受控纯色 fixture，不能表示真实生物效果。

真实付费八步未执行：当前本机宿主环境和已检查的源项目凭据位置没有 GPU 服务 Token（`WOOHAA_CREATURE_GPU_TOKEN` / SAM3、VideoMaMa、Cosmos 凭据）。已有加密秘密和环境变量配置入口；未复制或虚构凭据。真实模型质量、远端断线恢复提交次数、最新版 GPU 视觉及 macOS 发行仍待验证。

已知限制：没有 remoteRef 的未知受理须操作人员核对，不能自动按 request ID 找回；新 revision 不会自动复用上一失败批次中的成功项；工作区全部中间文件的磁盘配额未统一限制；COS 测试未覆盖真实 SDK 网络取消；depth 尚不宣称物理世界尺度标定。取消/回滚有后端入口，未新增专用面板按钮。

## 历史画布接入验证（2026-10-21）

以下保留早期画布交互证据及当时的未交付范围；其中“外部 worker 尚未实现”“相机待配置”“没有正式发布”等状态已由本轮实现替代，不表示当前状态。

## 首步参考容器修正

此前首步参考输入实际是普通图片卡，不能提供真正的容器拖入反馈；原验证不足以证明容器结构正确。本轮改为 composite 引用容器，保留稳定引用及缩略图，普通图片输入卡升级时保留位置并重建依赖线。容器附属节点不会启动新的工作流。

真实鼠标验证空容器 → 拖入接收态 → 已引用缩略图，断言拖动期间只有参考容器有接收提示、制作主体无提示，来源图片回位，底部引用数更新。另断言 canonical 与真实 GPU 场景都含容器到输出的依赖线；电脑与 Pad、第四步切换正常。截图与日志说明位于本地 `.impeccable/review/creature/reference-fix/`，采用下述同一 GPU 帧采集方式。付费制作未执行。

本轮相关测试共 191 项通过：扩展 18、contracts 152（含加载/序列化往返、场景映射、reducer）、宿主拖入 21。扩展、contracts 与 frontend 类型检查通过；扩展及 contracts 构建、扩展浏览器产物构建通过；extensions/codemap/boundary 门禁通过。独立复核针对上述新证据给出 `ship`，报告为本地 `reference-fix/review.md`；不将旧验证结论用作本轮通过依据。

## 2026-10-22：逐产物并行调度

- 扩展类型检查、43 项常规回归通过；验证独立任务在首个结果返回前全部提交、依赖完成立即启动后继、失败只阻塞后代、未知提交等待在途分支结束、并行 checkpoint 不产生 CAS 冲突。
- 验证单产物执行保留其他成功项与错误，执行全部仅补齐缺项；刷新后的排队、生成、等待依赖和本机处理分别投影，不再读取整步 running 伪装所有卡片都在生成。
- 显式启用 `WOOHAA_CREATURE_NATIVE_TEST=1` 后，两项本机集成测试通过：安全流式解包，以及完整八步、RGB pilot/batch、抠像、G-buffer、候选发布和离线包。FFmpeg/sharp/Node worker/Python/cooker 实际执行，Task/GPU 使用受控响应；这是本机流水线回归，不是付费服务端到端成功证明。
- shared/frontend/backend、独立浏览器 artifact 与 release 装配通过；`extensions:check` 零错误零告警，`codemap:check` 通过，UI detector 无发现。
- 真实应用当前 RGB 步骤在 1440×1000 与 1024×768 验证：产物执行按钮为“执行”，选中产物不重叠显示工作流验收面板，执行面板距底部 20px，没有页面脚本异常。记录为本地 `.local/creature-parallel-ui.json`；已探测 Windows Intel UHD 770 / RTX 4060，Chrome 使用 D3D11，未使用软件渲染。
- 本轮没有重新提交付费模型任务；现有真实内容安全拒绝记录仍保留，调度改造不会消除服务商对提示词的拒绝。

## 初始接入时已通过

- 扩展、contracts、frontend 类型检查。
- 扩展 18 项测试：八步与批准门、stale、未知任务恢复、CAS、受控入口、worker 媒体证据、逐步投影与控制器。
- contracts 引用/reducer 44 项、frontend model-scene 16 项回归，共 78 项相关测试。
- 扩展 shared/frontend/backend 构建及独立浏览器 artifact 构建。
- `pnpm extensions:check`：0 错误、0 告警；`pnpm boundary:check`、`pnpm codemap:check`。
- 扩展纯粹性 4 项及服务依赖边界 10 项；额外对本包使用仓库 AST 检查器核对职责、环境、循环和浏览器/shared 闭包，结果为空。

## 真实应用交互

在 Windows 的真实 GPU 环境（Intel UHD 770 / RTX 4060；浏览器实际使用 Intel D3D11）验证 1440×1000 电脑与 1024×768 Pad：

- 已保存图片经原上传入口导入，再由鼠标拖入首步参考容器；原图片回位且保留，底部引用计数更新。
- 收起并展开面板后需求草稿仍在；未出现普通生成面板重叠。
- 调试切换第四步待验收：仅当步依赖和输出，普通卡片及原 Bevy 贝塞尔线；不会提交付费任务。
- 使用共享 Button/TextArea/SelectInput；共享下拉浮层能切换步骤和状态。Pad 面板正文可滚动，中心按钮位于面板上方。
- 页面无未捕获脚本异常。观察到既有 favicon 404、Windows powerPreference 提示，以及性能遥测上传 HTTP 400；未把遥测作为本次性能验收数据。

截图在本地 `.impeccable/review/creature/`：`desktop.png`、`desktop-step4.png`、`pad.png`。Windows 整页截图无法捕获 WebGPU 图层；采集直接读取真实 renderer canvas 的 GPU 帧，在原 iframe 矩形暂放原帧与 DOM 合成截图，随后恢复。每张另保留原始 `*-gpu.png` 和场景 JSON，没有软件渲染或重画画布。绿色图片为上传/拖放测试素材，调试产物明确标记交互示意。

独立 Impeccable reviewer 对画布 UI 与既定集成范围给出 `ship`；不是生产工具链或正式发布验收。设计文档核验保留根视觉系统。

## 未通过的仓库检查

前端 TypeScript 和 Vite 产物构建成功，但 build 最后的宿主入口 gzip 预算失败：448,614 字节，预算 448,000。使用 Vite load hook 将本次所有宿主运行时代码覆盖为 HEAD 版本做只读基线构建，结果为 448,590 字节；本次增量 24 字节，基线已超 590 字节。未抬预算、未改启动闭包统计或无关模块。原始入口 raw 为 1,478,793，低于 1,490,000 预算，其余 JS/SDK/启动扩展/WASM 预算通过。

额外运行依赖边界测试时，Vitest 的文件名匹配同时选中既有 `showcase-dependency-boundary.test.ts`。其中一项在 Windows 用反斜杠 `path.relative` 结果与正斜杠前缀比较，把 `frontend\\src\\shared\\ui` 的 11 个合法 vendor import 误报为越界。该检查源码及报出的文件本轮均未修改；未扩大本次改动修复此问题。

## 尚未验证/交付的能力

未运行付费模型、方向图制作、RGB 生产、SAM3/VideoMaMa、G-buffer 或正式生产发布。前四步已接宿主 Task/Media，但真实模型效果仍需使用者选择模型后制作验收；第 2 步需要真实项目相机配置。第 5–8 步只有制作 worker 调用/恢复与验收协议，当前没有随包生产 worker。末步仅记录运行候选批准，尚无正式发布动作。

本次不包含整组移动、跨画布复制依赖、离线归档、跨设备草稿同步、手机或无障碍专项。
