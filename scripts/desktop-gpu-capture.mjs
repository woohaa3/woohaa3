// Native GPU 抓帧入口（change: 2026-10-14-migrate-canvas-to-tauri-native-bevy，
// design D8，任务 2.6 / 2.7）。
//
// 在 macOS 上用 Metal System Trace（`xctrace`，Xcode 自带）替代 RenderDoc：
// 每次运行都**独立启动** native-only 宿主进程、抓一段限定长度的 trace、再导出
// encoder 与资源表，检查目标 pass / depth 资源 / 名称占位符是否真的可读。
//
//   node scripts/desktop-native.mjs --gpu-capture --runs 3 --seconds 5
//
// 本脚本只报告实际采集到的内容：
// - `placeholder` 统计 `<Enable the debug feature to see the name>` 的出现次数，
//   未开 `--gpu-debug` 时应大于 0，开了应为 0；
// - 缺少目标 pass 或 depth 资源时明确失败，不做"看起来像通过"的降级。
//
// 不采集性能结论：trace 时长是抓帧窗口，不是帧率或 GPU 耗时测量。
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const desktop = join(root, "desktop");
const binary = join(desktop, "target", "debug", "woohaa-desktop-native");
const DEVELOPER_DIR = "/Applications/Xcode.app/Contents/Developer";

const TARGET_PASSES = ["main_opaque_pass_2d", "main_transparent_pass_2d"];

function tool(name) {
  const result = spawnSync("xcrun", ["--find", name], {
    env: { ...process.env, DEVELOPER_DIR },
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function encodersXPath() {
  return '/trace-toc/run[@number="1"]/data/table[@schema="metal-application-encoders-list"]';
}

function resourcesXPath() {
  return '/trace-toc/run[@number="1"]/data/table[@schema="metal-resource-allocations"]';
}

function exportTable(trace, xpath, out) {
  const result = spawnSync(
    "xcrun",
    ["xctrace", "export", "--input", trace, "--xpath", xpath],
    { env: { ...process.env, DEVELOPER_DIR }, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  if (result.status !== 0) return null;
  writeFileSync(out, result.stdout);
  return result.stdout;
}

function labels(xml) {
  return [...xml.matchAll(/<metal-object-label id="\d+" fmt="([^"]+)"/g)].map((m) => m[1]);
}

function decode(xml) {
  return xml
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function summarize(encoderXml, resourceXml) {
  const encoderLabels = labels(encoderXml).map(decode);
  const resourceLabels = labels(resourceXml).map(decode);
  const placeholder = [...encoderLabels, ...resourceLabels].filter((label) =>
    label.includes("Enable the debug feature"),
  ).length;
  const passes = [...new Set(encoderLabels)].filter((label) =>
    TARGET_PASSES.some((target) => label.startsWith(target)),
  );
  const depth = [...new Set(resourceLabels)].filter(
    (label) => label.includes("Depth") || label.includes("shadow_map"),
  );
  return {
    encoderRows: (encoderXml.match(/<row>/g) ?? []).length,
    placeholder,
    passes: passes.sort(),
    depthResources: depth.sort(),
  };
}

function isAlive(pid) {
  return spawnSync("kill", ["-0", String(pid)]).status === 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStart(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return false;
    return true;
  }
  return false;
}

export async function runGpuCapture(args) {
  const runs = Number(readFlag(args, "--runs", "3"));
  const seconds = Number(readFlag(args, "--seconds", "5"));
  const debug = args.includes("--gpu-debug");
  const outDir = readFlag(args, "--out", join(root, "artifacts", "gpu-capture"));

  if (process.platform !== "darwin") {
    console.error("GPU 抓帧脚本当前只实现 macOS / Metal System Trace 路径。");
    return 2;
  }
  if (!tool("xctrace")) {
    console.error(
      "未找到 xctrace。安装 Xcode 并设置 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer。",
    );
    return 2;
  }
  if (!existsSync(binary)) {
    const features = ["native-only-entry", ...(debug ? ["gpu-debug"] : [])];
    console.error(
      `先构建 native-only 入口：cd desktop && cargo build --bin woohaa-desktop-native --features ${features.join(",")}`,
    );
    return 2;
  }

  mkdirSync(outDir, { recursive: true });
  const results = [];

  for (let run = 1; run <= runs; run += 1) {
    const trace = join(outDir, `run-${run}.trace`);
    const child = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe"], detached: false });
    const log = [];
    child.stdout.on("data", (chunk) => log.push(chunk.toString()));
    child.stderr.on("data", (chunk) => log.push(chunk.toString()));

    if (!waitForStart(child.pid, 30_000)) {
      console.error(`run ${run}: native-only 进程未存活`);
      child.kill();
      return 1;
    }
    // 等 adapter/管线就绪：抓帧过早会只看到启动 pass。
    await sleep(12_000);

    const record = spawnSync(
      "xcrun",
      ["xctrace", "record", "--template", "Metal System Trace", "--attach", String(child.pid),
        "--time-limit", `${seconds}s`, "--output", trace],
      { env: { ...process.env, DEVELOPER_DIR }, encoding: "utf8" },
    );
    child.kill("SIGTERM");
    await sleep(1500);
    child.kill("SIGKILL");

    if (record.status !== 0) {
      console.error(`run ${run}: xctrace record 失败\n${record.stderr}`);
      return 1;
    }

    const encoderXml = exportTable(trace, encodersXPath(), join(outDir, `run-${run}-encoders.xml`));
    const resourceXml = exportTable(trace, resourcesXPath(), join(outDir, `run-${run}-resources.xml`));
    if (!encoderXml || !resourceXml) {
      console.error(`run ${run}: 导出 trace 表失败`);
      return 1;
    }

    const summary = summarize(encoderXml, resourceXml);
    const ok = summary.passes.length === TARGET_PASSES.length && summary.depthResources.length > 0;
    results.push({ run, trace, ok, ...summary });
    writeFileSync(join(outDir, `run-${run}.log`), log.join(""));
    console.log(
      `run ${run}: passes=${summary.passes.length} depth=${summary.depthResources.length} ` +
        `placeholder=${summary.placeholder} encoderRows=${summary.encoderRows} ${ok ? "OK" : "MISSING"}`,
    );
  }

  writeFileSync(
    join(outDir, "summary.json"),
    `${JSON.stringify(
      {
        platform: process.platform,
        device: "see trace-toc target",
        tool: "Metal System Trace (xctrace)",
        gpuDebug: debug,
        targetPasses: TARGET_PASSES,
        runs: results,
        scope:
          "抓帧窗口内的 pass/资源名称与 depth 资源存在性；不是帧率、GPU 耗时或呈现确认。",
      },
      null,
      2,
    )}\n`,
  );

  const failed = results.filter((result) => !result.ok);
  console.log(`\n证据目录：${outDir}`);
  if (failed.length > 0) {
    console.error(`${failed.length}/${results.length} 次捕获缺少目标 pass 或 depth 资源。`);
    return 1;
  }
  return 0;
}

function readFlag(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}
