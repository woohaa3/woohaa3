# Woohaa client

Woohaa combines media generation, assets and 3D scene authoring in a canvas. This repository contains the browser frontend, local host, desktop shell, renderer, shared API contracts and public extensions. The client can run locally; remote services and provider accounts are optional integrations.

## Development

Use Node.js 24 or newer, pnpm 11.17.0 and Rust 1.97.1 (pinned in `rust-toolchain.toml`) with `wasm32-unknown-unknown`. Install `wasm-bindgen-cli` 0.2.128 (`cargo install wasm-bindgen-cli --version 0.2.128 --locked`) and Binaryen’s `wasm-opt` on PATH. Bevy’s C++ dependencies require LLVM clang/clang++ with WebAssembly target support (Apple’s system clang does not include it). Install LLVM through Homebrew, your Linux package manager, or the Windows LLVM installer. The build probes PATH and standard LLVM locations; override with `CC_wasm32_unknown_unknown` and `CXX_wasm32_unknown_unknown` when needed. Desktop builds also need the platform prerequisites for Tauri 2.

```sh
pnpm install
pnpm -C web install
pnpm -C api install
pnpm dev
```

The development and production build commands generate the Bevy and image-editor WASM binaries and JavaScript bindings from source before starting Vite. The first build compiles Rust; later runs reuse build caches. These generated files are not committed. `pnpm build:wasm` builds both bindings explicitly.

`pnpm dev:desktop` opens the desktop development app. `pnpm build` builds the browser client and extensions; `pnpm desktop:bundle --build-frontend` packages the desktop app for the current platform. `pnpm typecheck`, `pnpm test` and `pnpm boundary:check` check the public client. See [desktop](desktop/README.md), [API contracts](api/README.md) and [extensions](web/extensions/README.md).

The default storage backend is local. Copy [the configuration example](web/woohaa.config.example.yml) to `web/woohaa.config.yml` only when overriding settings. Provider URLs and keys must be supplied by the user or deployment. Keep credentials in the ignored `web/woohaa.secrets.yml` or environment variables; never commit local configuration or data.

The interface targets desktop computers and tablets. Rendering checks require a real GPU; on macOS inspect `system_profiler SPDisplaysDataType`, and on Linux inspect `/dev/dri/renderD*`.

## Source and third-party rights

The project manifests currently use `UNLICENSED`; a project-wide source license has not yet been selected. This snapshot does not grant an open-source license. Third-party license and attribution files remain with their components, including [pptask](web/vendor/pptask/LICENSE), [Photocraft](photocraft/vendor/photocraft/LICENSE-MIT) and [Photocraft notices](photocraft/vendor/photocraft/NOTICE). Provider logos have separate attribution in each extension’s `assets/README.md`.
