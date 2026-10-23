/**
 * 绘画域真实 WASM 验收脚本的公共装载器。
 *
 * 这些脚本跑的是**真实内核**（`packages/editor/dist/wasm` 的 Rust 编译产物），
 * 不是 mock、不是对 TS 编译结果的自证。目的是让「参数编译 → WASM → 真实像素/结构」
 * 这条链可被集成负责人和验收人独立复跑。
 *
 * 前置：先在 `photocraft/` 下构建 WASM
 *   node scripts/build-wasm.mjs
 *
 * 用法（在 `photocraft/` 下）：
 *   node tests/features/painting/run.mjs           # 跑全部
 *   node tests/features/painting/run.mjs u27       # 按名称过滤
 *   node tests/features/painting/u28-gradient.mjs  # 跑单个
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** PhotoCraft 工作区根目录（含 `packages/`、`rust/`）。 */
export const workspaceRoot = path.resolve(here, "../../..");

/** 本套件产生的工程/导出文件放在这里，不污染仓库。 */
export const outputDir = (() => {
  // `run.mjs` 会给所有子进程设同一个目录，好让后面的脚本复用前面产出的工程。
  const shared = process.env.PHOTOCRAFT_PAINTING_OUT;
  if (shared) {
    fs.mkdirSync(shared, { recursive: true });
    return shared;
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), "photocraft-painting-"));
})();

/**
 * 载入真实 WASM 内核。
 * 找不到产物时给出可执行的修复指令，而不是让 `initSync` 抛难懂的错。
 */
export async function loadKernel() {
  const wasmDir = path.join(workspaceRoot, "packages/editor/dist/wasm");
  const js = path.join(wasmDir, "photocraft_editor.js");
  const bin = path.join(wasmDir, "photocraft_editor_bg.wasm");
  if (!fs.existsSync(js) || !fs.existsSync(bin)) {
    throw new Error(
      `找不到 WASM 产物：${wasmDir}\n先运行：node scripts/build-wasm.mjs（在 photocraft/ 下）`,
    );
  }
  const mod = await import(pathToFileURL(js).href);
  mod.initSync({ module: fs.readFileSync(bin) });
  return mod;
}

/**
 * 断言收集器。每条用例必须显式给出通过与否，最后统一汇总并决定进程退出码。
 * 失败时打印完整明细，避免「有失败但仍显示通过」。
 */
export function createReport(name) {
  const results = [];
  const log = (pass, label, detail) => {
    results.push({ label, pass, detail });
    const suffix = detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
    console.log(`${pass ? "PASS" : "FAIL"} ${label}${suffix}`);
    return pass;
  };
  return {
    name,
    /** 直接断言布尔值。 */
    ok: (label, pass, detail) => log(Boolean(pass), label, detail),
    /** 断言函数不抛错，并把返回值交给可选回调判定。 */
    runs(label, fn, detail) {
      try {
        const value = fn();
        return log(true, label, detail === undefined ? undefined : detail(value));
      } catch (error) {
        return log(false, label, { error: String(error).slice(0, 300) });
      }
    },
    /** 断言函数必须抛错（例如非法参数必须拒绝，而不是静默降级）。 */
    rejects(label, fn) {
      try {
        fn();
        return log(false, label, { error: "本应被拒绝，但执行成功" });
      } catch (error) {
        return log(true, label, { rejected: String(error).slice(0, 200) });
      }
    },
    /**
     * 结束本文件：打印汇总、设置退出码。
     * 没有用例也算失败，避免空跑被当成通过。
     */
    finish() {
      const failed = results.filter((entry) => !entry.pass);
      if (results.length === 0) {
        console.error(`\n${name}: 没有执行任何用例`);
        process.exitCode = 1;
        return;
      }
      console.log(`\n${name}: ${results.length - failed.length}/${results.length} 通过`);
      process.exitCode = failed.length === 0 ? 0 : 1;
    },
  };
}

/** 新建一个带文档的真实内核会话。 */
export function newSession(mod, { width = 64, height = 48, background = "white" } = {}) {
  const session = new mod.WasmEditor();
  session.execute("file.new", JSON.stringify({ width, height, background }));
  return session;
}
