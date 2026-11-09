# sdpppx-provider 扩展

SDPPPX 接入：宿主侧完成微信扫码登录与 Supabase 会话，登录后把当前租户的模板投影为生成模型，并承接参考素材上传、异步任务与结果回填。扩展默认启用，不需要修改宿主代码。

## 组成

| 位置 | 职责 |
| --- | --- |
| `src/backend/authing-qr.ts` | Authing 二维码 `gene` / `check` / `userinfo` |
| `src/backend/app-id.ts` | Authing appId：显式配置优先，否则查租户表 |
| `src/backend/bridge.ts` | `authing-bridge3` 交换会话与 `refresh_token` 续期 |
| `src/backend/session.ts` | owner-scoped 文档 `session/current`、到期判定与登出 |
| `src/backend/login-flow.ts` | 扫码状态机、pending TTL、至多一次授权、取消幂等 |
| `src/backend/catalog.ts` | 租户模板目录 → Provider 模型 |
| `src/backend/schema.ts` | Formily 表单 → woohaa3 输入 schema |
| `src/backend/provider.ts` | `@sdppp/pptask` 任务提交、轮询、取消与结果映射 |
| `src/backend/reference.ts` | 参考素材上传与宿主侧允许名单 |
| `src/frontend/` | 登录弹窗、账号管理、AI 助手供应商登录入口与设置面板 |

**浏览器永远不接触令牌。** `/session`、扫码状态与设置面板只返回状态、昵称、头像、余额、到期时间；Authing token 与 Supabase access/refresh token 只存在宿主文档里，不进入响应、日志或诊断。二维码图片由宿主取回后转成 `data:image/png;base64,...` 下发。

## 部署身份与运行参数

租户、Supabase URL 与 Supabase anon key 是这个扩展的**部署身份**，编译在 [`src/backend/deployment-config.ts`](src/backend/deployment-config.ts)，不通过环境变量注入。换租户或换部署环境时改这个文件并重新构建扩展；环境变量里的同名值不会覆盖它。anon key 是 Supabase 公开客户端密钥，可以随扩展发布；`service_role` key、Authing token 和用户令牌不允许写进这个文件。

其余可调参数仍读 `SDPPPX_*`，插件启动时读取一次，设置面板只读展示解析结果；修改后需重启宿主。

| 变量 | 必需 | 默认 | 用途 |
| --- | --- | --- | --- |
| `SDPPPX_BASE_URL` | 否 | `https://sdpppx.zombee.tech/ppserver` | 任务与余额服务基址 |
| `SDPPPX_AUTHING_APP_ID` | 否 | 自动查询 | 租户 Authing appId；显式配置时跳过租户表查询 |
| `SDPPPX_AUTHING_HOST` | 否 | `https://core.authing.cn` | Authing API 基址；显式配置优先于租户表的 `authing_url` |
| `SDPPPX_AUTHING_SCENE` | 否 | `WXAPP_AUTH` | 微信扫码场景 |
| `SDPPPX_BRIDGE_URL` | 否 | `${部署身份的 supabaseUrl}/functions/v1/authing-bridge3` | 会话交换地址 |
| `SDPPPX_TEMPLATE_MODEL_TYPES` | 否 | `{}` | 模板 → `image` / `video` 的 JSON 映射；未列出默认 `image` |
| `SDPPPX_PROMPT_FIELD` | 否 | `prompt` | 模板表单里的提示词字段名 |
| `SDPPPX_UPLOAD_PROVIDER` | 否 | `grsai` | `describe` 未给可用的 `recommendUploadProvider` 时的上传通道；服务端当前只接受 `grsai` |
| `SDPPPX_TASK_TIMEOUT_MS` | 否 | `600000` | 单任务超时；模型级 `taskTimeoutMs` 可覆盖 |

`SDPPPX_TEMPLATE_MODEL_TYPES` 只接受 `{ "<templateId>": "image" | "video" }`。单条非法值会被丢弃并记一条诊断；整体 JSON 非法时回落到空映射（全部按图片），不让一条坏配置阻止插件装载。

### 缺失与降级

- 内置部署身份被改空（正常构建不会）→ `health()` 返回 `degraded` + `sdpppx-config-incomplete`；登录入口可见但禁用，并列出缺失字段；不发任何网络请求。
- appId 既没配也查不到 → `degraded` + `sdpppx-authing-app-missing`。
- 租户未开通微信身份源 → `gene` 错误映射为 `sdpppx-wechat-unavailable`，不重试风暴。
- 目录刷新失败保留上一次成功目录，只更新诊断；`/models/refresh` 可手动重试。
- 参考素材上传失败拒绝提交，保留输入；任务 401 清会话并提示重新扫码，不自动重试。
- 登录 `start` 返回 502 / `sdpppx-service-unavailable`：先看宿主日志的事件名——`sdpppx-authing-target-failed` 表示租户/appId 查询失败（检查 `src/backend/deployment-config.ts` 的 `tenantId`、`supabaseUrl`、`supabaseAnonKey` 是否指向可达部署），`sdpppx-qrcode-gene-failed` 表示 Authing 调用失败；两者都不会透出上游正文。
- `sdpppx-qrcode-gene-failed` + `sdpppx-wechat-unavailable`：Authing 应用未开通微信身份源，或 appId/租户域名不匹配。

## 账号与会话

- bridge 按 Authing `sub` 找 Supabase 用户；**跨登录方式的账号绑定发生在 Authing**：同一个人的密码身份与微信身份必须是同一个 `sub`。
- 会话存 `ctx.services.documents` 的 owner-scoped 文档 `session/current`，跨重启保留。
- 到期前 30 秒用 `refresh_token` 续期；并发请求合并为一次刷新。刷新被明确拒绝时清会话；网络失败保留到 `expiresAt`。
- 登出清会话、目录与余额缓存，并递增 `epoch`；登出后迟到的扫码/刷新结果被丢弃。
- 应用启动**不弹登录**。登录入口在 AI 助手的供应商列表（「sdpppx」）；只有用户点选供应商、确认未登录后才打开微信扫码弹窗。
- 关闭、切换页面或点击「稍后」都会取消进行中的扫码，不留下无人轮询的 pending；入口保留，可随时再次打开。

## 模板与任务

- 目录来源：Supabase REST `biz_tasks.tasks_template`，按部署配置里的 `tenantId`、`is_active = true` 过滤，`updated_at` 倒序；`providerModelId` 就是模板 `id`。
- 模板本身没有输出类型字段；视频模板必须写进 `SDPPPX_TEMPLATE_MODEL_TYPES`，否则按图片处理，结果阶段会失败。
- 请求路径：`POST /tasks/create_stream`（SSE；当前服务端没有 `/tasks/create`，读到首个 `created` 的 `job_id` 后后台继续消费事件）、`POST /tasks/status`、`POST /tasks/result`、`POST /tasks/cancel`；describe 为 `GET /tasks/describe?templateId=`；上传为 `POST /tasks/upload?provider=&filename=`（带 `X-Tenant-ID`）。事件流断开或超时只回落轮询，不把任务判死。
- bridge 默认走 Supabase Edge Function `${部署身份的 supabaseUrl}/functions/v1/authing-bridge3`；若部署只在 ppserver 暴露桥接，把 `SDPPPX_BRIDGE_URL` 设为 `${SDPPPX_BASE_URL}/auth/authing-bridge3`。
- 描述结果缓存 5 分钟；失败返回最小 prompt schema，不阻塞参数面板。
- 图片结果下载字节后返回 `images`；响应既不是已知图片魔数、`Content-Type` 也不是 `image/*` 时判任务失败，不会把 HTML 存成 PNG。视频结果返回 URL（`videos`）。
- 多输出按顺序成为多个媒体结果。

## 开发与验证

```sh
pnpm --filter @woohaa3/extension-sdpppx-provider typecheck
pnpm --filter @woohaa3/extension-sdpppx-provider test
pnpm --filter @woohaa3/extension-sdpppx-provider build
pnpm --filter @woohaa3/extension-sdpppx-provider build:browser
```

`build` 产出 `dist/{frontend,backend,shared}.js` 与 `backend-dist/entry.mjs`；`build:browser` 产出 `browser-dist/`。全部为 gitignored 构建产物。

真实扫码、真实租户任务与跨登录方式账号核对需要可扫码的微信账号、对应的密码测试账号与可确认的模板清单；离线单测不能替代，见本 change 的任务 6.2–6.5。

## 已知限制：模板输出类型盘点（任务 6.5）

仓库内没有真实租户凭据，无法枚举 `biz_tasks.tasks_template` 的实际记录，因此**没有完成模板清单盘点**：未映射模板的数量、哪些是视频模板、以及 `SDPPPX_TEMPLATE_MODEL_TYPES` 的最终内容都待人工核对。

上线前在有权限的环境执行：

1. 用部署配置（`src/backend/deployment-config.ts`）里的租户登录，打开设置面板的「模型目录」，记录实际出现的模板名称与 ID。
2. 从模板详情或 `GET /tasks/describe?templateId=` 确认每个模板的输出类型；`outputs` 是视频 URL 的模板必须映射为 `video`。
3. 把视频模板写进 `SDPPPX_TEMPLATE_MODEL_TYPES`，例如：

   ```sh
   SDPPPX_TEMPLATE_MODEL_TYPES='{"<templateId>":"video"}'
   ```

4. 重启宿主后逐个跑通一个图片模板与一个已映射的视频模板，确认结果正确落到画布。

在完成上述盘点前，视频模板会被当作图片模板：任务可能成功提交，但结果阶段因下载不到图片而失败。这是已知限制，不是静默降级。
