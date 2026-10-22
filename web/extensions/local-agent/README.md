# local-agent 扩展

本机 Agent 来源扩展（change: 2026-10-16-add-agent-appserver-and-sdk-connections）。默认关闭；线上默认 release **不安装**。

## 提供的来源

专用 CLI 由进程守护器持有；宿主热重启或被强制结束时，通过管道断开回收其子树。HTTP 端口分配检查系统实际监听占用，并为并发启动预留候选端口。不会扫描或停止用户已有的共享 Agent 服务。

| adapterId | 传输 | 账号 | 说明 |
| --- | --- | --- | --- |
| `codex-appserver` | stdio JSON-RPC | 复用后端现有 Codex 配置/登录（含自定义 provider） | 专用进程；initialize → account → thread/turn |
| `opencode-server` | HTTP `/api/*` | 工具自身 provider 授权 | v2 运行期 MCP、原生 idle 等待与持久消息投影 |
| `codebuddy-server` | HTTP + ACP | 工具自身登录 | `/api/v1/acp` JSON-RPC、连接流与逐请求 SSE |

## 安装与启用

1. 扩展目录 `web/extensions/local-agent` 需已构建（`pnpm --filter @woohaa3/extension-local-agent run build`）。
2. 站点控制面显式启用该扩展（站点 `defaultEnabled:false`）。
3. 可选部署变量：
   - `WOOHAA3_LOCAL_AGENT_CODEX_BIN` / `WOOHAA3_LOCAL_AGENT_OPENCODE_BIN` / `WOOHAA3_LOCAL_AGENT_CODEBUDDY_BIN`：已安装可执行文件路径；可选，未配置时从后端 PATH 自动发现（不自动下载）。OpenCode 官方安装脚本把它放在 `~/.opencode/bin`，只追加到交互式 shell 的 PATH；后端进程未继承该目录时按此固定位置兜底（显式配置仍然优先且不做兜底）。
   - `WOOHAA3_LOCAL_AGENT_WORK_DIR`（可选）：专用工作/配置目录根；缺省用系统临时目录，仍按 owner/连接隔离。
   - `WOOHAA3_LOCAL_AGENT_CODEX_HOME`（可选）：复用的现有 Codex home（含 `config.toml` / `auth.json`）；未配置时按 `CODEX_HOME` → `$HOME/.codex` 查找。
   - `WOOHAA3_LOCAL_AGENT_PORT_MIN` / `WOOHAA3_LOCAL_AGENT_PORT_MAX`（可选）：回环端口范围。

## Codex 账号与 provider

Codex 连接**复用后端机器上现有的 Codex 配置和登录**：进程仍使用每条连接的专用 `HOME`，但本扩展会把现有 `CODEX_HOME` 的 `config.toml` / `auth.json` 以**只读符号链接**放进该连接的 `.codex` 目录。因此：

- 已在后端机器上通过 `codex login` 登录的官方账号可直接使用；
- 使用自定义 model provider（例如 Bearer token gateway）的 `config.toml` 也可直接使用，`account/read` 返回 `requiresOpenaiAuth:false` 视为无需 OpenAI 登录；
- 应用不读取或复制 token，不把全局 Codex 配置当应用身份；
- 每个连接的会话、历史和工作目录仍在该连接目录内，不写入用户 CLI 的 session；
- 从现有 `config.toml` 继承的 `mcp_servers` 会在每轮 `thread/start` 中显式 `enabled = false`，只保留 Woohaa 受控 MCP 工具面；
- 受控 MCP 地址使用部署实际挂载前缀（如 `/dev/<id>/mcp/model-canvas`）；启动目标回合前会核对原生服务确实暴露了本轮工具，缺失时拒绝执行，不会让模型在无工具情况下空答；
- 目标回合会把冻结的 canvas/node/mode（或镜头/片段）和真实工具名写入 prompt，并使用同一组真实 MCP 工具名签发 grant；讨论回合仍只发送用户原话。

OpenCode / CodeBuddy 仍使用各自工具的官方登录流程；应用只读取连接/授权结果。所有本机来源都**不**接受 ChatGPT 订阅授权代替。

## 每轮远程 MCP

无需安装额外 MCP 服务或修改用户全局配置。宿主提供当前挂载前缀下的 HTTP MCP URL，以及只对本轮目标有效的 Bearer grant；提示词只描述目标、操作流程与真实工具名，不携带 token。回合收尾由宿主撤销 grant。

- Codex 保持已有的线程级 `config.mcp_servers` 配置方式。
- OpenCode v2 用 `/api/experimental/mcp/{server}` 的运行期 PUT 配置地址与授权，检查 `/api/mcp` 状态；同一专用 location 的回合串行，结束后 DELETE 运行期配置。v2.0.32 在 connected 后工具目录仍有异步刷新，因此首轮推理前留 1.5 秒刷新时间。推理通过 `/api/session/{id}/prompt` 提交，原生 wait 与持久消息共同核对结果；续轮刷新 permissions 和模型，过滤历史消息。
- CodeBuddy 在 ACP `session/new` / `session/load` 中传入 HTTP `mcpServers` 与本轮 Authorization 头。初始化明确核对 HTTP MCP 能力；GET 连接流和 POST 返回的 SSE 都处理，`session/prompt` 返回 end_turn 才完成，不把 session id 当作完成。讨论会话传空 MCP 列表。
- HTTP 进程显式传分配的 `--port`，保留 CLI 现有登录环境。OpenCode 使用随机专用 HTTP 密码；CodeBuddy 使用 `--serve --host 127.0.0.1 --auth none --strict-mcp-config`，只绑定回环。进程退出清除句柄与端口；Windows 使用短目录片段并回收自有进程树，避免路径过长和 `.cmd` 子进程残留。

Windows 实测：OpenCode 2.0.32 与 CodeBuddy 2.168.2 均已携带当轮 Bearer 完成真实远程 MCP initialize / tools/list。OpenCode 另以本地模型桩完成模型读写、组读写及续轮授权轮换；模型只拿到当轮允许的 MCP 工具，测试不消耗远端账号、不写真实画布。运行可重复用例：设置 `WOOHAA3_TEST_OPENCODE_CLI` 为本机 OpenCode 入口，再执行本扩展测试（见 `src/backend/transports/opencode-cli.test.ts`）。真实远端账号与应用内录制画面仍待验收；CodeBuddy 本次验证不代表受控组创作已实际完成。

## 位置与边界

MCP JSON 结果在文本中也保留完整脚本、哈希和逐项错误；不能假设本机客户端会向模型转发 structuredContent。工具通知只做进度观察，不重复消耗 MCP grant 预算。目标回合没有成功写工具回执时返回失败，不以模型 end_turn 代替写入成功。CodeBuddy 允许 ToolSearch；DeferExecuteTool 必须能解析到本轮允许的真实画布工具，不能借此执行其他内置工具。

回归使用真实 OpenCode CLI、当前 MCP HTTP handler 和本地模型桩，检查模型收到脚本、哈希、统计以及提交回执。另有 backend 的真实 Canvas Room 集成测试覆盖脚本写入及无效脚本拒绝。开发服务的统计/写入失败来自 Node --watch 通知被误当成模型 Worker 结果，执行器现只接收专用结果信封，并已在真实 --watch 进程验证写入。真实账号的完整 Agent 创作流程仍需单独验收。

- 进程运行在 **Woohaa 后端所在机器**上，**不会回连你的电脑**（`LOCAL_AGENT_LOCATION_NOTE`）。
- 只管理本扩展拥有的**专用**子进程；不接管/停止 ATC 等共享 daemon；退出只回收自有进程。
- 工作目录不等于用户项目仓库；进程参数由适配器构造，不提供任意 shell 命令串。

## 版本与限制

- 未知版本明确拒绝，不套用旧版路由。
- OpenCode 和 CodeBuddy 默认不限制写入，支持在目标执行中调用写工具进行创作；工具调用仍由宿主逐次核验授权。
- 部署方若需限制 CodeBuddy 写工具，可通过 `codebuddyWriteRotationVerified: false` 显式关闭。

## 发布

线上默认 release 不安装本扩展；用 `node scripts/assemble-release.mjs --include-extensions local-agent`（或 `WOOHAA3_RELEASE_INCLUDE_EXTENSIONS=local-agent`）显式纳入。

## 真实账号验收状态

本仓库主力开发机是 macOS + 真实 GPU（Metal），渲染与真实官方账号推理仍**待人工验证**（缺少真实
OpenAI 账号/Key，不是缺少 GPU）；未验证适配器不默认开放。

已用后端机器现有的自定义 Codex provider 完成一次真实 `model3d` 目标闭环：`get_model_api` → `get_model_node` → `submit_model_script` 全部成功，画布提交回执 `idempotent:false`。该验证只证明当前自定义 provider、目标 prompt、真实 MCP 工具面和写入路径可用；图片输入、并发续轮隔离、官方账号/Key 与画面一致性仍需人工验收。详见 change 的 `notes/verification.md`。

## 界面操作

打开「Provider 凭据」的「本机 App Server」区域即自动检测后端机器，每十秒刷新，也可点击「重新检测」。检测包含 CLI 安装、服务进程和 OpenCode 4096 / CodeBuddy 4100 默认端口的协议响应；Codex 使用进程检测。显示「未发现」「已安装 · 未运行」或「运行中」，不要求创建或命名连接。

部署允许且 CLI 已安装时，点击「使用此工具」即可启用，同一用户与工具重复操作复用配置。检测与启用不会启动生成。只发现外部 HTTP 服务但没有 CLI 时会显示运行状态与安装说明，不接管外部服务；执行仍使用应用的独立进程和会话。进程运行不代表账号已经登录，登录与模型权限在实际使用时核对。因此节点搭建不把「账号/凭据证据尚未采集」当作拒绝创建的理由：本地登录来源只校验连接身份、版本与组工具能力，账号不可用由这一轮执行返回真实失败；OAuth / API Key 等可在配置期确认的来源仍要求就绪。

检测的是部署后端的机器。Codex 直接复用后端现有配置（见上文）；其他工具请使用各自的官方流程准备账号。停用前在当前页面确认，历史和画布结果保留。
