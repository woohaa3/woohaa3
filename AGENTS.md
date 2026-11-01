# 客户端导航

本仓库是可独立安装、构建、运行的公开客户端。它包含浏览器前端、本机宿主、Bevy 渲染器、桌面壳、生成协议绑定与公开扩展。远端服务端与管理端不在本仓库；本机即可完整使用，远端是可选接入。

安装与命令见 [README.md](README.md)。当前实现归属与近期协议版本见 [CODEMAP.md](CODEMAP.md)。源码与文档冲突时以源码为准。

## 运行时名词

| 名词 | 指什么 | 不指什么 |
| --- | --- | --- |
| **本机宿主** | `web/backend` 装配根 + `web/services/*` 领域服务 | 远端 Go 服务端 |
| **前端** | `web/frontend`：React / Cordis 页面与浏览器适配 | 画布权威状态、任务调度 |
| **渲染器** | `bevy`：浏览器 WASM 或桌面原生离屏/画布 | 持久画布、业务规则 |
| **桌面壳** | `desktop`：Tauri 窗口、应用生命周期、随包宿主 | 画布数据、媒体、扩展逻辑 |
| **扩展** | `web/extensions/*` 与 `extensions/*` 的独立包 | 宿主内置插件 |
| **服务端** | 可选远端（经 `remote-server` 扩展接入） | 本机宿主 |

浏览器与桌面共用同一套前端与本机宿主。浏览器用 Bevy WASM；桌面用原生 Bevy 画布。桌面壳只拥有窗口与进程生命周期，数据面仍归本机宿主。

```text
React / Cordis  ──语义命令 / run / API──►  本机宿主
本机宿主        ──进程内端口装配──►  Canvas / Task / Media / Application / MCP
Canvas          ──只读 Yjs WebSocket──►  前端
前端            ──Render Scene / 纹理 / 空间查询──►  Bevy
```

## 目录结构即架构

目录层级就是职责边界。放错位置比命名错误更难纠正。

| 位置 | 职责 |
| --- | --- |
| [api/gen/es](api/gen/es) | 客户端面 protobuf-es 绑定。协议源与生成管线在仓外，**禁止手改、禁止加 `.proto`** |
| [web/contracts](web/contracts) | 跨边界唯一代码依赖：DTO、schema、纯领域 / codec / reducer。无 I/O、无装配、无 HTTP |
| [web/ui](web/ui) | 独立公共展示组件、图标、样式与主题桥；无应用/业务反向依赖 |
| [web/frontend](web/frontend) | React / Cordis 界面、浏览器适配、画布运行时集成、公共 `extension-api` |
| [web/backend](web/backend) | 本机宿主装配根、路由聚合、端口适配、扩展清单 |
| [web/services](web/services) | 领域服务实现：canvas / task / media / application / mcp / telemetry / agent-connections |
| [web/extensions](web/extensions) | 公开扩展源码（前端 + 后端同目录）；另有非插件框架包 `provider-sdk`、`runtime-foundation` |
| [extensions](extensions) | 第二扩展根（预构建产物，如 PhotoCraft）。与 `web/extensions` 由同一次启动扫描读取 |
| [bevy](bevy) | WASM / 原生渲染、空间查询、模型预览、录制 |
| [desktop](desktop) | Tauri 壳与原生宿主集成 |
| [scripts](scripts) | 开发、构建、打包、边界与扩展预检 |
| [web/tooling](web/tooling) / [web/e2e](web/e2e) / [web/ui/showcase](web/ui/showcase) | 跨包门禁、浏览器测试、组件展示 |
| [web/vendor](web/vendor) | 仓内维护的第三方源码与许可证 |
| [locks](locks) | 依赖锁文件 |

`extensions.config.json` 声明扫描根：`web/extensions` 与 `extensions`。目录名以 `.` 开头表示未安装，改名后重启生效。

## 组织方式

### 一切皆插件

前后端都用 Cordis。宿主只装配、注入与隔离；业务能力以插件或扩展贡献，不在装配根写分支。

**本机宿主三层**（[composition.ts](web/backend/src/composition.ts)）：

1. **基础层** `host/base`：log / gateway / access / config
2. **核心层** `host/core`：storage / telemetry / media / generation / task / canvas / mcp / application
3. **扩展层**：各扩展的 `ExtensionPlugin`（`apply(ctx, config)`）向 `ctx.generation` / `ctx.storage` 等注册；`extension.json` 里指向该工厂的字段仍是 `hostPlugin`

三层装完发 `host/ready`。浏览器可见的同源路径由 `gateway` 按插件登记顺序分派。

**前端两层 scope**（[main.tsx](web/frontend/src/main.tsx) → [page-scope.ts](web/frontend/src/cordis/page-scope.ts)）：

- **App scope**：Router / Theme / Dialog / Slots / 扩展运行时。应用级单例，跨页保留。
- **Page scope**：当前 location 至多一个。切页先释放 outgoing 再挂 incoming。画布页的 identity 含 `canvasId`。

宿主内置插件在 [cordis/plugins](web/frontend/src/cordis/plugins)，清单权威是 [canvas-manifest.ts](web/frontend/src/cordis/canvas-manifest.ts)。业务扩展不写进这份静态清单：发布目录的 metadata + 已校验 artifact 在运行时加载。

独立页面（`/telemetry`、任务监控）用自己的清单，不装配画布资源。

### 契约是唯一跨边界代码

`@woohaa3/contracts` 是各运行单元之间**唯一允许的源码依赖**。它导出稳定 DTO、错误码、纯函数。数据库 adapter、Yjs room、任务调度、Provider、HTTP handler、composition root 都不属于它。

依赖方向：

```text
extensions  ──►  ui / contracts / frontend/extension-api / provider-sdk
frontend    ──►  ui / contracts
ui          ──►  contracts / React peers / Radix / Lucide
backend     ──►  services  ──►  contracts
services    ──►  contracts
bevy        ──►  与 contracts 对齐的渲染协议（不 import TS）
```

扩展不得 import 宿主私有路径、其他扩展源码、node builtin（browser 产物）或 `@deepseek-ai/cordis` 运行时。frontend 与扩展之间有一处**刻意**双向依赖（扩展拿 `extension-api`；frontend 源码型测试 devDepend 扩展入口），`web/pnpm-workspace.yaml` 因此设了 `ignoreWorkspaceCycles: true`。

### 宿主与扩展

宿主提供通用能力，**不按扩展 ID 分支**。扩展只经公共面接入：

| 面 | 用途 |
| --- | --- |
| `extension.json` | 宿主认识扩展的唯一声明。`hostPlugin` 指向扩展层工厂；工厂返回 `ExtensionPlugin`，不是旧名 `HostExtensionPlugin` |
| `src/frontend/metadata.ts` | 浏览器身份的唯一来源（JSON 可序列化，不可引用 plugin/UI） |
| `@woohaa3/frontend/extension-api` | 前端 Context、slots、画布 facade；旧 UI 同实例兼容 |
| `@woohaa3/ui` | 公共组件、图标与展示类型；CSS 由宿主提供 |
| `@woohaa3/contracts` | 纯类型与 codec |
| `@woohaa3/provider-sdk` | 仅后端 Provider：出网守卫、模型刷新、SSRF 校验 |

每个扩展独立 `build:browser`，产物在自己的 `browser-dist/`。宿主 Vite **不扫描、不编译**扩展源码；运行时按发布目录加载。未启用的入口不产生 JS/CSS 请求。

较大扩展（如片场）按职责分子目录：`state` / `authoring` / `preview` / `integration`，再按 `shared` / `browser` / `backend` 分环境。依赖方向是 integration → authoring / preview → state。约定与示例见 [web/extensions/README.md](web/extensions/README.md)。

### 状态归属

- **持久画布**由本机宿主的 CanvasRoom / Y.Doc 管理。浏览器拿只读 published 投影，用语义命令申请修改。
- **working projection** 叠本页待确认命令，供交互与渲染立即反馈。选择、导航、手势属于浏览器本地状态。
- **Render Scene** 是呈现输入，不是持久画布。
- **任务终态与媒体**由 Task / Media 形成，Canvas 把关联结果投影回画布。
- IndexedDB 是恢复缓存，不是权威。

### 新代码放哪

| 要做的事 | 放这里 | 不要放这里 |
| --- | --- | --- |
| 跨前后端 / 跨包的 DTO、纯规则、codec | `web/contracts` | frontend、backend、某个扩展里各写一份 |
| 通用壳：手势、帧提交、设置弹窗、导航、slots | `web/frontend/src/cordis/plugins` | 扩展里复制一份宿主壳 |
| 浏览器适配、远程 API、本地 store | `web/frontend/src/cordis/services` | plugin 里直接 `fetch` / `new WebSocket` |
| 给扩展用的公共 UI / facade | `web/frontend/src/extension-api` | 让扩展 import `cordis/plugins/...` |
| 无 Cordis 的公共展示组件 | `web/ui/src` | 塞进 page-scope 或扩展 |
| 独立整页（不装画布） | `web/frontend/src/pages` | 画布 plugin catalog |
| 领域权威：命令、Yjs、任务、媒体、MCP | 对应 `web/services/<name>` | backend 里写业务规则 |
| 装配、路由、端口适配 | `web/backend` | 在 composition 里识别具体扩展 |
| 业务功能、Provider、存储后端、片场 | `web/extensions/<id>` | 宿主目录、contracts 里写死业务 ID |
| 几何、命中、绘制、录制 | `bevy` | 前端再算一份世界坐标 |
| 窗口、托盘、更新、随包进程 | `desktop` | 画布或扩展逻辑 |

## 按任务定位

先读本页，再打开对应入口，需要细节时查 [CODEMAP.md](CODEMAP.md)。

| 任务 | 先看 |
| --- | --- |
| 页面、路由、面板、主题 | `web/frontend/src/cordis/page-scope.ts`、`canvas-manifest.ts`、`web/ui/src` |
| 画布保存、同步、撤销 | `web/services/canvas-service`、`web/frontend/src/cordis/services/canvas-session.ts` |
| 生成、参数、历史 | `web/frontend/src/cordis/plugins/task-execution`、`web/services/task-service` |
| 3D / 片场 / 模型 | `web/extensions/film-set`、`web/frontend/src/cordis/plugins/model-scene`、`bevy/src/model3d` |
| 拖放、命中、纹理、帧率 | `web/frontend/src/cordis/plugins/canvas-shell`、`canvas-runtime`、`bevy/src` |
| 新增扩展 / Provider / 存储 | [web/extensions/README.md](web/extensions/README.md)、邻近扩展、`extension.json` |
| 本机遥测 | `web/services/telemetry-service`、`web/frontend/src/pages/telemetry` |
| 桌面壳 / 随包宿主 | [desktop/README.md](desktop/README.md)、`desktop/src/local_host.rs` |
| 协议绑定 | [api/README.md](api/README.md) |

## 硬规则

1. **本仓必须能单独 checkout 构建**。禁止 import 父仓、闭源 `server/` `admin/`、内部工具或仅内部扩展。门禁是 `pnpm boundary:check`。
2. **`api/gen/es` 是生成物**。协议变更以重新生成的绑定提交进来，不在本仓补 `.proto` 或手改绑定。管理面契约（`*_admin_pb.ts` / `ops_pb.ts` / `rbac_pb.ts` / `inspect_pb.ts`）不得出现。
3. **宿主不认识业务 ID**。按扩展 ID、Provider 名或片场字段做 `if` 的代码属于放错位置；改成公共端口、slot 或 contracts 声明。
4. **扩展只走公共入口**，具名导入。新增扩展不改框架源码；声明写在自己的 `extension.json`。
5. **界面面向电脑与平板**，不为手机或极窄窗口做专用布局。无障碍不是默认验收项，除非明确要求。
6. **渲染结论必须来自真实 GPU**。macOS 用 `/usr/sbin/system_profiler SPDisplaysDataType`（出现 Apple M* / AMD / Intel 即真实 GPU）；Linux 看 `/dev/dri/renderD*`，WSL2 看 `/dev/dxg` 与 `/usr/lib/wsl/lib/libcuda.so.1`（WSL 不产生 `renderD*`）。macOS 没有 `/dev/dri` 是正常现象。容器 / WSL 里没有本机 GPU 时用宿主浏览器 CDP（`WOOHAA_E2E_CDP` + `E2E_BASE_URL`，实现见 [web/e2e/base-test.ts](web/e2e/base-test.ts)）取证，不 launch 本地软件渲染浏览器。禁止用 SwiftShader / lavapipe 或估算冒充硬件结论。
7. **凭据、本机配置、用户数据、构建产物、签名密钥不进 Git**。许可证与第三方归属文件必须保留。未获版权方指示不得选定项目许可证。

## 常用检查

按改动范围选最近的包，不要默认跑全仓。

```sh
pnpm -C web --filter @woohaa3/contracts typecheck   # 其余包同理：frontend / backend / 各 service / 各 extension
pnpm -C web --filter @woohaa3/frontend test
pnpm boundary:check                                  # import、脚本、配置越界时
pnpm extensions:check                                # 改了扩展声明、产物或槽位
```

单元测试通常与源码相邻。跨包门禁在 `web/tooling`，业务 E2E 在 `web/e2e`，Rust 测试在相邻 `tests.rs` 与 `bevy/tests`。
