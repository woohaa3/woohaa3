# sdk-agent 扩展

四类个人 API 连接固定使用 Agent 框架。扩展默认关闭，与已安装工具扩展、ChatGPT OAuth 和普通文本/图片/音视频 Provider 独立。打开助手、读取状态、保存 Key 和普通检查不推理；只有生成和维护区「测试生成」会发送模型请求，可能产生上游费用。

| API 类型 | 保留的 adapter ID | 固定引擎及版本 | 地址 |
| --- | --- | --- | --- |
| OpenAI Responses API | `openai-responses`、`codex-agent-sdk` | `@openai/codex-sdk` 0.161.0 + 配套 Codex 0.161.0 | 部署允许的 Responses 协议地址 |
| Anthropic Messages API | `anthropic-messages`、`claude-agent-sdk` | `@anthropic-ai/claude-agent-sdk` 0.3.301 + 同版本平台运行时 | 部署允许的 Messages 协议地址 |
| Chat Completions 兼容 | `compat-chat` | `@deepseek-ai/dsh-sdk-client` + `@deepseek-ai/dsh` 0.2.1-rc.2 | 部署允许的自定义地址 |
| Gemini 原生 API | `gemini-agent-adk` | `@google/adk` 2.3.0 | 部署允许的 Gemini API 地址，无 Vertex/ADC |

历史 adapter ID 只是持久身份；新增表单只有四种 API。没有宿主自写 HTTP 推理/工具循环、没有运行依赖缺失时的降级。`@anthropic-ai/sdk` 是 Claude Agent SDK 的 peer 依赖，不是独立执行器。

## 安装与运行位置

执行发生在本机宿主，浏览器只加载扩展前端产物。运行时按需动态导入；配套 CLI 通过包内平台资源定位，不查找全局 CLI，不在线安装。dsh runtime 由扩展内已安装模块解析绝对入口，禁止 Server 在运行时安装 npm 包。构建：`pnpm --filter @woohaa3/extension-sdk-agent run build`；扩展在站点控制面显式启用（`defaultEnabled:false`）。

dsh 的 bin 依赖 `import.meta.main` 自启，而该属性只在 Node >= 24 存在；因此在 Node 22/23 上由本扩展生成一个显式调用 `runCli()` 的启动器，避免 bin 静默退出（表现为 `JSON-RPC input closed`）。

组合依赖要求 Node >=22（兼容 Provider 包的 engines），当前验证 Node 23.11.0 / macOS arm64。Codex、Claude 上游提供 macOS/Linux x64、arm64 和 Windows 平台包；Claude 另有 Linux musl 包。dsh 是独立的 Node 运行时进程，不依赖平台原生包。其他平台组合和 Node 22 的真实二进制运行待对应机器验证；缺少平台包拒绝运行，不声称跨平台已验证。

**dsh 的单实例约束**：dsh 把 `Symbol` 当作跨包服务 key（`@deepseek-ai/dsh-tools` 的调度器接口）。同一版本被装成多个实例时 Symbol 不相等，`agent-loop` 取不到调度器，**所有工具调用**都会以 `Cannot read properties of undefined (reading 'prepare')` 失败。因此 workspace 的 `@deepseek-ai/cordis` 必须与 dsh 的 peer 范围（`~4.0.5`）一致；升级时先确认 `locks/web/node_modules/.pnpm` 下 `@deepseek-ai+dsh-tools@` 只有一个实例。

许可证：Codex SDK/CLI Apache-2.0；本次锁定的 DeepSeek Harness `dsh`、`dsh-sdk-client` 与 `dsh-subprocess-local` 包均声明 MIT（其余传递依赖以随包许可证为准）；Google ADK 与兼容 Provider Apache-2.0。Claude Agent SDK 的包声明为 `SEE LICENSE IN README.md`，随包保留 README、平台 LICENSE 与 Anthropic Commercial Terms 引用，不能把它标作 MIT/Apache。交付须保留上游许可证与平台二进制。精确依赖与传递版本以 `locks/web/pnpm-lock.yaml` 为准。

## 隔离与传输契约

资源键是 owner、连接 ID、配置版本、引擎版本、凭据代次、宿主会话 ID 与完整目标范围的 SHA-256，不截断。清空建立新宿主会话，替换凭据或升级引擎使旧绑定失效。讨论不恢复带旧写许可的线程。dsh 每轮使用独立 runtime 子进程/`DSH_HOME`/补丁，结束后回收进程及其目录；ADK 每轮创建并删除私有 session，通过宿主合法历史续聊。

四引擎模型请求均指向连接专属 loopback 转发器，框架只拿短期随机 token。真实 Key 仅由宿主注入固定上游；协议方法/路径、查询参数、实际 DNS 地址与拨号地址均受检查，拒绝重定向、CONNECT 和任意代理目标。代次/配置变化、取消或停用后入口失效。转发器只传输模型协议，不存对话、不组织工具循环。生产模型目录使用同一受控边界。

每轮另建 MCP 网关，模型 token 与领域 grant 分开。网关只公开目标模式允许且宿主确实注册的工具；严格冻结 canvas/node/camera/clip/item，首次写入重新核对权威内容版本，使用稳定 requestId 幂等，工具服务再次验证真实 grant。Codex 原生 MCP 资源发现辅助工具仍可能出现在协议目录，但网关拒绝资源方法；它们不能访问其他 MCP、文件或网络。所有 shell、文件、搜索及代码执行内建工具在模型请求前关闭。Claude 使用空内建 tools、严格 MCP 配置及空 settingSources；dsh 在 profile 补丁中显式 `disabled` 全部内建 bash/pwsh/文件/搜索/技能/子代理/任务/命令与 plan-mode 插件，只插入受控 MCP；ADK 不注册默认搜索/执行工具。

框架事件只记录公开回复和工具身份，丢弃隐藏推理。框架正常返回不能证明作品已更新；只有合法领域命令回执才算写入。无回执执行保留 unknown；停止先撤销 grant、中止框架，再核对已经提交的结果，不能宣称撤销作品。Claude/ADK 原生回合上限为 12（dsh 由宿主预算统一约束）；宿主统一限制 24 次工具调用、10 分钟及 512KiB 公开输出。Codex 的模型循环由原生运行时管理，宿主仍执行上述时长、工具与输出边界。

## 配置

从画布工具栏「AI 助手」添加 API Key。四种类型均代表协议而非厂商，均可编辑 Base URL；官方地址只作默认值。地址支持基础 URL 或以 `/chat/completions`、`/responses`、`/messages`、`/models` 结尾的 URL。保存读取目录，不测试生成；失败保留配置并允许手填模型，不添加假模型。修改地址/类型需重新填 Key；原地址留空 Key 保留现有凭据。密钥只在后端按扩展、owner、连接加密，不回读到浏览器。

部署变量：`WOOHAA3_SDK_AGENT_ALLOWED_HOSTS` 可选地限制兼容 host（逗号分隔，支持 `*.suffix`；未设置、留空或 `*` 表示不限制，即允许所有中转站）；`WOOHAA3_SDK_AGENT_ALLOW_HTTP=1` 仅允许明文回环；`WOOHAA3_SDK_AGENT_WORKSPACE_DIR` / `WOOHAA3_SDK_AGENT_CONFIG_DIR` 覆盖私有根目录（默认 `~/.woohaa3/agent-runtimes/{work,config}`）；`WOOHAA3_SDK_AGENT_MCP_URL` 指向宿主受控工具入口。

## 升级和恢复

首次显式执行准备时按固定映射进行可重入版本迁移。宿主先检查该连接的活动与 unknown 回合，未结算则延迟升级；归档旧目标关联后，元数据事务备份旧记录、推进配置版本并清理原生绑定和旧证据。保留 ID、owner、原地址、模型和密钥归属，不合并同厂商独立连接。旧自定义 Responses/Messages 地址原样保留，满足部署地址策略后继续使用原协议；不会改成官方地址或切换协议。

升级前停止并核对活动回合，备份应用 SQLite（使用在线备份）和扩展文档/加密凭据及配套主密钥。迁移失败禁用该连接的新执行，保留查询与历史，修复后重试。禁止用旧 HTTP 引擎解释新库。确需回退二进制时恢复配套存储快照，并单独导出/核对升级期间的画布结果；不得用旧备份覆盖已提交作品。元数据迁移备份不含 Key 明文，不替代整库备份。

## 验证范围

`fixed-engine-runtime.test.ts` 启动真实已安装 SDK/平台运行时，经真实 loopback 模型转发器与每轮 MCP 网关访问可控协议服务，覆盖四引擎讨论和工具回合；其中账号、模型响应及命令回执是测试数据，不代表真实上游权限或真实画布写入。真实账号、付费模型、完整目标写入、真实 GPU 应用验收见 change verification，未具备条件时保留待验证。


在当前 darwin-arm64 干净临时安装中，PATH 仅包含 Node 时四引擎配套入口均可解析；其他平台为声明兼容范围，实际运行验收待对应机器验证。连接目录明确提供 `tools:false` 的模型仅允许讨论；未知能力不冒充已验证。替换 Key 清除原账号的模型/工具证据。
