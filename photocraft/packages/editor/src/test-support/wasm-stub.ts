/**
 * 测试期 WASM 子路径替身
 * （change: 2026-10-21-extract-photocraft-subproject，任务 6.1）。
 *
 * 单元测试都注入 `load` 替身；这里只让 Vite 能解析字面量子路径，避免干净副本必须先编译 Rust。
 * 若某个测试真的走到默认加载器，明确失败而不是静默通过。
 */
export default async function init(): Promise<void> {
  throw new Error("测试未注入内核加载器");
}

export class WasmEditor {
  constructor() {
    throw new Error("测试未注入内核加载器");
  }
}
