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
