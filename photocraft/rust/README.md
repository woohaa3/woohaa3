# PhotoCraft Rust 内核与工程核验

本目录是 PhotoCraft 的无 UI Rust 工作区：编辑内核（文档、命令、合成、序列化）与原生工程核验
工具。它通过路径依赖复用 `../vendor/photocraft` 的固定上游快照，不修改上游，也不链接
egui/eframe/wgpu。

```text
rust/
├── Cargo.toml                     # 独立 workspace（自有 Cargo.lock，不并入上游）
├── project-limits.json            # 首期上限唯一权威来源（Rust 与 TS 读同一份）
├── crates/project-verify/         # 原生无 UI 工程核验（不链接 UI）
└── crates/editor-core/            # 无 UI 编辑内核（原生可测 + wasm-bindgen 绑定）
```

界面是 `../packages/editor` 的 React 组件；本目录只提供内核能力，经 wasm-bindgen 暴露。

## 构建

前置：Rust 1.97.1（`rust-toolchain.toml` 固定）、`wasm32-unknown-unknown` 目标、
`wasm-bindgen-cli` 0.2.129（与依赖一致）。`wasm-opt` 可选；缺失时保留未优化产物并在输出中
明确警告。以下命令在 `photocraft/` 根目录执行：

```sh
pnpm run wasm       # editor dist/wasm（glue + wasm + 声明）
pnpm run verifier   # project-verifier dist/bin（Windows 带 .exe）

# 仅检查，不产出 wasm
pnpm run rust:check
pnpm run rust:test  # 非渲染 Rust 测试，不需要 GPU

# 单包检查（在 rust/ 下）
cargo check -p photocraft-project-verify
cargo check -p photocraft-embed-editor --target wasm32-unknown-unknown
```

WASM 编译缓存默认在 `photocraft/.local/wasm-target/`，原生工具在
`photocraft/.local/native-target/`；都可用 `CARGO_TARGET_DIR` 覆盖。产物固定落在包自己的
`dist/`，由 package exports 以字面量子路径暴露；React 动态 `import()`，Vite 分块并解析 wasm URL。
不要把产物放进 `public/` 再用变量 URL import。

中文字体使用 `../assets/fonts/NotoSansSC-Regular.otf`（SHA-256：
`faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9`），许可文件同目录。
宿主部署时把字体随静态资源发布，并通过 `EditorAssetPort`（Woohaa 用 `appPublicUrl`）解析根/子
路径；加载器在打开文档前注册固定字体。拉丁字体使用上游内嵌 Inter，Web 不依赖
`CRAFT_FONTS_DIR` 或系统字体。

原生核验工具通过 `WOOHAA3_PROJECT_VERIFIER_PATH` 接入 Media，值必须是绝对可执行路径。默认
产物是 `packages/project-verifier/dist/bin/photocraft-project-verify`（Windows 为 `.exe`）。
未配置时使用有界 TS 核验；原生进程故障按既有策略回退，内容拒绝不回退；内部 embedded-smart
模式要求原生成功。生产发布与回退实测待人工验证。

## 本地测试与检查

```sh
pnpm run rust:test   # workspace 全部非渲染测试
pnpm run check       # 协议/核验/编辑器 JS 构建、类型检查与测试
```

渲染、帧率、视觉一致性与播放画面相关检查**必须在真实 GPU 机器上人工验收**（本仓 AGENTS.md
「验证环境」）：无 GPU 的 CI 容器只跑类型、单元/回归、协议与构建体积检查。判断是否有 GPU 用
`system_profiler SPDisplaysDataType`（macOS）或 `renderD*`（Linux），**不要**用 `/dev/dri`
——它是 Linux 专有路径，macOS 上不存在。

## 内容职责

普通分组：内容描述与指纹递归包含 children，并区分组专用 pass-through 与 normal；展开状态不计
内容。TS/Rust 工程核验接受普通组，拒绝画板和未开放后代，保持 64 层/16 层深限制。复制容量计算
整个子树，重排检查目标深度，粘贴包含现有后代。分组创建/取消、展开/折叠、组内拖放、组剪贴板与
快捷键已接通；结构变更隔离执行并统一发布一步历史，展开不改变内容身份。组内粘贴检查父组锁定、
全树容量和目标深度。宿主新保存使用 `+woohaa-groups-v1` 能力标识，旧纯提交标识继续可读；上游
来源提交不变；buildInfo 另包含宿主 engineVersion。部署须同时更新 protocol、图片内核、Canvas、
Media 核验；旧版不得继续写新工程，回退关闭编辑、保留 PNG 查看，实际部署验收待人工。
