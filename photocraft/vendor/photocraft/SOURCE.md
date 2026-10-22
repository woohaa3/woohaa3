# 来源清单与许可（Woohaa3 嵌入副本）

本目录是 PhotoCraft 上游源码的**固定快照**，供 Woohaa3 的图像编辑集成使用。它不是子模块，
不带 `.git`，也不跟随上游 `main`；升级必须重新快照、重建并重新验证。

change: `2026-10-16-integrate-photocraft-image-editing`（design D1/D8）。

## 快照信息

| 项 | 值 |
| --- | --- |
| 上游仓库 | `storytold/photocraft` |
| 固定提交 | `4e7a17cd5d5723313f459753663d0d155f047e19`（2026-10-15） |
| 上游版本 | `0.9.0`（workspace `Cargo.toml`） |
| 上游要求的 Rust | `1.95`（`rust-version`）；本集成使用 `1.99.0` |
| 依赖锁 | 本目录的 `Cargo.lock`，SHA-256 `8231aee3b9f35965b8ce0136963091d0ac1f040a9d86a7023e367ea419c96c63` |
| 许可 | `MIT OR Apache-2.0`；**Woohaa3 选择 MIT**（见 `LICENSE-MIT`、`NOTICE`） |
| 文件数 / 体积 | 1774 个文件 / 约 39 MB |
| 机器可读清单 | [`woohaa3-vendor.json`](woohaa3-vendor.json) |

## 快照裁剪（被排除的内容）

排除项不影响构建与运行，只去掉了版本库、构建缓存与文档体积：

`.git`、`target`、`dist`、`corpus`、`log`、`temp`、`book/output`、`docs/images`、`__pycache__`、`*.log`。

`book/`（mdBook 源）、`docs/`、`perf/`、`scorecard/`、`xtask/`、`examples/`、`packaging/` 保留：
上游 workspace 的 `members` 与 CI 任务引用它们，删除会改变 workspace 形状。

## 宿主补丁

**无上游源码补丁。** 上游快照保持逐字节原样；本目录的 `SOURCE.md` 和 `woohaa3-vendor.json` 是宿主维护的来源说明。Woohaa3 的 Rust 编辑内核与原生核验工具位于 `photocraft/rust/`，通过路径依赖引用上游 crate；React 界面位于 `photocraft/packages/editor/`，Woohaa 适配位于 `photocraft/integrations/woohaa/`，构建脚本位于 `photocraft/scripts/`。
因此升级时不需要维护补丁队列，只需要重新快照与重建。

## 依赖来源

`Cargo.lock` 固定在快照内。构建所需的第三方依赖有两类：

1. **crates.io**：由 `Cargo.lock` 固定版本；离线可用本机 cargo 缓存。
2. **Git 依赖**：`craft-ui`（`storytold/craft-libs`）按**不可变 revision** 固定：
   `5c874d51eeb3de70e735c8ce87a59a7dedd47675`（`Cargo.toml` 的 `workspace.dependencies`）。
   这是构建期唯一的网络访问点，且按 revision 固定，**不访问任何 `main` 分支**。
   首次构建前可执行 `cargo fetch --locked` 预热；之后可离线构建。

## 随包许可与字体

宿主不再发布 iframe 独立产物。以下上游许可保留在快照；拉丁字体内嵌编辑内核。中文字体与许可由 `pnpm assets:sync` 分发：

| 文件 | 来源 | 许可 |
| --- | --- | --- |
| `licenses/LICENSE-MIT` | 本目录 `LICENSE-MIT` | MIT |
| `licenses/LICENSE-APACHE` | 本目录 `LICENSE-APACHE` | Apache-2.0 |
| `licenses/NOTICE` | 本目录 `NOTICE` | — |
| `licenses/ATTRIBUTION.md` | 本目录 `ATTRIBUTION.md`（含每个上游资源的作者/来源/许可） | — |
| `licenses/OFL-Inter.txt` | `assets/fonts/OFL-Inter.txt` | SIL OFL 1.1 |
| `licenses/OFL-JetBrainsMono.txt` | `assets/fonts/OFL-JetBrainsMono.txt` | SIL OFL 1.1 |
| `assets/fonts/OFL-NotoSansSC.txt` | 宿主 `bevy/assets/fonts/OFL-NotoSansSC.txt`，取自 Noto CJK 官方 Sans/LICENSE | SIL OFL 1.1 |

随包字体（固定，不依赖操作系统字体）：

| 字体 | 文件 | 来源 | 许可 |
| --- | --- | --- | --- |
| Inter 4.001 | `assets/fonts/Inter-{Regular,Medium,SemiBold}.ttf` | 上游 `assets/fonts/` | SIL OFL 1.1 |
| JetBrains Mono 2.305 | `assets/fonts/JetBrainsMono-Regular.ttf` | 上游 `assets/fonts/` | SIL OFL 1.1 |
| Noto Sans SC | `photocraft/assets/fonts/NotoSansSC-Regular.otf`（本仓已入库） | Google Noto | SIL OFL 1.1 |

宿主固定中文字体 SHA-256 为 `faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9`，加载时核对摘要并注册至文字引擎；Web 不通过 `CRAFT_FONTS_DIR` 或系统字体补中文字形。许可来源：<https://github.com/notofonts/noto-cjk/blob/main/Sans/LICENSE>。

`assets/dict/LICENSE-SCOWL.txt` / `assets/icons/LICENSE-lucide.txt` 等上游资源的许可随
上游 `ATTRIBUTION.md` 一并随包（本文件不重复列举）。

## 升级步骤

1. 取新的上游提交，重新生成快照（同样的裁剪清单），更新本文件与 `woohaa3-vendor.json`
   里的提交、版本、`Cargo.lock` SHA-256 与文件数。
2. 若上游 `.pcraft` 格式版本变化，更新 `web/contracts/src/canvas/image-edit.ts` 的
   `SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS` 与 `photocraft/rust/crates/project-verify`
   的 `SUPPORTED_FORMAT_VERSIONS`，并补格式回归 fixture。
3. 重新构建并跑 `pnpm photocraft:wasm` 与 `pnpm photocraft:verifier`；对比新旧产物的版本字段与体积。
4. 更新 `PHOTOCRAFT_ENGINE_VERSION`（protocol）与 `UPSTREAM_COMMIT`（`photocraft/rust`），
   两端必须一致；`pnpm --filter @woohaa3/contracts exec vitest run src/canvas` 会核对。
5. 渲染相关验收必须在真实 GPU 机器上人工完成（本仓 AGENTS.md「验证环境」）。
