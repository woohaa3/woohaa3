// Woohaa3 桌面宿主原型构建/运行入口
// （change: 2026-10-14-migrate-canvas-to-tauri-native-bevy，任务 1.1 / 1.3）。
//
//   node scripts/desktop-native.mjs --check            编译检查（无 GPU 可运行）
//   node scripts/desktop-native.mjs --probe            环境探测（不创建窗口/GPU 资源）
//   node scripts/desktop-native.mjs --run overlay      运行 overlay 原型（需桌面会话 + GPU）
//   node scripts/desktop-native.mjs --run native-only  运行关闭 WebView 的 native 画布（同上）
//   node scripts/desktop-native.mjs --test             运行非渲染生命周期/坐标测试
//   node scripts/desktop-native.mjs --recorder-test    运行录制 supervisor 与编码链路测试（无需 GPU）
//
// native-only 调试入口默认不参与构建（`desktop/Cargo.toml` 的 `required-features`），本脚本
// 会为 `--run native-only` 显式开启 `native-only-entry`；发行打包不带该 feature，因此
// `.app` 里只有应用入口。
// 本脚本**不**伪造渲染结果：无桌面会话/GPU 时 `--run` 会失败或由被测程序明确报告，不降级为
// 软件渲染或估算。
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const manifest = join(root, "desktop", "Cargo.toml");
const supervisorManifest = join(root, "desktop", "supervisor", "Cargo.toml");
const env = {
  ...process.env,
  PATH: `${join(homedir(), ".cargo", "bin")}${delimiter}${process.env.PATH}`,
};

function run(args) {
  const result = spawnSync("cargo", args, { cwd: join(root, "desktop"), env, stdio: "inherit" });
  if (result.error) {
    throw new Error("未找到 cargo，请安装 Rust 工具链。", { cause: result.error });
  }
  process.exit(result.status ?? 1);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--check")) {
    // 显式带上 native-only-entry：否则 `--all-targets` 会跳过受 required-features 守门的调试入口，
    // 让该入口失去编译覆盖（它也正是发行包刻意排除的那个 bin）。
    run(["check", "--manifest-path", manifest, "--all-targets", "--features", "native-only-entry"]);
    return;
  }
  if (argv.includes("--test")) {
    run(["test", "--manifest-path", manifest, "--lib", "--features", "native-only-entry"]);
    return;
  }
  if (argv.includes("--recorder-test")) {
    // 录制 supervisor 是独立 crate：桌面宿主 crate 仍依赖尚未恢复的 `native-canvas`
    // feature，录制链路不该被那个阻断拖住（见 change notes/native-migration-overlap.md）。
    run(["test", "--manifest-path", supervisorManifest]);
    return;
  }
  if (argv.includes("--probe")) {
    run([
      "run",
      "--manifest-path",
      manifest,
      "--bin",
      "woohaa-desktop",
      "--",
      "--probe",
    ]);
    return;
  }
  const runIndex = argv.indexOf("--run");
  if (runIndex !== -1) {
    const mode = argv[runIndex + 1] ?? "overlay";
    const nativeOnly = mode === "native-only";
    const bin = nativeOnly ? "woohaa-desktop-native" : "woohaa-desktop";
    // native-only 调试入口默认不参与构建（`required-features`），需显式开启；GPU 调试名称
    // （design D8 / 任务 2.6）同样只在显式要求时启用。两者可同时使用。
    const featureList = [];
    if (nativeOnly) featureList.push("native-only-entry");
    if (argv.includes("--gpu-debug")) featureList.push("gpu-debug");
    const features = featureList.length > 0 ? ["--features", featureList.join(",")] : [];
    run(["run", "--manifest-path", manifest, "--bin", bin, ...features]);
    return;
  }
  const captureIndex = argv.indexOf("--gpu-capture");
  if (captureIndex !== -1) {
    const { runGpuCapture } = await import("./desktop-gpu-capture.mjs");
    process.exit(await runGpuCapture(argv.slice(captureIndex + 1)));
    return;
  }
  console.error(
    "用法：node scripts/desktop-native.mjs [--check | --test | --probe | --run overlay|native-only [--gpu-debug] | --gpu-capture ...]"
  );
  process.exit(2);
}

await main();
