#!/usr/bin/env node
// One application: shared Vite/Node UI plus a Tauri-owned native Bevy surface.
import { prepareDevelopmentHost } from "./prepare-desktop-host.mjs";
import { stageDevelopmentExecutable } from "./lib/desktop-dev-app.mjs";
import { packageManagerInvocation } from "../web/scripts/package-manager.mjs";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, readFileSync, openSync, closeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDevEntryArgs, DEV_MODE_ENV } from "./lib/bevy-build-mode.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const nativeRoot = join(root, "desktop");
const nativeBinary = join(nativeRoot, `target/debug/woohaa-desktop${process.platform === "win32" ? ".exe" : ""}`);
const args = process.argv.slice(2).filter(arg => arg !== "--");
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
if (args.includes("--help")) {
  console.log(`pnpm dev:desktop [--frontend-port 5174] [--backend-port 5181] [--skip-build] [--no-watch]

Bevy WASM 模式（change: 2026-10-23-optimize-bevy-development-build）：
  默认 development：Cargo dev profile 增量编译、跳过 wasm-opt。
  ${DEV_MODE_ENV}=performance 改用 release + wasm-opt -Oz -g 做本地性能采集。
  --skip-build 只跳过模块/扩展构建；Vite 需要的 WASM 绑定与 Rust 新鲜度仍会检查。`);
  process.exit(0);
}
// 非法开发模式变量在任何构建前失败。
let bevyModeArgs;
try {
  bevyModeArgs = resolveDevEntryArgs(process.env);
} catch (error) {
  console.error(`[desktop] ${error.message}`);
  process.exit(1);
}

const front = option("--frontend-port", process.env.FRONTEND_PORT ?? "5174");
const remote = option("--backend-url", process.env.WOOHAA3_BACKEND_URL);
const back = option("--backend-port", process.env.BACKEND_PORT ?? "5181");
const url = `http://127.0.0.1:${front}/`;
const env = { ...process.env, WOOHAA3_BASE_PATH: "/", VITE_WOOHAA_PERFORMANCE: process.env.VITE_WOOHAA_PERFORMANCE ?? "1", PATH: `${join(homedir(), ".cargo/bin")}${delimiter}${process.env.PATH}` };
// The bundled proxy and local identity provider must share their provenance key.
// A remote backend keeps its explicitly configured key.
if (!remote && !env.WOOHAA3_TRUSTED_INGRESS_SECRET?.trim()) {
  env.WOOHAA3_TRUSTED_INGRESS_SECRET = randomBytes(32).toString("hex");
}
const children = new Set();
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true; process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
}
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));
function launch(command, argv, cwd = root, stdio = "inherit") {
  const invocation = command === "pnpm" ? packageManagerInvocation(argv) : { command, args: argv };
  const child = spawn(invocation.command, invocation.args, { cwd, env, stdio, windowsHide: true });
  children.add(child);
  child.on("error", error => { console.error(error); stop(1); });
  child.once("close", () => children.delete(child));
  return child;
}
function finish(child) {
  return new Promise((resolve, reject) => child.once("close", code => code === 0 ? resolve() : reject(new Error(`进程退出 (${code})`))));
}
async function main() {
  env.TAURI_CONFIG = JSON.stringify({ identifier: "com.woohaa.desktop.dev" });
  let server;
  if (remote) {
    server = launch(process.execPath, ["scripts/dev.mjs", "--native", "--frontend-port", front, "--backend-port", back, "--backend-url", remote, ...(args.includes("--skip-build") ? ["--skip-build"] : []), ...(args.includes("--no-watch") ? ["--no-watch"] : [])]);
  } else {
    // Native UI still imports both generated browser bindings during Vite resolution.
    // change: 2026-10-23-optimize-bevy-development-build —— 与其它开发入口共用模式选择。
    await finish(launch(process.execPath, ["scripts/build-bevy-wasm.mjs", ...bevyModeArgs]));
    await finish(launch(process.execPath, ["scripts/build-image-editor-wasm.mjs", "--keep-names"]));
    if (!args.includes("--skip-build")) {
      await finish(launch("pnpm", ["--config.verify-deps-before-run=false", "-C", "web", "run", "build:units"]));
      await finish(launch(process.execPath, ["web/scripts/build-extension-browser.mjs", "--all"]));
    }
    env.WOOHAA3_BACKEND_URL = `http://127.0.0.1:${back}`;
    server = launch(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", front, "--strictPort"], join(root,"web/frontend"));
  }
  server.once("close", code => { if (!stopping) stop(code || 1); });
  await finish(launch("cargo", ["build", "--bin", "woohaa-desktop"], nativeRoot));
  if (!remote) {
    const prepared = await prepareDevelopmentHost();
    env.WOOHAA_DESKTOP_HOST_ROOT = prepared.resourceRoot;
    env.WOOHAA_DESKTOP_NODE = prepared.node;
    env.WOOHAA_DESKTOP_HOST_PORT = back;
    env.WOOHAA_DESKTOP_UI_URL = url;
    env.WOOHAA3_BACKEND_URL = `http://127.0.0.1:${back}`;
  }  if (env.VITE_WOOHAA_PERFORMANCE !== "0") {
    const directory = join(root, "artifacts/performance", `native-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    mkdirSync(directory, { recursive: true });
    env.WOOHAA_NATIVE_METRICS_PATH = join(directory, "native.json");
    env.WOOHAA_NATIVE_BINARY_ID = `sha256:${createHash("sha256").update(readFileSync(nativeBinary)).digest("hex")}`;
  }
  const deadline = Date.now() + 120_000;
  while (!stopping) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (response.ok) break; }
    catch { /* Vite or the backend build may still be starting. */ }
    if (Date.now() > deadline) throw new Error(`等待共享前端超时：${url}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (stopping) return;
  console.log(`[desktop] 共享界面 ${url}；画布后端 native Bevy`);
  if (process.platform === "darwin") {
    // Retain an app identity without making LaunchServices the responsible process.
    // CLI launch inherits terminal access to the checkout and prepared host resources.
    const app = join(root, ".local/Woohaa Desktop.app");
    const contents = join(app, "Contents");
    mkdirSync(join(contents, "MacOS"), { recursive: true });
    mkdirSync(join(contents, "Resources"), { recursive: true });
    copyFileSync(join(nativeRoot, "icons/icon.icns"), join(contents, "Resources/icon.icns"));
    const executable = join(contents, "MacOS/woohaa-desktop");
    const binary = join(nativeRoot, "target/debug/woohaa-desktop");
    // A symlink here hangs in dyld before main when launched by LaunchServices.
    // Stage atomically so a failed copy preserves the previous runnable app.
    stageDevelopmentExecutable(binary, executable);
    if (!remote && env.WOOHAA_DESKTOP_NODE) {
      const nodeExecutable = join(contents, "MacOS/woohaa-node");
      stageDevelopmentExecutable(env.WOOHAA_DESKTOP_NODE, nodeExecutable);
      env.WOOHAA_DESKTOP_NODE = nodeExecutable;
    }
    writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>woohaa-desktop</string>
<key>CFBundleIdentifier</key><string>com.woohaa.desktop.prototype</string>
<key>CFBundleName</key><string>Woohaa Desktop</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>0.1.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict>
<key>NSAllowsArbitraryLoadsInWebContent</key><true/>
</dict></dict></plist>`);
    const log = join(root, ".local/desktop-app.log");
    const logDescriptor = openSync(log, "a");
    try {
      await finish(launch(executable, remote ? ["--ui-url", url] : [], nativeRoot, ["ignore", logDescriptor, logDescriptor]));
    } finally { closeSync(logDescriptor); }
  } else {
    await finish(launch(nativeBinary, remote ? ["--ui-url", url] : [], nativeRoot));
  }
  stop();
}
main().catch(error => { console.error(`[desktop] ${error.message}`); stop(1); });
