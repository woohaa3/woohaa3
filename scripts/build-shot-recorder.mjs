// 构建原生录制 worker（change: 2026-10-17-add-native-offscreen-film-set-recording，任务 3.1 / 4.1）。
//
//   node scripts/build-shot-recorder.mjs [--debug] [--probe]
//
// 产物：bevy/target/<profile>/shot-recorder
// 只启用 `recording-worker` feature：没有窗口、没有 winit、不加载 UI/全局 facade。
// 编码走随包编译的 OpenH264（Cisco 许可，非 GPL），**不依赖用户 PATH 或 ffmpeg**。
//
// `--probe` 额外跑一次纯编码自检（无需 GPU），产出真实 MP4 以证明编码链路可用；
// 这不替代真实 GPU 的渲染验收（见 AGENTS.md「验证环境」）。
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const crate = join(root, "bevy");
const release = !process.argv.includes("--debug");
const probe = process.argv.includes("--probe");
const profile = release ? "release" : "debug";

const env = {
  ...process.env,
  // Keep nested desktop build.rs cargo invocations off the desktop target lock.
  CARGO_TARGET_DIR: join(crate, "target"),
  PATH: `${join(homedir(), ".cargo", "bin")}${delimiter}${process.env.PATH}`
};

function run(command, args, cwd, extraEnv) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...env, ...extraEnv },
    stdio: "inherit"
  });
  if (result.error) {
    throw new Error(
      `未找到命令 \`${command}\`，请安装 Rust 工具链与 C++ 编译器（OpenH264 随包编译）。`,
      { cause: result.error }
    );
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(
  "cargo",
  [
    "build",
    "--no-default-features",
    "--features",
    "recording-worker",
    "--bin",
    "shot-recorder",
    ...(release ? ["--release"] : [])
  ],
  crate
);

const binary = join(crate, "target", profile, `shot-recorder${process.platform === "win32" ? ".exe" : ""}`);

if (probe) {
  const workDir = join(root, "artifacts", "recording-probe");
  mkdirSync(workDir, { recursive: true });
  run(binary, ["--probe"], crate, { WOOHAA3_RECORDING_WORK_DIR: workDir });
}

// 供打包脚本读取：二进制必须显式嵌入应用资源，不能要求用户自行安装或在 PATH 中查找。
console.log(`WOOHAA_RECORDING_WORKER=${binary}`);
