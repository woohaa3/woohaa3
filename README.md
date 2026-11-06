<p align="center">
  <img src="desktop/icons/128x128@2x.png" width="96" alt="WooHaa3" />
</p>

<h1 align="center">WooHaa3</h1>

<p align="center">在同一张画布上组织素材、生成内容、继续创作。</p>

<p align="center">
  <a href="http://woohaa3.zombee.tech/">官网</a> ·
  <a href="http://woohaa3.zombee.tech/doc">使用文档</a> ·
  <a href="http://woohaa3.zombee.tech/download">下载应用</a> ·
  <a href="https://github.com/woohaa3/woohaa3/issues">问题反馈</a> ·
  <a href="LICENSE">MIT 许可证</a>
</p>

WooHaa3 是一款画布式多媒体创作工作台。将文本、图片、音频、视频和 3D 素材放在同一个工作空间，围绕素材完成 AI 生成、编辑和版本追踪。

桌面应用已发布，支持 **macOS 和 Windows**，目前仅提供**中文界面**。应用支持本地运行，通过扩展连接模型服务、编辑器与 AI 助手。

## 你可以做什么

- **组织多媒体素材**：将不同类型的素材放入画布，通过节点和引用关联创作输入与结果。
- **围绕素材生成内容**：选择模型、填写提示词，并使用模型支持的参考素材生成作品。
- **追踪任务与作品版本**：查看生成状态、结果和历史版本，在已有作品上继续迭代。
- **创作 3D 场景与镜头**：在共享世界中组织模型、调整镜头，并将取景素材用于后续创作。
- **连接 AI 助手**：通过助手与受控 MCP 工具操作画布和创作对象。
- **按需扩展工作台**：安装编辑器，接入新的模型 Provider、存储后端和界面功能。

图片编辑由安装并启用的编辑器扩展提供，例如 [PhotoCraft](https://github.com/woohaa3/woohaa3-marketplace)。扩展的可用功能取决于所安装的版本与配置。

## 开始使用

从[下载页面](http://woohaa3.zombee.tech/download)选择适合 macOS 或 Windows 的安装包。使用已打包的桌面应用无需自行安装 Node.js、pnpm 或 Rust。

1. 启动应用，创建一张画布。
2. 导入本地素材，或新建作品节点。
3. 如需 AI 生成，在设置中配置相应的模型服务与凭据。
4. 选择模型、填写提示词，并按模型能力添加参考素材。
5. 执行生成，查看结果与历史，继续编辑或作为下一轮创作的输入。

详细操作见[使用文档](http://woohaa3.zombee.tech/doc)。

本地素材整理无需接入远端 WooHaa3 服务端。调用外部模型需要相应的账号、凭据和网络连接，费用及可用能力由对应服务决定。本地运行应用不代表模型推理也在本机完成。

## 从源码运行

本仓库包含前端、本机宿主、渲染器、桌面壳和公开扩展，可独立安装、构建和运行。

### 环境要求

| 工具 | 要求 |
| --- | --- |
| Node.js | 24 或更新版本 |
| pnpm | 11.17.0，与 `package.json` 一致 |
| Rust | 1.97.1，由 `rust-toolchain.toml` 固定 |
| WASM target | `wasm32-unknown-unknown` |
| wasm-bindgen-cli | 0.2.128 |
| 编译工具 | Binaryen 的 `wasm-opt`，以及支持 WebAssembly 的 LLVM 工具链 |

桌面开发还需要 [Tauri 2 平台依赖](https://v2.tauri.app/start/prerequisites/)。macOS 的系统 clang 不满足此处的 WebAssembly 编译要求，需要另装 LLVM。安装说明与工具链配置见[开发指南](docs/development.md)。

### 启动浏览器开发环境

准备好上述工具链后执行：

```sh
git clone https://github.com/woohaa3/woohaa3.git
cd woohaa3

pnpm install --frozen-lockfile
pnpm -C web install --frozen-lockfile
pnpm -C api install --frozen-lockfile

pnpm dev
```

默认打开 <http://localhost:5173>，本机宿主默认使用 `5180` 端口。首次启动会从源码编译 Rust/WASM，后续启动会复用构建缓存；以终端实际输出的地址为准。

启动桌面开发应用：

```sh
pnpm dev:desktop
```

### 常用命令

以下命令均在仓库根目录执行：

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动浏览器开发环境与本机宿主 |
| `pnpm dev:desktop` | 启动桌面开发应用 |
| `pnpm build` | 构建浏览器客户端与扩展 |
| `pnpm desktop:bundle --build-frontend` | 为当前平台打包桌面应用 |
| `pnpm typecheck` | 检查客户端类型 |
| `pnpm test` | 构建相关模块并运行测试 |
| `pnpm boundary:check` | 检查独立客户端的依赖边界 |

构建模式与环境变量见[开发指南](docs/development.md)，桌面打包见[桌面开发说明](desktop/README.md)和 [Windows 指南](desktop/WINDOWS.md)。

## 扩展与集成

WooHaa3 通过扩展接入模型服务、编辑器、AI 助手和存储后端。公开仓包含 RunningHub、火山方舟、fal、Replicate 等 Provider 扩展；可用模型以各服务实际返回和配置为准。

扩展可以贡献前端界面与本机宿主能力。开发新的扩展，请从[扩展开发说明](web/extensions/README.md)开始；画布自动化接口见 [MCP 说明](web/services/mcp-service/README.md)。扩展可在本机宿主执行代码，请从信任的来源安装。

默认使用本地存储。需要覆盖配置时，可参考[配置示例](web/woohaa.config.example.yml)。凭据保存在本机的密钥配置或环境变量中；不要将密钥、本机配置或用户数据提交到仓库。团队间导出与导入配置见[配置共享说明](docs/configuration-sharing.md)。

## 项目结构

界面使用 TypeScript、React 和 Cordis；渲染器使用 Rust 与 Bevy；桌面壳使用 Tauri。浏览器模式使用 WASM 渲染器，桌面模式使用原生 Bevy 画布，两者共用前端与本机宿主。

```text
web/frontend/    应用界面与画布交互
web/backend/     本机宿主装配与路由
web/services/    画布、任务、媒体等领域服务
web/contracts/   跨边界类型与纯领域规则
web/ui/          共享 UI 组件与主题
web/extensions/  公开扩展
extensions/      第二扩展根
bevy/            WASM 与原生渲染器
media-image/     图片处理核心
desktop/         Tauri 桌面壳
api/gen/es/      生成的客户端协议绑定
scripts/         开发、构建与检查工具
```

模块入口见[代码地图](CODEMAP.md)，协议绑定约定见 [API 说明](api/README.md)。

## 参与贡献

欢迎报告缺陷、提出功能建议、改善文档、修复代码或开发扩展。

- 使用 [GitHub Issues](https://github.com/woohaa3/woohaa3/issues) 反馈问题，请提供复现步骤、应用版本、操作系统和相关截图。
- 提交代码前阅读[贡献指南](CONTRIBUTING.md)，按修改范围完成检查，并在 Pull Request 中说明改动与验证结果。
- 涉及使用体验、渲染或性能的问题，请附上实际设备与操作场景，便于复现。

## 平台与语言

桌面安装包面向 macOS 与 Windows，具体架构以[下载页面](http://woohaa3.zombee.tech/download)为准。界面目前仅支持中文，面向电脑和平板尺寸的工作窗口。

源码同时提供浏览器运行方式。运行画布需要相应的图形能力，渲染与性能验证应使用真实 GPU。

## 许可证与致谢

WooHaa3 原创代码以 [MIT 许可证](LICENSE)发布。

第三方代码、依赖和品牌资产遵循各自的许可证与使用条款，包括 [pptask](web/vendor/pptask/LICENSE)、[服务图标](web/ui/src/icons/ServiceLogo.LICENSE.md)及各 Provider 扩展的 `assets/README.md`。第三方 Agent SDK 与运行时的归属说明见 [SDK Agent 文档](web/extensions/sdk-agent/README.md)，媒体编码相关说明见[桌面文档](desktop/README.md)。
