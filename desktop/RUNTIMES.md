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

Claude 本机程序按锁文件 `localVersions` 精确校验，CLI 版本与 SDK/npm 版本分开。Codex 接受能自报版本的本机程序，只拒绝锁文件 `blockedVersions` 中的版本；macOS 上可以把 `ChatGPT.app` 作为路径，探测时会解析到包内的 Codex 可执行文件。Windows 需要原生 `.exe`，不把 npm `.cmd` shim 当成原生程序。仅复用程序，不导入全局账号和技能。

## 构建和上传 CDN

先完成客户端依赖安装与对应平台的 release 工具构建，保留锁定版本。原生录制、模型渲染与图片编辑组件版本从实际二进制/WASM 的 SHA-256 派生；组件构建与 App 打包必须使用同一组二进制。构建脚本不会替用户安装 npm 依赖，也不会上传文件。

在安全位置创建组件签名密钥，例如：

```sh
mkdir -p ~/.config/woohaa-release
openssl genpkey -algorithm ED25519 -out ~/.config/woohaa-release/runtime-components.pem
chmod 600 ~/.config/woohaa-release/runtime-components.pem
WOOHAA_RUNTIME_SIGNING_KEY_FILE="$HOME/.config/woohaa-release/runtime-components.pem" pnpm desktop:runtimes
```

把输出公钥 `trust-key.pem` 的 PEM 内容写进发行默认配置的 trustKeys。设置构建环境 `WOOHAA_RUNTIME_CDN_BASE_URL` 为 runtime CDN 根地址，构建自动追加平台与实际 App 版本；发行默认配置也可提供此根地址。然后打 App：

```sh
WOOHAA_RUNTIME_CDN_BASE_URL=https://downloads.example.com/woohaa/runtimes/ pnpm desktop:bundle -- --build-frontend --bundles app,dmg
```

默认组件输出是 `artifacts/runtimes/upload/<平台>/<App发行版本>/`。平台为 `darwin-aarch64` 或 `windows-x86_64`。版本默认读取 `desktop/tauri.conf.json`；若 App 构建指定 `--version`，组件打包必须传相同的 `--version`。`--output` 只改变上传根目录，仍自动追加平台和发行版本。

上传叶目录内容：

```
runtime-release.json
catalog.signed.json
catalog.json
catalog.sig
codex/<version>/darwin-arm64.tar.gz
claude/<version>/darwin-arm64.tar.gz
dsh/<version>/darwin-arm64.tar.gz
shot-recorder/<content-version>/darwin-arm64.tar.gz
model-renderer/<content-version>/darwin-arm64.tar.gz
```

在 Windows x64 上生成对应平台归档。目录还包含锁文件与公开 trust-key.pem，可一并托管；私钥不在输出目录，不能上传。

先上传不可变归档，再发布 catalog.json/catalog.sig，最后上传 catalog.signed.json。各平台和 App 发行版本使用独立目录，无须合并其他平台清单。不要覆盖已发布版本目录，旧 App 的锁定版本必须继续可下载。每个目录清单中组件 id/version/platform/arch 组合必须唯一。

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


### 分目录发布

例如 Windows App 0.1.4 的 runtime 应从 `artifacts/runtimes/upload/windows-x86_64/0.1.4/` 上传到 `<CDN runtime 根目录>/windows-x86_64/0.1.4/`；Mac 对应 `darwin-aarch64/0.1.4/`。不要把子目录内容覆盖到旧公共根目录。

先上传组件归档，最后提交 `catalog.signed.json`（含同一对象中的清单与签名）。运行时会优先读取它，只有 404 才回退旧双文件清单。所有 runtime 产物成功上传后再发布 App/更新索引。已经发布的平台/发行版本目录不能替换为不同内容；改动后使用新 App 版本，旧目录保留。发布期间不要让外部上传插件并发写同一目录。

发行版本仅隔离下载入口；组件版本、验证规则、用户数据目录缓存均不变。App 更新但组件版本未变时继续复用已安装组件。日常开发仍使用本地源码/依赖。


### Windows tar/gzip 安装一致性

Windows 使用 GNU tar 回退时，压缩/解压必须使用同一安装目录的 `gzip.exe`。构建工具会把 tar 所在目录置于其子进程 PATH 首位，避免 MSYS2 tar 误用 Git for Windows gzip 导致 `cygheap base mismatch`。若缺少同目录 gzip，补齐对应工具安装；不要根据通用错误提示删除系统 DLL。Windows 自带 bsdtar 不需要外部 gzip。

### 跨 App 版本共享归档（新版发布器）

新版发布器可把本地 schema 1 构建清单转换并重新签名为 schema 2。清单仍在 `<runtime根>/<平台>/<App版本>/catalog.signed.json`，归档改为 `<runtime根>/blobs/sha256/<归档哈希>.tar.gz`。schema 2 中组件 url 必须为 `blobs/sha256/<sha256>.tar.gz`，下载器只在当前平台/发行目录上移两级后解析这个严格路径。旧 schema 1 继续按当前目录解析；大小、签名、哈希与安全解压校验均保留。

必须为包含新版下载器的 App 使用未发布的新发行版本；旧 App 无法读取 schema 2，不要覆盖旧发行目录。旧对象不删除。上述“直接上传叶目录”仍是 schema 1 的发布方式；共享模式须由支持转换/重新签名的发布器先提交文件池再提交清单，不能混用普通目录上传步骤覆盖清单。

组件归档由 `scripts/lib/runtime-archive.mjs` 以流式 USTAR/gzip 生成，固定时间、所有者、权限规则和顺序，消除未改内容的重复哈希。不再依赖系统 tar/gzip 生成组件包。
