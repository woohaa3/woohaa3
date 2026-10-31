# Woohaa client

Woohaa combines media generation, assets and 3D scene authoring in a canvas. This repository contains the browser frontend, local host, desktop shell, renderer, generated protocol bindings and public extensions. The client can run locally; remote services and provider accounts are optional integrations.

## Development

Use Node.js 24 or newer, pnpm 11.17.0 and Rust 1.97.1 (pinned in `rust-toolchain.toml`) with `wasm32-unknown-unknown`. Install `wasm-bindgen-cli` 0.2.128 (`cargo install wasm-bindgen-cli --version 0.2.128 --locked`) and Binaryen’s `wasm-opt` on PATH. Bevy’s C++ dependencies require LLVM clang/clang++ with WebAssembly target support (Apple’s system clang does not include it). Install LLVM through Homebrew, your Linux package manager, or the Windows LLVM installer. The build probes PATH and standard LLVM locations and selects `clang`, `clang++`, `llvm-ar`, and `llvm-ranlib` from that LLVM. Apple's `ar` writes an empty archive for WebAssembly objects, which drops meshopt symbols at link time. Override with `CC_wasm32_unknown_unknown`, `CXX_wasm32_unknown_unknown`, `AR_wasm32_unknown_unknown`, and `RANLIB_wasm32_unknown_unknown` when needed. Desktop builds also need the platform prerequisites for Tauri 2.

```sh
pnpm install
pnpm -C web install
pnpm -C api install
pnpm dev
```

The development and production build commands generate the Bevy WASM binaries and JavaScript bindings from source before starting Vite. The first build compiles Rust; later runs reuse build caches. These generated files are not committed. `pnpm build:wasm` builds the renderer bindings explicitly.

Bevy WASM builds distinguish three modes: `development` (default for `pnpm dev`, `pnpm dev:frontend`, `pnpm dev:desktop` and `pnpm build:bevy:dev`: incremental dev profile, no `wasm-opt`), `performance` (`pnpm build:bevy:perf`, or `WOOHAA_BEVY_DEV_MODE=performance pnpm dev`: release profile with `wasm-opt -Oz -g` for profiling) and `release` (`pnpm build:bevy`, `pnpm build` and desktop frontend assembly: release profile with `wasm-opt -Oz`). Browser renderer backend selection happens at build time: the build probes the build machine (macOS `system_profiler`, Linux `/dev/dri/renderD*`, Windows `Win32_VideoController`) and chooses WebGPU when a real GPU is found, otherwise WebGL2. Set `WOOHAA_BEVY_RENDERER=webgpu` or `webgl2` to override the probe. `--skip-build` on a development entry skips module and extension builds but still lets Cargo verify and rebuild the selected mode, so changed Rust never loads a stale binary. Build parallelism follows Cargo defaults; set `CARGO_BUILD_JOBS` to limit it. Each build logs its mode, renderer backend, profile, resolved target directory (from `cargo metadata`, honoring `CARGO_TARGET_DIR`), job setting, lock wait and per-stage timings. Legacy `--debug --skip-opt` still means development; `--debug` or `--skip-opt` alone remain documented manual combinations.

`pnpm dev:desktop` opens the desktop development app. `pnpm build` builds the browser client and extensions; `pnpm desktop:bundle` builds the frontend and packages the desktop app for the current platform (it refuses a `web/frontend/dist` older than the sources — pass `--no-build-frontend` to reuse an existing build). `pnpm typecheck`, `pnpm test` and `pnpm boundary:check` check the public client; `pnpm -C api run typecheck` checks the generated bindings. See [desktop](desktop/README.md), [API bindings](api/README.md) and [extensions](web/extensions/README.md).

The default storage backend is local. Copy [the configuration example](web/woohaa.config.example.yml) to `web/woohaa.config.yml` only when overriding settings. Provider URLs and keys must be supplied by the user or deployment. Keep credentials in the ignored `web/woohaa.secrets.yml` or environment variables; never commit local configuration or data.

The interface targets desktop computers and tablets. Rendering checks require a real GPU; on macOS inspect `system_profiler SPDisplaysDataType`, and on Linux inspect `/dev/dri/renderD*`.

## Native canvas embedding

`woohaa_bevy_canvas::native_embedding` is the host-neutral Rust contract for
embedding the Bevy canvas in an external Tauri/native window. A host supplies a
borrowed parent handle, an explicitly packaged asset root and logical bounds;
the host owns child-view placement, WebView z-order and its main-thread queue.
`NativeCanvasRuntime` owns the renderer lifecycle and keeps scene, texture and
query state across hide/show and resize. Requests carry protocol and generation
facts and are rejected with stable error codes when stale, oversized or
disposed. The Woohaa `woohaa-native://` URI remains an adapter for the shell;
external WebViews do not need a `main` label or Woohaa token.

The embedding surface is source-only and remains `UNLICENSED`/`publish = false`.
It does not provide a fallback WASM or software renderer. Windows HWND, macOS
NSView and Linux X11/Wayland child-surface assembly remain host responsibilities
and require real-GPU/manual verification.

## Source and third-party rights

The project manifests currently use `UNLICENSED`; a project-wide source license has not yet been selected. This snapshot does not grant an open-source license. Third-party license and attribution files remain with their components, including [pptask](web/vendor/pptask/LICENSE). Provider logos have separate attribution in each extension’s `assets/README.md`.

## Share development configuration

After building the local services (`pnpm services:build`), keep `pnpm dev` running in one terminal and export from another terminal:

```sh
pnpm config:export --out ./team.woohaa
# Custom backend port or mount path:
pnpm config:export --out ./team-custom.woohaa --from http://127.0.0.1:9000/app/
```

The exporter reads `web/.env` (or `WOOHAA3_SERVICE_ENV_FILE`) and process environment with the same precedence as the host. It reads the configured settings/secrets YAML files, resolves provider/storage schema fields including legacy environment overrides, exports extension enablement and values from the configured application SQLite database, and includes the configured task model file and persisted model enablement/default/order policies. It exports remote-server deployment address/device credentials from its local deployment file or environment; site settings have priority for the server address. It also reads the running host’s public `/api/generation-models` snapshot, including LiteLLM gateway and server-discovered models, and reports counts by provider. If the host is unavailable or the response is invalid, export fails rather than silently creating an incomplete package. Only loopback sources are allowed; requests do not carry login tokens. An existing output is never overwritten.

It omits machine paths, personal login tokens, sessions, secret references, task/canvas databases, media, plugin secret stores and extension code. Unknown settings are reported instead of copied. Arbitrary extension `config.local.json` files are not copied; only the remote-server deployment fields have a supported portable reader. Locally hosted API URLs are retained: colleagues still need network access to those services.

In a newly built desktop app choose **工作区 → 导入配置…** and select the `.woohaa` file. The host stops, backs up existing data, merges the supplied configuration and restarts. Supplied keys replace matching keys; an initialized model policy collection replaces the target model policy collection. Unrelated destination settings, canvas/task/media data and personal credentials remain. Colleagues log in with their own account. Imported discovered models retain their types, names and extension ownership in the settings model list. The snapshot never registers an execution provider or grants permission: execution requires the destination’s configured provider/login. A provider’s fresh discovered catalog takes precedence, including removed models. The snapshot does not replace provider-specific executable schemas or capabilities. New packages use format version 2; the importer still accepts old version 1 packages. Imported model settings and remote deployment settings live under the writable user `config/` directory, outside the app bundle. **导入工作区…** remains a separate operation that replaces the full workspace; it does not accept configuration packages.

The configuration package contains shared API credentials and is not encrypted. Keep it out of Git and distribute it through your agreed internal channel. An older app without **导入配置…** must be rebuilt/upgraded to use these packages.

Image editing is supplied by the PhotoCraft extension published from the marketplace repository (`woohaa3/woohaa3-marketplace`, `extensions/photocraft`). It is not bundled in this checkout; install it from the GitHub Release source (or a local-file package) and enable it in the plugin list. The host exposes focus presentation, media format registration and completion APIs; editor code and assets are extension-owned.
