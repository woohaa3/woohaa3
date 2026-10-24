#!/usr/bin/env node
/**
 * 确保 PhotoCraft 构建产物存在且**是本版本的**（2026-10-24 录制阻塞项）。
 *
 * 曾经这里只判断文件是否存在（`existsSync`），于是 10-22 的旧 WASM 一直留在
 * `web/frontend/src/photocraft-wasm/`：双击图片节点报「图像编辑内核缺少能力协商」，
 * `protocol/dist` 缺 `verifyPhotocraftHandshake`、`project-verifier/dist` 白名单缺
 * `PhotoFilter` 让带调整层的工程保存被拒（报「首期未开放的调整类型：undefined」）。
 * 这些错误都在运行时才出现，且指向的不是真正的原因。
 *
 * 现在的规则：
 * - 产物缺失 / 缺必需导出 / 比源码旧 → **明确报错并重建**，不再静默继续；
 * - 重建后仍不合格 → 非零退出，把原因写清楚；
 * - 三条产物（wasm、protocol、project-verifier）一起检查，因为它们跨仓共享校验逻辑。
 *
 * 只在显式 dev/build 流程调用；**不放进** install/prepare，避免安装时隐式联网构建 Rust。
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncPhotocraftWasm } from "./lib/photocraft-wasm-copy.mjs";
import { checkPhotocraftArtifacts, describeArtifactFailures } from "./lib/photocraft-artifacts.mjs";
import { writeFileSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** `--report <path>`：写一份机器可读结果，让 dev 启动链路知道这次到底重建了什么。 */
const reportIndex = process.argv.indexOf("--report");
const reportPath = reportIndex >= 0 ? process.argv[reportIndex + 1] : null;
const rebuilt = [];

function run(step, args, cwd = root) {
  console.log(`▶ ${step}`);
  const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
  if (result.error) {
    console.error(`✗ 无法启动${step}：${result.error.message}`);
    process.exit(1);
  }
  return result.status ?? 1;
}

let results = checkPhotocraftArtifacts(root);
let failures = results.filter((entry) => !entry.ok);
if (failures.length > 0) {
  console.warn(`! ${describeArtifactFailures(failures)}`);
}

// 内核 WASM 的构建入口是子项目的 build-wasm.mjs（需要 Rust 工具链）。
if (failures.some((entry) => entry.id === "wasm")) {
  rebuilt.push("wasm");
  if (run("PhotoCraft 内核 WASM 构建（photocraft/scripts/build-wasm.mjs）", [join(root, "scripts", "build-image-editor-wasm.mjs")]) !== 0) process.exit(1);
}
// JS 包重建：只重跑声明了该构建脚本的包，构建口径仍只有一份。
if (failures.some((entry) => entry.id === "protocol")) {
  rebuilt.push("protocol");
  if (run("PhotoCraft 协议包构建", [join(root, "photocraft", "scripts", "build-package.mjs")], join(root, "photocraft", "packages", "protocol")) !== 0) process.exit(1);
}
if (failures.some((entry) => entry.id === "verifier")) {
  rebuilt.push("verifier");
  if (run("PhotoCraft 工程核验器构建", [join(root, "photocraft", "scripts", "build-package.mjs"), "--platform", "node"], join(root, "photocraft", "packages", "project-verifier")) !== 0) process.exit(1);
}

// 宿主副本必须来自刚校验过的内核产物。
const copied = syncPhotocraftWasm(root);
if (copied.missingSource) {
  console.error("✗ PhotoCraft 内核产物缺失，无法同步宿主副本");
  process.exit(1);
}
if (copied.copied) console.log(`✓ 宿主 WASM 副本 → ${copied.destination}`);

// 重建后复检：仍不合格就明确失败，不把问题留给运行时。
results = checkPhotocraftArtifacts(root);
failures = results.filter((entry) => !entry.ok);
if (failures.length > 0) {
  console.error(`✗ 重建后仍有产物不合格：
${describeArtifactFailures(failures)}`);
  process.exit(1);
}
console.log("✓ PhotoCraft 产物均为当前源码构建（wasm / protocol / project-verifier）");
if (reportPath) {
  writeFileSync(reportPath, JSON.stringify({ rebuilt, missingSource: false }));
}
