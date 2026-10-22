# PhotoCraft 子项目

独立的图像编辑器子项目：固定上游快照、无 UI Rust 内核、WASM 绑定、原生工程核验、纯协议包、
React 编辑器界面与工程核验的 Node 适配。

本目录**自成一套构建**：有自己的 pnpm workspace、锁文件、Cargo workspace、构建脚本、
测试与 OpenSpec。核心部分不允许读取 `web/`、`bevy/` 或仓库根 `scripts/`；Woohaa 的宿主
接入在 `integrations/woohaa/`（通过宿主 workspace 安装），不是核心的前置条件。

change: `2026-10-21-extract-photocraft-subproject`（design D1/D2/D8）。

## 目录

```text
photocraft/
  vendor/photocraft/   上游固定快照（逐字节原样，含来源/许可/SOURCE.md）
  rust/                独立 Cargo workspace：editor-core（无 UI 内核）+ project-verify（原生核验）
  assets/fonts/        随包中文字体与许可（固定 digest，不依赖 bevy 路径或系统字体）
  packages/protocol/    @woohaa3/photocraft-protocol —— 纯协议，零宿主依赖
  packages/editor/      @woohaa3/photocraft-editor —— React 编辑器界面与内核端口
  packages/project-verifier/ @woohaa3/photocraft-project-verifier —— Node-only 工程核验
  tests/fixtures/       跨语言语义 fixture（Rust 与 TS 共读同一份）
  scripts/              子项目自己的构建入口
  openspec/             子项目正式 OpenSpec（见下）
```

`integrations/woohaa/` 不在本 workspace 里：它依赖宿主 `@woohaa3/contracts`，由
`web/pnpm-workspace.yaml` 以精确成员路径安装，见[宿主装配](#宿主装配)。

## 快速开始

```bash
cd photocraft
pnpm install --frozen-lockfile   # 只用本目录的锁文件
pnpm run build                   # 构建 packages/*
pnpm run typecheck
pnpm run test                    # 包内单元/回归（不需要 Rust）
```

Rust 侧（需要 rustup 与 `wasm32-unknown-unknown`；本目录的 `rust-toolchain.toml` 固定 1.97.1）：

```bash
pnpm run rust:check              # cargo check --workspace
pnpm run rust:test               # cargo test --workspace（非渲染）
pnpm run wasm                    # 产出 packages/editor/dist/wasm/（glue + wasm + .d.ts）
pnpm run verifier                # 产出 packages/project-verifier/dist/bin/（当前平台，Windows 为 .exe）
```

`wasm-opt` 缺失时 WASM 构建会打印告警并保留未优化产物，不静默宣称优化完成。

## 与 Woohaa 的边界

- **核心**（`packages/*`、`rust/`、`vendor/`）只依赖包内代码与已声明工具链，可在只含本目录的
  副本里安装、构建与测试。
- **宿主装配**（`integrations/woohaa/`）依赖 `@woohaa3/contracts` 与宿主平台端口，负责节点身份、
  旧标注转换、资源授权、保存基线、权威回执与预览呈现（Woohaa 仍由原 Bevy 节点显示图片）。
- 两端共享的**语义数据**只有两份：`tests/fixtures/contract.json`（引擎/能力/版本/旧指纹）与
  `rust/project-limits.json`（资源上限）。Rust 与 TS 各有一个测试读同一份，谁都不读对方源码。

## 宿主装配

宿主侧的安装顺序是「先核心、再 web」：核心包必须先 `pnpm install` 并 `pnpm run build`，
`web/` 才能通过 `link:` 解析它们的公共 exports。仓库根提供转发入口：

```bash
pnpm photocraft:setup   # 核心 frozen 安装 + 构建
pnpm photocraft:check   # 核心 typecheck + test + 非渲染 Rust 检查
pnpm photocraft:dev     # 独立编辑宿主（真实 WASM，不接 Canvas 服务）
```

本仓的 Rust 构建不做隐式联网：`pnpm install` / `prepare` 不会触发 cargo。

## OpenSpec

子项目有**自己**的 OpenSpec（`photocraft/openspec`）：编辑器内部语义（`editor-workspace`、
`project-format`、`project-verification`）在此维护；Woohaa 主仓只保留集成行为（聚焦与输入归属、
Bevy 呈现、上传/认证/存储、画布权威事务与历史）并引用这些契约。

迁移台账见主仓 change 的 [notes/migration-ledger.md](../openspec/changes/2026-10-21-extract-photocraft-subproject/notes/migration-ledger.md)。

## 上游快照

上游 `storytold/photocraft` 的固定提交、许可与裁剪清单见 [vendor/photocraft/SOURCE.md](vendor/photocraft/SOURCE.md)
与 [vendor/photocraft/woohaa3-vendor.json](vendor/photocraft/woohaa3-vendor.json)。快照逐字节原样，
**没有任何上游源码补丁**；升级需重新快照并重跑两端测试。
