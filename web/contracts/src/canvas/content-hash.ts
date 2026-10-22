/**
 * 内容指纹 re-export（change: 2026-10-21-extract-photocraft-subproject，任务 2.1）。
 *
 * 实现已下沉到 `@woohaa3/photocraft-protocol`：那是 PhotoCraft 与 Rust 内核共同核对的
 * 唯一一份 FNV-1a 64 实现。这里保留原导入路径 `contracts/src/canvas/content-hash.js`，
 * 让既有消费者（画布、媒体、扩展）与测试不改 import 即可拿到**逐字节相同**的结果。
 * 逐条列举的原因见 `image-edit.ts`（esbuild 对 external `export *` 的处理）。
 */
export { fnv1a64Hex } from "@woohaa3/photocraft-protocol";
