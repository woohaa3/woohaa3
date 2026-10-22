# 内置生产执行与旧 worker 协议

当前默认执行器已内置于扩展：第 4–6 步直接走宿主 Task，第 7–8 步走 `production/providers/gpu.ts` 和阶段编排。独立编译的 `dist/creature-media-worker.js` 只按隔离 workspace 中的请求文件执行像素处理；Python cooker 负责完整通道发布。它们不读取源项目 RunStore，不承担远端生成提交，也不使用下面的旧 stdout 协议。工具安装与凭据见 [README](../README.md)。

以下 `creature-production.v1` 仅用于历史 `production-*` 在途操作恢复。新任务不需要配置 `productionWorker`；旧任务若需核对，保留原可执行文件配置，不能用普通 `creature-video` CLI 替代。该历史协议不是新的生产工具实现说明。

扩展通过管理员配置的绝对路径启动进程，`shell:false`、隐藏 Windows helper 窗口。stdin 是一份 JSON；stdout 只能是一份 JSON（最多 2 MB），进度写 stderr。45 分钟未返回、连接中断、非法响应或进程非零退出都视作提交结果未知。工具须持久化自己的子任务和结果；重新启动时 `mode: reconcile` 只能查询原任务，不得再次 POST。

请求含 `protocol`、`mode`（execute / reconcile）、稳定 `operationKey`、`identity`（canvasId / nodeId / instanceId）、`stageId`、`revision`、`gate`、已冻结 `input`、`productionProfile`、`upstream`、`pilot`、`requiredChecks`。`upstream` 为批准版本、结构化结果与稳定产物引用。RGB batch 请求附 pilot 批准和试片产物。媒体引用是宿主 storageKey，工具需要单独配置受控读入/摄入能力；扩展不会向进程传递宿主凭据。

响应必须完整匹配操作身份：

```json
{
  "protocol": "creature-production.v1",
  "operationKey": "与请求相同",
  "stageId": "05_direction_stills",
  "revision": 1,
  "gate": "stage-output",
  "status": "complete",
  "artifacts": [],
  "structured": {},
  "checks": []
}
```

`status` 还可以是 `unknown` 或 `blocked`，可附供用户处理的 `message`。不能伪造 complete。每个 artifact 有唯一 `id`、`title`、`kind`（text / image / video / web）；媒体必须含宿主已经摄入的 `storageKey`、真实 `checksum`、`size`、`contentType`。文字用 `text`，网页另含 `previewUrl`（http/https）。可附 `directionId`、`actionId`。扩展会调用 Media.verify 核对真实元数据；只给外部下载 URL 不会通过。

每个 check 为 `{id, passed, evidenceIds}`，必须引用本次已核验的 artifact；完整检查项由请求的 requiredChecks 给出，定义在 `production-bridge.ts`。缺任意项、证据引用或本步实际媒体，不能进入验收。通过工具检查后还会调用独立监督语言模型查看产物；面板展示用户验收要点，用户点击「下一步」即批准，无须逐项勾选。

制作工具应实现：

1. 方向图：读取身份板与相机，每母方向一个候选，镜像只本地派生；提供完整方向映射、身份、尺度、脚底线、留白证据。
2. RGB：只制作当前 gate 的范围；试片批准后才批量。动作次序、共享起手图和首末帧依据 actionGraph 的 clipGeneration；衔接帧必须来自实际 RGB，禁止恢复废弃的独立锚点阶段。保留远程原件，输出 24 FPS 无音轨成片与循环、硬切、事件帧、Stop/Exit 证据。
3. 透明底：SAM3 包络交给 VideoMaMaAlphaHint，保留原 RGB、straight alpha；尺寸、帧数、FPS、PTS 完全对应，提供深浅底和棋盘格证据。
4. 通道候选：委托既有 G-buffer/RelightWorkbench 生产并验收 Original、Surface、Material；Body、Surface、Material、Mask、阴影同源同帧原子切换；提供 Stop/Exit、加载失败回退及回滚证据。只输出可验收候选，不能在用户批准前正式发布。

当前批准入口只记录候选验收，没有正式发布调用。后续若增加发布，应使用独立的已批准身份、稳定操作账本及对账动作，不得在预览或查询中发布。
