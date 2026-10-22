// 构建 Woohaa3 原生无窗口模型预览渲染器（change: enhance-model-scene-authoring-api，任务 6.2 / 8.4）。
//
//   node scripts/build-model-renderer.mjs [--debug]
//
// 产物：bevy/target/<native-triple>/<profile>/model-renderer
// 只启用 `native-renderer` feature：不创建窗口、不依赖 winit / 用户浏览器。
// 运行和视觉验收需要真实 wgpu 硬件适配器（Metal/Vulkan）；无硬件 GPU 时留待人工验证，
// 启动失败必须被 Canvas Service 呈现为 renderer-unavailable，而不是回退到浏览器。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const crate = join(root, "bevy");
const release = !process.argv.includes("--debug");
const profile = release ? "release" : "debug";

const env = { ...process.env, PATH: `${join(homedir(), ".cargo", "bin")}${delimiter}${process.env.PATH}` };

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) {
    throw new Error(`未找到命令 \`${command}\`，请安装 Rust 工具链。`, { cause: result.error });
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main() {
  const triple = process.env.WOOHAA3_NATIVE_TARGET ?? hostTriple();
  run(
    "cargo",
    [
      "build",
      "--target",
      triple,
      "--no-default-features",
      "--features",
      "native-renderer",
      "--bin",
      "model-renderer",
      "-j",
      process.env.CARGO_BUILD_JOBS ?? "8",
      ...(release ? ["--release"] : [])
    ],
    crate
  );

  const artifact = join(crate, "target", triple, profile, `model-renderer${process.platform === "win32" ? ".exe" : ""}`);
  if (!existsSync(artifact)) {
    throw new Error(`缺少原生 renderer 产物 ${artifact}`);
  }
  console.log(`✓ model-renderer 就绪 → ${artifact}`);
  console.log(`  配置 Canvas Service：WOOHAA3_MODEL_RENDERER_CMD=${artifact}`);
}

/** 本机 host triple（rustc -vV 的 host 行）。 */
function hostTriple() {
  const result = spawnSync("rustc", ["-vV"], { env, encoding: "utf8" });
  if (result.status === 0) {
    const match = /host:\s*(\S+)/.exec(result.stdout);
    if (match) return match[1];
  }
  return `${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu`;
}

main();
