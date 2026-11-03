# Woohaa desktop

The Tauri shell combines the shared React/Cordis interface with a native Bevy canvas and a bundled local host. It owns the window and application lifecycle; the local host owns canvas data, media, tasks and extensions. Browser mode uses the same interface with the WASM renderer.

Run commands below from the client repository root. Install the root, `web` and `api` dependencies as described in [setup](../README.md). Native builds require the Rust toolchain pinned by `rust-toolchain.toml` and the platform's Tauri build prerequisites. Browser builds additionally require the WASM target and matching wasm-bindgen tooling.

```sh
pnpm dev:desktop
pnpm dev:desktop --skip-build # reuse existing host/extension builds
pnpm dev:desktop --backend-url http://127.0.0.1:5180
pnpm desktop:check
pnpm desktop:test
pnpm desktop:probe
```

The default development command starts the local host and frontend, then opens the application after the host reports ready. Closing the application stops the services started for that session. An explicit backend URL connects to an existing host. Local configuration and provider credentials remain in ignored files; they are not packaged as application defaults.

## Packaging and updates

For a fresh checkout, build the frontend as part of packaging:

```sh
pnpm desktop:bundle --build-frontend
pnpm desktop:bundle --build-frontend --bundles app # macOS application bundle
pnpm desktop:bundle --dry-run
```

The bundled extension set is **directory-authoritative**: every extension package under `web/extensions/` (a directory with a `package.json` whose name starts with `@woohaa3/extension-`) ships with the host. There is no separate inventory file. Non-plugin shared packages live in `web/framework/` and test fixtures in `web/test-fixtures/`, so they are never scanned as extensions.

Bundling does not decide the enable state. `remote-server` ships with `site.defaultEnabled: false`, so it stays off until someone enables it in Settings and configures a server address; a fresh install never shows a dead "server access" entry.

`dev-performance` is a browser-only extension under `web/extensions/`: it supplies the FPS / Draw Call readout merged into the window bar. The packaged app is a `--mode desktop` production build with no `woohaa-development` HTML marker, so the extension registers on the desktop host regardless of that marker, and `getFrameCounters` is exposed for the desktop shell as well as dev builds. Browser production and preview builds still do not register the readout or expose frame counters.

The standalone packaging paths support Apple Silicon macOS and Windows x64. They include a pinned Node runtime, local host, frontend, extensions and native tools, so installed users do not need Node or pnpm. Output manifests under `artifacts/desktop/` record hashes and sizes. An explicit `--ui-url` creates an external-host development configuration. Platform code signing and notarization require the publisher's own credentials; updater signatures are a separate requirement. See [Windows build and lifecycle checks](WINDOWS.md).

Update builds require an explicit HTTPS `WOOHAA_DESKTOP_UPDATE_ENDPOINT`, matching `WOOHAA_DESKTOP_UPDATE_PUBLIC_KEY` and updater signing key. `pnpm desktop:release --build-frontend` reads the private key from `WOOHAA_DESKTOP_SIGNING_KEY` or `~/.config/woohaa-release/updater.key`, with the public key in the adjacent `.pub` file. Supply an endpoint such as `https://updates.example.com/macos-arm64/latest.json`. Upload versioned artifacts first and the index last; keep signing keys outside the repository and upload directory.

A configured application checks updates before starting the data-writing host. Failed checks allow the installed version to run; a discovered update must finish downloading, validating and installing before entering the application. Download or installation failure offers retry or exit.

## Data and verification

Application data is held in the platform application-data directory under `com.woohaa.desktop` (`com.woohaa.desktop.dev` in debug mode). `WOOHAA_DESKTOP_DATA_DIR` selects an isolated directory. Workspace export produces an unencrypted `.woohaa` archive containing data, media, configuration and secrets. Import stops the host, creates a backup and replaces the workspace; it does not merge databases.

```sh
pnpm desktop:host:check -- /path/to/installed/woohaa-desktop
pnpm build:recorder
pnpm recorder:probe
```

The host check exercises bundled-runtime startup, storage, persistence, shutdown and workspace import/export. Renderer correctness and performance require a real GPU and visible desktop session. Probe macOS with `/usr/sbin/system_profiler SPDisplaysDataType`; `/dev/dri` is a Linux-specific path. Build success alone does not establish installation, rendering, notification delivery or automatic-update behavior on another platform.

Native recording runs in a supervised background worker. Its H.264 encoder is source-built, statically linked OpenH264 (`openh264` 0.9.9), using CPU encoding; rendering still requires a GPU. No system FFmpeg is required. Preserve OpenH264 and dependency license notices. The BSD source license and Cisco's separately distributed binary license have different terms; review applicable codec/patent distribution obligations before publishing a build. This note does not select a license for Woohaa source.

Authorization popups share the WebKit session but close independently of the application and local host. On macOS, `Info.plist` allows HTTP in WebKit content for user-configured remote servers and their login pages; the development app uses the same ATS policy. Native networking retains its default ATS policy.

Optional Agent engines, recording, and model rendering use explicit runtime components instead of bundled binaries. CDN configuration, compatible local CLI selection and self-hosted artifact publishing are documented in [runtime components](RUNTIMES.md). The default standalone packaging uses the native desktop frontend and embeds only its startup page; the local host serves the interface.

## 诊断日志上报

原生菜单“上报诊断日志…”会在确认后打包本次运行和最近一次异常运行的日志；“导出诊断日志…”仍可只保存到本机。上报需要已启用服务端接入扩展并登录服务端。确认框展示目标服务端，原始错误输出可能包含路径和业务内容，取消不会上传。

检测到上次异常退出时，在下次启动且服务端会话可用后提示一次；watchdog 检测到卡死恢复时也提示一次。每条普通错误不会触发整包上传。提示被取消后不重复弹出，仍可通过菜单主动上报。

已确认的不可变诊断包暂存在用户数据目录 `logs/upload-queue`，与 `logs/runs` 日志分开。最多五份待上传、每份最多 32 MiB；临时失败按退避重试，最多八次，最多保留七天。任务绑定确认时的服务端与账号，切换账号或服务端后暂停，回到原账号与服务端后才恢复。完成或停止重试后弹出原生结果提示；完成后删除本机队列中的包体。

文件经 `CreatePerformanceUpload` 获取私有 PUT 地址，直传对象存储后用同一个 key 调用 `CommitPerformanceUpload`；登记响应丢失时复用 key 重试，避免重复登记。会话令牌仅由本机宿主持有，不进入诊断包；对象上传不携带会话 Bearer。后台在档案列表中显示“诊断日志”、触发原因和运行 ID。完整分类需要部署含诊断档案元数据迁移的服务端及管理端；旧服务端不认识新增字段。

正常结束标记由 Tauri 实际 `Exit` 事件写入，不能放在不会返回的 `app.run()` 之后；取消退出或宿主停止失败不会提前记为正常结束。缺少标记仅表示“上次未正常结束”，并非已确认崩溃。新启动会清除旧目的地描述，等待本次 remote-server 插件启动且会话可用后才提示；上传结果提示也只对当前连接的账号和服务端展示。
