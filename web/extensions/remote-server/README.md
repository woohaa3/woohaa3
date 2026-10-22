# 服务端接入（remote-server）

用扩展提供「一键接入远端 woohaa-server」：登录、连接状态、断开。不接入时应用完全在本机运行。

## 它做什么

| 面 | 内容 |
| --- | --- |
| 后端 handler | `session`（连接状态读模型）、`probe`（可达性 + 登录方式）、`login`（换远端会话）、`logout`（撤销）、`device-start` / `device-poll`（设备码登录）、`oauth-start` / `oauth-poll`（本机浏览器登录）、`canvas-sync-enable`（把一张本地画布显式启用为同步远端）、`diagnostics`（读宿主诊断缓冲）、`diagnostics-report`（宿主代发上报） |
| 公开路由 | `/api/remote-server/auth/callback` 与 `/auth/done`（GET、公开）：本机浏览器登录的 loopback 回调与完成页；回调在**宿主进程内**换码、落会话，页面脚本拿不到 code/令牌 |
| 设置面板 | 设置 → 插件配置 → 服务端接入：显示状态、测试连接、连接 / 断开（同机默认「使用浏览器登录」，失败可「改用短码」；设备码显示短码与批准页，短码可一键复制）、打开「服务端日志」。已连接时接入状态区给出「服务端模型 N 个」与「刷新模型」，详情页下方「生成的模型」区与其它 Provider 一样列出并可启停 |
| 顶栏徽标 | `canvas.topbar`：本地模式 / 远端已接入 / 远端连接中 / 远端异常 四态，标签都带「远端」作用域词（它描述远端账号链路，画布实时连接以右下角控件面板为准）；**点击直接打开本扩展的设置面板**（`settingsOpen.open({ pluginId })`） |
| 画布同步动作 | `canvas.catalog-item-action`：画布切换器里「仅本机」的条目显示「同步远端」；点击后才把这张画布上传/登记到服务端，之后它就是远端画布 |
| 调试窗口 | 设置面板里的「服务端日志」：连接摘要 + 已脱敏的接入/同步事件，可复制或上报到服务端 |
| 存储后端 | 向 `ctx.storage` 注册 `backendId=server`：媒体字节落在远端，走签名地址读写 |
| 托管生成（已接通） | 向 `ctx.generation` 注册 `providerId=remote-server` 的生成 Provider：登录后从服务端拉模型目录，执行映射到 `woohaa.generation.v1alpha1`；服务端提供 language/image/audio/video 四类模型，未开启或版本不支持时保持休眠 |
| 图像参数家族（Provider 侧） | 服务端只转述 LiteLLM 目录，**不区分厂商参数**；图像模型的家族判定与参数翻译在这里完成（`src/backend/generation/image-models.ts`），与外部 LiteLLM Provider 共用 `@woohaa3/contracts` 的 `imageParameterFamily` / `imageFamilyParameters` / `imageRequestFields`。目录阶段用家族 schema 覆盖服务端的通用 `{"size":"1024x1024"}`（未识别家族保持服务端 schema 不动）；提交阶段把面板语义 `resolution` / `aspectRatio` 翻译成上游字段（即梦/gpt-image 查像素表落 `size`、Gemini 落 `image_size`/`aspect_ratio`），因为服务端会把 `parameters` 原样转发给上游 |

远端调用**全部由本机宿主发出**：远端服务端零 CORS，浏览器不跨源；会话令牌只在本机，
浏览器永远拿不到（边界规则 B1/B3）。

## 服务端接入日志

接入失败时，最终那一句「连不上」不足以定位：是探测、登录、设备码还是同步上游交接出的问题。
宿主把这些过程投影成一份**有界、已脱敏**的诊断缓冲（[host/base/diagnostics.ts](../../backend/src/host/base/diagnostics.ts)），
扩展的 `diagnostics` handler 只读地交给浏览器，「服务端日志」窗口轮询展示。

- **只收白名单**：`remote-server` 扩展自己的事件，以及画布同步上游的 `sync-upstream-*` / `canvas-sync-upstream`；
  其它模块的日志不进缓冲。
- **只投影白名单字段**：时间、级别、模块、稳定事件名、稳定错误码与短说明。令牌、设备码、短码、
  请求体、远端响应正文、完整 URL 都不会出现在条目里；说明文本还会再做一次令牌式脱敏。
- **有界**：宿主缓冲 500 条，窗口一次读取 200 条；读操作本身不写事件，轮询不会把真实事件挤掉。
- 宿主没有诊断能力（旧版本/独立入口）时，窗口显示「宿主不支持诊断缓冲」，而不是一份空列表。

「上报到服务端」由**本机宿主**带会话令牌调用
`woohaa.diagnostics.v1alpha1.ClientDiagnosticsService.ReportDiagnostics`（契约见
[diagnostics.proto](../../../api/proto/woohaa/diagnostics/v1alpha1/diagnostics.proto)），
浏览器只触发、不接触令牌。上报是 best-effort：失败只影响这次排障，不影响编辑与同步。

- **`frontendVersion` 由浏览器带、宿主校验后转发**：条目是宿主记的，但"这是哪一次构建的前端"
  只有浏览器知道（构建期注入值，见 [build-info.ts](../../frontend/src/cordis/services/build-info.ts)）。
  宿主只做形状校验（≤64、`[0-9A-Za-z.+_-]`），非法/缺失归一为空串——它是辅助信息，不因为一个
  字段让整批上报失败。
- **按字节切批**：每批 ≤200 条且请求体 JSON ≤24 KiB（服务端解码上限 32 KiB，留出网关与契约增长
  的余量）。200 条带短说明就有 36–39 KB，只按条数发等于「一上报就被 `resource_exhausted` 拒掉」。
- **幂等键 `entryId`**：每条载荷带宿主在记录那一刻生成、此后不变的 UUID v4（proto `entry_id`）。
  服务端按「主体 + entryId」只落一条，因此重试、扩展重载、连点、多批重发都不会产生重复行。
  `seq` 是宿主进程内的读取游标，不进载荷。
- **`seq` 水位只是优化**：只发 `seq` 大于「本进程已上报的最大序号」的条目，减少无谓请求；多批时
  水位逐批推进。水位在扩展重载/宿主重启后归零，届时会重发一次整窗——那次不重复落库由服务端
  按 `entryId` 兜住，不能把水位当成去重保证。`remote-diagnostics-report-ok` 这条自指事件（上报
  动作本身）不会再被上报，否则每次成功都会给自己制造一条「新条目」，连点两次永远有东西可发；
  上报失败事件仍会上报。
- `acceptedCount` 以服务端返回为准、跨批累加；字段缺失按 **0** 计（proto3 JSON 省略零值，
  「幂等键命中、新增 0 条」时服务端回 `{}`，不能退化成本批条数）。没有新条目时直接返回 0 且不发请求。

**当前边界**：两侧都已接通。服务端在装配时注册 `ClientDiagnosticsService.ReportDiagnostics`，
条目落库到 `client_diagnostics`（有界、限流、保留 7 天，口径见
[公开 RPC 契约](../../../api/README.md)）。**未升级的旧服务端**仍会返回
404，窗口显示「服务端尚未实现诊断上报接口」——那句话现在表示「服务端版本旧」，升级服务端即可。
管理端查看尚未提供：契约目前只有写侧，需要先补一条管理面读 RPC。

## 托管生成（已接通）

服务端托管生成的客户端接入协议冻结在
[generation.proto](../../../api/proto/woohaa/generation/v1alpha1/generation.proto)。服务端已实现 5 个 RPC，
支持 LiteLLM 的 language / image / audio / video 四类模型；**当前客户端不需要更新**就能在模型面板里
看到并使用服务端提供的模型。image/audio/video 需要服务端同时开启托管存储，否则目录里只有 language 模型。
video 在服务端异步执行（创建上游 job 后轮询，`request_timeout` 是整段等待的预算），客户端仍只按
`GetTask` 轮询任务状态；服务端没有上游取消接口，取消只会停止服务端的本地等待。目录不声明参考输入
bindings，且服务端当前 `max_inputs=0`——带 `inputs` 的提交会以稳定码 `unsupported` 失败。

- **休眠是正常态**：扩展激活时只注册一个 `available=false`、空目录的占位 Provider；只有会话可用且
  `GetCapabilities` 的协议版本为 1、features 含 `catalog`，才会 `GetCatalog` 并原地替换模型。
  服务端返回 `unimplemented`、未登录、远端不可达、目录为空或版本不匹配时都不注册模型，连接状态
  也不因此变成错误——「这台服务端没提供生成」不是故障。
- **目录由服务端发现，启停走本机策略**：Provider 不声明 `selectionAuthority`（缺省 `local`），远端模型
  与 LiteLLM 等 Provider 一样受本机「生成模型」运营策略约束——占位注册时全部未启用，在「服务端接入」详情里
  勾选后才进入 catalog 与画布的模型选择器。宿主投影模型视图时带 `extensionId`，设置页据此把远端模型归到
  「服务端接入」卡片（它没有 `providers.<id>` 配置段，按 providerId 归不了组）；卡片与详情里的计数、开关、
  批量与筛选都和普通 Provider 一致。它同时出现在「核心服务 → 生成」的 Provider 市场列表里。
  `catalogRevision` 随目录变化推进，并通过 `GET /api/generation-models` 快照透给浏览器做目录失效。
- **执行复用既有 worker**：`doStart` → `SubmitTask`、`doStatus` → `GetTask`、`doCancel` →
  `CancelTask`；`operation` 只放可 JSON 化的任务身份，重启后继续轮询同一任务，不重新提交。
  `workerTaskKey` 是幂等键。
- **只交稳定引用**：提交带 `canvasId` 与参考输入的 `storageKey`/`assetId`，不把本机签名 URL
  交给服务端；结果只收稳定 `storageKey`，由 Media 的 `verify` 按画布作用域确认后直接采用，
  不二次搬运字节。因此要求画布已经同步到服务端；纯本地画布提交会以稳定码
  `canvas-not-shared` 失败并提示先启用同步。
- **刷新**：`generation-refresh` handler 重新探测并返回模型数量/目录修订，面板上的「刷新模型」就是它的
  入口（数量与目录修订立刻更新）；浏览器本来就在轮询 `GET /api/generation-models`，远端目录变化后
  下方「生成的模型」列表约 10 秒内自己跟上，不需要刷新整页，也不需要客户端发版。

## 配置

部署期配置放扩展目录的 `config.local.json`（0600，已 gitignore）：

```json
{ "serverUrl": "https://woohaa.example.com", "deviceToken": "<部署发放的令牌>" }
```

也可以只配环境变量：

```sh
export WOOHAA3_REMOTE_SERVER_URL=https://woohaa.example.com
export WOOHAA3_REMOTE_SERVER_DEVICE_TOKEN=<部署发放的令牌>
```

未配置 `serverUrl` 时是**本地模式**：不连任何远端，也不报错。

`serverUrl` 也可以是站内路径（`/remote`），用于同源反代把服务端挂在客户端 origin 下的部署。

**配了 `serverUrl` 就等于预置好了地址**：设置面板的地址输入框会直接带着它（值随 `session`
快照的 `serverUrl` 下发），人不需要从头填，点「登录并连接」即可。要换一台就当场改输入框。
面板上会多一行「地址由部署预置」的说明——预置值与用户自己敲的值看起来一样，不说明来源会让
人以为它来路不明、或者以为要先「保存」一次。

**设备令牌为什么不放设置页**：站点扩展拿到的 `config.values()` 不含 `secret` 字段的值
（只有引用），所以密钥必须由扩展自己读自己目录里的文件，避免进入公开配置。
设置页里只会有非秘密项。

## 浏览器登录（同机，OAuth 授权码 + PKCE）

浏览器与本机宿主同机时，登录不再需要短码：

1. 面板调 `oauth-start`（带 `window.location.origin`）；宿主校验 origin 是 loopback，生成 state 与
   PKCE verifier，返回远端 `/tof/authorize?...` 地址；
2. 浏览器完成企业统一登录，服务端 302 回宿主公开回调
   `/api/remote-server/auth/callback?code=&state=`；
3. 宿主先消费 state，再用 `ExchangeLocalLogin`（code + verifier + redirect_uri）换会话、落库并
   刷新画布同步上游，最后 302 到不带码的完成页；
4. 面板轮询 `oauth-poll`，approved 后直接把快照设为已连接。

约束：

- 只适用于浏览器与宿主同机（origin 必须是 `127.0.0.1` / `localhost` / IPv6 loopback）；跨机、SSH、
  宿主不支持公开路由、或 `serverUrl` 是站内相对路径时，面板直接走设备码；
- 授权码一次性、60 秒，绑定 `redirect_uri` 与 PKCE S256；宿主后台完成交换，**页面脚本接触不到
  code、verifier 与会话令牌**（完成页只有常量文案）；
- 设备码保留为兜底：OAuth 失败/超时/回调不可达时，面板给出「改用短码」，行为与之前一致。

## 已知边界（第一期）

- **短码可复制，但不会自动填进批准页**。面板上有一键「复制短码」，省掉手抄；批准页地址里
  仍然**不带**短码。这是有意的安全取舍，不是没做：短码一旦进 URL，人会直接点开链接、跳过
  「页面上这次请求是不是我刚发起的那一次」的核对，而那正是挡住下面这条攻击的唯一防线——
  攻击者拿受害者的短码在自己的浏览器里按批准，受害者的客户端就会登进**攻击者**的账号。
  实现与理由见 change `2026-10-19-add-remote-server-device-login` 的 design D2。
- 身份、连接状态、画布同步、托管存储与托管生成均已接通。托管生成按服务端目录注册 language/image/audio/video
  模型；服务端未开启、版本旧或没有可执行模型时不注册任何远端模型，页面上也不假装远端已经有这些能力。
  媒体结果只收稳定 `storage_key`（`MediaOutput`），由 Media `verify` 按画布作用域确认后直接采用，不二次搬运字节。
- **同步是按画布的显式操作，不是登录的默认后果**。本扩展注册 `canvas-upstream:remote-server`
  capability，宿主按声明**逐画布**解析（`resolve(canvasId)`）：
  - 画布已在远端目录里 → 返回该会话的链路；
  - 画布只在本地、用户还没启用同步 → 返回 `null`，画布保持纯本地（静态 `canvas.syncUpstream.*`
    仍作为回落，行为与改动前一致）；
  - 未登录 / 会话过期 / 扩展故障 → 返回 `null`，同样回落静态配置，不会因为「没接远端」而失去同步。

  显式入口在**画布切换器的本地画布条目**上（`canvas.catalog-item-action` slot 的「同步远端」）：
  点击后前端调用 `canvas-sync-enable` handler，把该画布记入待同步集合并让宿主重新解析；
  宿主随后为这张画布建立中继连接，首次推送以 `create_if_missing` 完成远端登记。此后它出现在
  远端目录里，就是普通远端画布——重新连接时自动同步，不再依赖这条启用记录。
  宿主不轮询扩展会话，所以登录 / 登出 / 401 作废 / `ensure()` 换会话仍由扩展经
  `host.services.canvas.refreshSyncUpstream()` 推送重解析（宿主重启后另由 `host/ready` 再解析一次）；
  宿主没提供该能力时静默降级，不影响登录本身。
- 同源挂载路径（`/remote`）目前只对 Connect 调用生效；`ws` 客户端需要绝对地址，那种部署下
  同步上游仍需配置绝对 `ws(s)` 地址。
- 不做多账号、不做远端主体与本机 owner 的映射。

## 验证

```sh
pnpm -C web/extensions/remote-server run typecheck
pnpm -C web/extensions/remote-server exec vitest run
pnpm -C web/extensions/remote-server run build:browser
```

## 可选的部署登录适配

公开客户端不识别特定企业网关，也不默认转发浏览器请求头。浏览器授权码和设备码登录不需要网关适配。受信部署代码可通过 `createRemoteServerExtension({ loginAssertionHeaders: [...] })` 显式提供断言头白名单；普通配置 API 与浏览器请求不能修改它。Cookie、Authorization 和传输控制头始终不会随断言转发。
