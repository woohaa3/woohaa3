# 生物资产制作

原画布中的八步制作扩展：第一步把图片节点拖入左上参考容器，原图复位；后续自动使用已批准产物。左侧为前序产物，右侧为本轮结果，主体中央执行/下一步，输入与验收提示在底部中央面板。普通卡片及贝塞尔连线复用画布实现。

| 显示步骤 | 源 stageId | 执行方式 |
| --- | --- | --- |
| 1 需求与生物设计 | `01_brief` | 宿主 Task 语言模型、源 schema 校验 |
| 2 三视图身份板 | `02_identity_board` | 宿主 Task 图片模型、内置相机与身份板配置 |
| 3 方向规划 | `03_direction_plan` | 源纯函数生成母方向和镜像映射 |
| 4 动作设计 | `04_action_design` | 宿主 Task 语言模型、ActionGraph/MotionContract/clipGeneration |
| 5 母方向站定图 | `05_direction_stills` | 宿主 Task 图片模型，扩展生成镜像与 contact sheet |
| 6 RGB 动作视频 | `07_rgb_videos` | 宿主 Task 视频模型；先试片再批量；真实首末帧衔接 |
| 7 透明底处理 | `08_matting` | 专用 GPU 服务 SAM3 → VideoMaMa AlphaHint；内部 worker 合成原 RGB + straight alpha |
| 8 通道与发布 | `09_publish` | 专用 GPU 服务 Cosmos；Python cooker、KTX2、Relight 预览与 ZIP |

第 4–6 步直接调用现有 Task，不经过生成 CLI 或第二层任务服务。第 7–8 步的编排、媒体处理与生产工具均属于本扩展；原 `creature-production.v1` 外部 worker 仅保留旧在途任务恢复入口。

制作完成后展示验收提示，点击「下一步」即验收通过；无逐项勾选或 LLM 否决。文件、schema、帧数等结构错误仍会阻止推进。RGB 试片通过后执行批量，复用试片任务；改变输入须重新制作。最终确认通过文档 CAS 切换已发布候选；旧发布保留，可通过 `rollback` 入口切回。

## 配置与工具

制作模型来自宿主 Provider，实际提交使用面板选择的模型。项目相机与身份板 `1:1 / 4K / high / PNG` 配置已内置，第二步冻结到 run。非秘密配置见 [config.example.json](config.example.json)。

制作配置表达源项目意图，提交参数须适配所选模型。当前宿主 LiteLLM 图片接口接受 `size/quality/outputFormat`，其声明的正方形尺寸为 `1024x1024`，因此该路径不会把 `4K` 当作有效像素尺寸直接传入。身份板实际尺寸会记录；画幅偏差沿用源 skill 的警告规则，由用户看图验收，不阻止下一步。

GPU 服务默认 `http://9.135.14.44:8800`，使用其 `/v1/assets`、`/v1/tasks` 协议。Token 优先读取宿主扩展加密秘密 `owner=system, purpose=gpu`，也可在本机宿主环境设置 `WOOHAA_CREATURE_GPU_TOKEN`。有 `extensions.configure` 权限的管理员可调用 `gpu-credentials` handler 写入 `{token, expectedVersion}`；Token 不写入画布或发送浏览器。

需要 Node 22+、FFmpeg/ffprobe 6+、Python 3.11+、Pillow 11.3.0、numpy 2.2.6、toktx 4.4.2。工具版本、来源和许可见 [tools/manifest.json](tools/manifest.json)。在仓库根运行：

```powershell
pnpm -C web --filter @woohaa3/extension-creature-video-assets run build
pnpm -C web --filter @woohaa3/extension-creature-video-assets run tools:bootstrap
pnpm -C web --filter @woohaa3/extension-creature-video-assets run tools:doctor
```

bootstrap 使用 uv 建立扩展自己的 Python 环境；可通过 `--ktx-root <目录>`、`--ffmpeg <文件>`、`--ffprobe <文件>` 导入已有独立工具。不会自动安装系统级二进制。运行时依次读取 `WOOHAA_CREATURE_<工具名>` 环境变量、`tools/.venv` / `tools/.runtime`、PATH。安装目录属于本机运行资源，发行部署后须重新准备并运行 doctor；不能将带本机绝对路径的 venv 当作跨平台发行物。doctor 不提交付费任务。

## 目录与恢复

- `state/`：版本、依赖、pilot/batch、发布指针与扩展文档 CAS。
- `src/authoring/backend/production/`：内置阶段编排、GPU 协议、临时 workspace、流式 Media、媒体工具。
- `src/worker/`：独立编译的 Node 像素处理 worker，无 Provider 凭据。
- `python/`：生物专用 cooker 和流式帧包解压，完整 Body/Surface/Material/Mask/Shadow/baseColor。
- `src/preview/`：画布卡片投影、鉴权资源路由及独立 Three.js Relight viewer。
- `tools/`：构建、依赖、bootstrap/doctor；不包含其它 skill 的业务 CLI。

媒体以稳定 checksum/storageKey checkpoint 保存；本机临时目录不进入持久记录。GPU 已有 remoteRef 的任务恢复时只轮询原任务；受理响应丢失且没有 remoteRef 时标记待核对，禁止自动重发，目前须操作人员从服务端查证，尚无按 request ID 自动找回能力。批次失败后重新执行会创建新候选，尚无跨新 revision 的失败项单独重试。

宿主仅增加通用可选流式 Media/Storage 能力：单对象最多 2 GiB、并发 spool 最多两个；无流式后端明确拒绝大对象。生产帧包按文件流式解压，单成员 64 MiB、累计展开 20 GiB。输入物化累计限制 20 GiB；工作区全部中间文件的磁盘配额尚未统一限制。

运行 `test`、`typecheck`、`build`、`build:browser` 及根目录 extensions/boundary/codemap 检查。原生八步 fixture 需设置 `WOOHAA_CREATURE_NATIVE_TEST=1` 后运行 `tests/pipeline.native.test.ts`；它运行真实本机工具，但 Task/GPU 响应受控，不能代表付费服务整链路。最新结果和限制见 [验证记录](docs/verification.md)，来源见 [SOURCE.md](SOURCE.md)。
