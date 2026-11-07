# Development

[返回项目首页](../README.md) · [配置共享](configuration-sharing.md)

Clone the repository first:

```sh
git clone https://github.com/woohaa3/woohaa3.git
cd woohaa3
```

Run all commands below from the repository root. The packaged desktop app is available from the [download page](http://woohaa3.zombee.tech/download) and does not require this development setup.

## Prerequisites and startup

Use Node.js 24 or newer, pnpm 11.17.0 and Rust 1.97.1 (pinned in `rust-toolchain.toml`) with `wasm32-unknown-unknown`. Install `wasm-bindgen-cli` 0.2.128 (`cargo install wasm-bindgen-cli --version 0.2.128 --locked`) and Binaryen’s `wasm-opt` on PATH. Bevy’s C++ dependencies require LLVM clang/clang++ with WebAssembly target support (Apple’s system clang does not include it). Install LLVM through Homebrew, your Linux package manager, or the Windows LLVM installer. The build probes PATH and standard LLVM locations and selects `clang`, `clang++`, `llvm-ar`, and `llvm-ranlib` from that LLVM. Apple's `ar` writes an empty archive for WebAssembly objects, which drops meshopt symbols at link time. Override with `CC_wasm32_unknown_unknown`, `CXX_wasm32_unknown_unknown`, `AR_wasm32_unknown_unknown`, and `RANLIB_wasm32_unknown_unknown` when needed. Desktop builds also need the platform prerequisites for Tauri 2.

```sh
pnpm install --frozen-lockfile
pnpm -C web install --frozen-lockfile
pnpm -C api install --frozen-lockfile
pnpm dev
```

Open <http://localhost:5173> by default; the local host uses port `5180`. Follow the addresses printed in the terminal if you override the ports.

The development and production build commands generate the Bevy WASM binaries and JavaScript bindings from source before starting Vite. The first build compiles Rust; later runs reuse build caches. These generated files are not committed. `pnpm build:wasm` builds the renderer bindings explicitly.

Bevy WASM builds distinguish three modes: `development` (default for `pnpm dev`, `pnpm dev:frontend`, `pnpm dev:desktop` and `pnpm build:bevy:dev`: incremental dev profile, no `wasm-opt`), `performance` (`pnpm build:bevy:perf`, or `WOOHAA_BEVY_DEV_MODE=performance pnpm dev`: release profile with `wasm-opt -Oz -g` for profiling) and `release` (`pnpm build:bevy`, `pnpm build` and desktop frontend assembly: release profile with `wasm-opt -Oz`). Browser renderer backend selection happens at build time: the build probes the build machine (macOS `system_profiler`, Linux `/dev/dri/renderD*`, Windows `Win32_VideoController`) and chooses WebGPU when a real GPU is found, otherwise WebGL2. Set `WOOHAA_BEVY_RENDERER=webgpu` or `webgl2` to override the probe. `--skip-build` on a development entry skips module and extension builds but still lets Cargo verify and rebuild the selected mode, so changed Rust never loads a stale binary. Build parallelism follows Cargo defaults; set `CARGO_BUILD_JOBS` to limit it. Each build logs its mode, renderer backend, profile, resolved target directory (from `cargo metadata`, honoring `CARGO_TARGET_DIR`), job setting, lock wait and per-stage timings. Legacy `--debug --skip-opt` still means development; `--debug` or `--skip-opt` alone remain documented manual combinations.

`pnpm dev:desktop` opens the desktop development app. `pnpm build` builds the browser client and extensions; `pnpm desktop:bundle --build-frontend` packages the desktop app for the current platform. `pnpm typecheck`, `pnpm test` and `pnpm boundary:check` check the public client; `pnpm -C api run typecheck` checks the generated bindings. See [desktop](../desktop/README.md), [API bindings](../api/README.md) and [extensions](../web/extensions/README.md).

The default storage backend is local. Copy [the configuration example](../web/woohaa.config.example.yml) to `web/woohaa.config.yml` only when overriding settings. Provider URLs and keys must be supplied by the user or deployment. Keep credentials in the ignored `web/woohaa.secrets.yml` or environment variables; never commit local configuration or data.

The interface targets desktop computers and tablets. Rendering checks require a real GPU; on macOS inspect `system_profiler SPDisplaysDataType`, and on Linux inspect `/dev/dri/renderD*`.

## Extension and desktop composition

Image editing is supplied by the PhotoCraft extension published from the marketplace repository (`woohaa3/woohaa3-marketplace`, `extensions/photocraft`). It is not bundled in this checkout; install it from the GitHub Release source (or a local-file package) and enable it in the plugin list. The host exposes focus presentation, media format registration and completion APIs; editor code and assets are extension-owned.

Desktop distributions may supply an external native composition project through `WOOHAA_DESKTOP_PROJECT_DIR` to the same packaging script, with `CARGO_TARGET_DIR` selecting its build cache and bundle output root. An optional `WOOHAA_DESKTOP_COMPOSITION_IDENTITY` JSON file is embedded as `native-composition.json` and included in the artifact manifest. The standalone client keeps an empty native editor registry; distribution composition is owned by its caller. Native implementations still require the corresponding installed extension for editing entry points and document integration. `woohaa-desktop --probe-editors` reports the compiled provider declarations without creating a window or GPU.

