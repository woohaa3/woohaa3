# 可选运行时与最小安装包

桌面核心保留单份 Node、基础本机宿主和画布，首次安装后无需下载组件即可离线编辑。Codex、Claude、DSH、录制和模型离屏程序及图片编辑 WASM 独立发布，缺少时不会自动下载。设置 → 运行时组件提供安装、取消、重试、删除及本机程序入口；Agent 设置可直接跳转。

## 配置

发行默认配置在客户端仓库 `desktop/runtime-downloads.json`，由打包脚本复制进只读宿主资源。正式版用户覆盖位于 `<appData>/config/runtime-downloads.json`，macOS 为：

```
~/Library/Application Support/com.woohaa.desktop/config/runtime-downloads.json
```

开发数据目录独立，使用 `WOOHAA_DESKTOP_DATA_DIR` 时随该目录移动。设置面不显示内部配置文件路径。

```json
{
  "schemaVersion": 1,
  "cdn": { "baseUrl": "https://downloads.example.com/woohaa/runtimes/" },
  "trustKeys": ["-----BEGIN PUBLIC KEY-----\n发行公钥的完整 PEM 内容\n-----END PUBLIC KEY-----\n"],
  "components": {}
}
```

以上是发行默认格式，示例域名与公钥内容需替换。用户覆盖可修改 cdn/components，额外信任公钥使用 `additionalTrustKeys`，不能覆盖发行 trustKeys。组件下载 CDN 与 `WOOHAA_DESKTOP_UPDATE_ENDPOINT` 相互独立。没有 CDN 时基础功能及已安装/本机程序仍可用。

使用自有 CLI 的用户覆盖示例：

```json
{
  "schemaVersion": 1,
  "components": {
    "codex": { "source": "local", "path": "/absolute/path/to/codex" },
    "claude": { "source": "managed" }
  }
}
```

本机程序必须是兼容的直接可执行文件，按锁文件 localVersions 校验；CLI 版本与 SDK/npm 版本分开。Windows 需要原生 `.exe`，不把 npm `.cmd` shim 当成原生程序。仅复用程序，不导入全局账号和技能。

## 构建和上传 CDN

先完成客户端依赖安装与对应平台的 release 工具构建，保留锁定版本。原生录制、模型渲染与图片编辑组件版本从实际二进制/WASM 的 SHA-256 派生；组件构建与 App 打包必须使用同一组二进制。构建脚本不会替用户安装 npm 依赖，也不会上传文件。

在安全位置创建组件签名密钥，例如：

```sh
mkdir -p ~/.config/woohaa-release
openssl genpkey -algorithm ED25519 -out ~/.config/woohaa-release/runtime-components.pem
chmod 600 ~/.config/woohaa-release/runtime-components.pem
WOOHAA_RUNTIME_SIGNING_KEY_FILE="$HOME/.config/woohaa-release/runtime-components.pem" pnpm desktop:runtimes
```

把输出公钥 `trust-key.pem` 的 PEM 内容写进发行默认配置的 trustKeys，并填写 CDN baseUrl，然后打 App：

```sh
pnpm desktop:bundle -- --build-frontend --bundles app,dmg
```

默认组件输出是 `artifacts/runtimes/upload/`。上传内容：

```
catalog.json
catalog.sig
codex/<version>/darwin-arm64.tar.gz
claude/<version>/darwin-arm64.tar.gz
dsh/<version>/darwin-arm64.tar.gz
shot-recorder/<content-version>/darwin-arm64.tar.gz
model-renderer/<content-version>/darwin-arm64.tar.gz
image-editor/<content-version>/darwin-arm64.tar.gz
```

在 Windows x64 上生成对应平台归档。目录还包含锁文件与公开 trust-key.pem，可一并托管；私钥不在输出目录，不能上传。

先上传不可变归档，最后发布 catalog.json/catalog.sig。多平台或多版本必须合并 catalog 的 components 列表后用同一私钥重新签名，不能直接让后一平台覆盖前一平台的目录清单。不要覆盖同版本归档，旧 App 的锁定版本必须继续可下载。每个目录清单中组件 id/version/platform/arch 组合必须唯一。

可用 `--components codex,claude` 限定生成项，`--output /absolute/output` 更换输出目录。限定生成项不代表更改客户端锁文件，也不应覆盖生产目录清单中仍需提供的其他项。

## 加载、缓存与校验

缓存位于 `<appData>/runtimes/<id>/<version>/<platform>-<arch>/`。签名覆盖目录原始字节；下载校验 SHA-256、大小和安全解压规则后原子启用。目录与归档均支持自托管静态 CDN，归档限定 USTAR gzip，不接受外部链接。取消/中断保留可续传部分，CDN 不支持 Range 或实体变更时重新下载。

Codex/Claude/原生工具启动本地程序；DSH 用内置 Node 启动隔离闭包入口，Office/LibreOffice 不进入 SDK 配置闭包。图片编辑器通过本机受控资源接口加载已安装的 WASM，缺少时提示进入组件设置，不自动安装。桌面专用前端不携带浏览器 Bevy WASM；浏览器构建保留原来的资源方式。相同组件共享缓存，使用中的托管组件不能删除。安装完成后即可使用，不要求重启；录制由桌面 supervisor 发现就绪组件后注册真实能力。App 不删除用户自有 CLI。

发布者须保留并验证原生签名与公证；组件清单签名不能替代 Apple/Windows 平台签名。下载器不通过清除隔离标记绕过系统校验。

## 验证

- `pnpm -C web --filter @woohaa3/runtime-components test`
- `node --test scripts/package-runtime-components.test.mjs scripts/desktop-host-package.test.mjs`
- `pnpm boundary:check`
- 受影响宿主、扩展和 frontend 的 typecheck/unit tests。
- 干净 staging 使用随包 Node 验证无全局 Node、无 Agent CLI、离线画布创建/重启持久化。
- 在真实平台验证签名原生程序启动、下载后 Agent 回合及录制/模型渲染，不能以协议测试替代 GPU 验收。

工作区导出不包含可再下载的运行时缓存。保存的自有绝对路径换机器后需重新选择。

## 开发与打包的区别

`pnpm dev` 和 `pnpm dev:desktop` 都直接使用工作区已安装的 SDK/CLI 与本地构建工具，不启用组件下载器、不读取下载缓存。开发宿主的 developmentRoot 标记决定这条分支，不能用 NODE_ENV 判断（开发桌面宿主也可能以 production 方式运行）。打包 App 没有 developmentRoot，才启用用户自有 CLI 或 CDN 托管组件的解析。开发环境缺少依赖时按原来的本地安装/构建流程修复，不静默下载。
