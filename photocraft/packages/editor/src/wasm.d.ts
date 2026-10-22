/**
 * `@woohaa3/photocraft-editor/wasm` 的类型占位
 * （change: 2026-10-21-extract-photocraft-subproject，任务 2.4/5.4）。
 *
 * 真正的 glue 与 `.d.ts` 由 `pnpm run wasm` 生成到 `dist/wasm/`，不入库。类型检查不应该
 * 要求先编译 Rust：这里只声明子路径存在，实际模块形状由 `editor-wasm.ts` 的 `EditorModule`
 * 显式定义并在加载后运行时核对 build-info。
 */
export {};
