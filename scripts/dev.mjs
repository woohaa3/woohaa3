#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs, { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveModelRendererCommand } from "./lib/model-renderer-command.mjs";
import { loadServiceEnv } from "./lib/service-env.mjs";
import { resolveAppBasePath } from "./lib/app-base-path.mjs";
import { resolveAppPageTitle } from "./lib/app-html.mjs";
import { canBindPort, findPortOwners, freePort } from "./lib/dev-port-guard.mjs";
import { startHostWatch } from "./lib/dev-host-watch.mjs";
import { packageManagerInvocation } from "../web/scripts/package-manager.mjs";
import { decideBackendExit, RESTART_LOOP_LIMIT, RESTART_LOOP_WINDOW_MS } from "./lib/dev-restart-policy.mjs";
import { syncBevyAssets } from "./sync-bevy-assets.mjs";
import { resolveDevEntryArgs, DEV_MODE_ENV } from "./lib/bevy-build-mode.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2).filter((value) => value !== "--");
const usage = `启动 Vite 和统一后端：
  npm run dev -- --frontend-port 5300 --backend-port 5301
  pnpm dev --frontend-port 5300 --backend-port 5301

选项：
  --frontend-port <port>  前端端口（FRONTEND_PORT，默认 5173）
  --backend-port <port>   后端端口（BACKEND_PORT / PORT，默认 5180）
  --native                桌面宿主模式：画布走 native Bevy；仍生成前端导入所需的 WASM 绑定
  --skip-build            使用已有模块/扩展产物；仍按所选 Bevy 模式检查 Rust 源码新鲜度
  --free-port             启动前结束占用前后端端口的残留进程（SIGTERM，超时后 SIGKILL）
  --watch                 显式开启宿主源码 watch（默认开启）
  --no-watch              关闭宿主源码 watch
  --help                 显示帮助

Bevy WASM 模式（change: 2026-10-23-optimize-bevy-development-build）：
  默认 development：Cargo dev profile 增量编译、跳过 wasm-opt，保留 Rust 函数名。
  ${DEV_MODE_ENV}=performance 启动即改用 release 编译 + wasm-opt -Oz -g，用于本地性能采集。
  --skip-build 不跳过 Rust 新鲜度检查：改了 bevy/ 源码仍会先重建所选模式的 WASM。

宿主 watch（默认开启）：监听配置根下的包源码，按包重跑它自己的构建脚本（build /
server:build / 扩展 build:browser + assemble:extensions），宿主进程以 node --watch 运行，
产物被重写后自动重启。扩展浏览器产物更新后需刷新页面。构建失败只记录，dev 会话继续。
后端配置从 web/.env 加载，进程环境优先；CLI 端口优先级最高。
`;

function parseOptions() {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const [name, inline] = args[i].split("=", 2);
    if (name === "--skip-build" && inline === undefined) {
      options.skipBuild = true;
    } else if (name === "--native" && inline === undefined) {
      options.native = true;
    } else if (name === "--free-port" && inline === undefined) {
      options.freePort = true;
    } else if ((name === "--watch" || name === "--no-watch") && inline === undefined) {
      options.watch = name === "--watch";
    } else if (name === "--frontend-port" || name === "--backend-port") {
      const value = inline ?? args[++i];
      if (!value || !/^\d+$/.test(value)) throw new Error(`${name} 需要整数端口`);
      options[name.slice(2)] = value;
    } else {
      throw new Error(`未知参数：${args[i]}`);
    }
  }
  return options;
}

function portNumber(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} 必须在 1–65535 之间`);
  }
  return port;
}

const children = new Set();
let stopping = false;
let stopPromise;
let hostWatch = null;
const processGroups = process.platform !== "win32";

function signalChild(child, signal) {
  try {
    if (processGroups) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") console.error(`[dev] ${error.message}`);
  }
}

function stop(code) {
  if (stopPromise) return stopPromise;
  stopping = true;
  process.exitCode = code;
  // 监听句柄会保持事件循环存活：先关监听，再收子进程。
  hostWatch?.close();
  hostWatch = null;
  stopPromise = (async () => {
    const pending = [...children];
    const exited = pending.map((child) => new Promise((resolve) => child.once("close", resolve)));
    for (const child of pending) signalChild(child, "SIGTERM");
    // 构建工具及服务均在各自进程组里，退出时一并清理；超时强制退出。
    const timeout = setTimeout(() => {
      for (const child of pending) signalChild(child, "SIGKILL");
    }, 5000);
    try {
      await Promise.all(exited);
    } finally {
      clearTimeout(timeout);
    }
  })();
  return stopPromise;
}

process.on("SIGINT", () => void stop(130));
process.on("SIGTERM", () => void stop(143));

function start(command, commandArgs, options = {}) {
  const child = spawn(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    detached: processGroups,
    ...options
  });
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = start(command, commandArgs);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 || stopping) resolve();
      else reject(new Error(`构建失败（${signal ?? code}）`));
    });
  });
}

/** 当前包管理器入口：优先用调用方的 npm_execpath，避免依赖 PATH 中的 pnpm shim。 */
function managerCommand(args) {
  const manager = process.env.npm_execpath;
  if (manager && /pnpm/i.test(manager)) return { command: process.execPath, commandArgs: [manager, ...args] };
  // Windows 上 .cmd 无法直接 spawn（Node 24 抛 EINVAL），交给公共包管理器解析器找 Node 入口。
  if (process.platform === "win32") {
    const { command, args: commandArgs } = packageManagerInvocation(args);
    return { command, commandArgs };
  }
  return { command: "pnpm", commandArgs: args };
}

function runManager(args) {
  const { command, commandArgs } = managerCommand(args);
  return run(command, commandArgs);
}

/** 宿主 watch 的一步重建：包内脚本按包名过滤，装配类脚本在 web/ 工作区根运行。 */
async function rebuildStep(step, target) {
  // 退出途中不再启动新的构建子进程（stop 只回收它启动时已在册的子进程）。
  if (stopping) return;
  const label = step.scope === "workspace" ? `web ${step.script}` : `${target.name} ${step.script}`;
  console.log(`[dev] ${target.file} → 重建 ${label}`);
  const args =
    step.scope === "workspace"
      ? ["-C", "web", "run", step.script]
      : ["-C", target.dir, "run", step.script];
  try {
    await runManager(args);
  } catch (error) {
    console.error(`[dev] 重建失败：${label}（${error.message}）`);
    throw error;
  }
}

/**
 * @param {string} name
 * @param {import("node:child_process").ChildProcess} child
 * @param {{ relaunch?: () => import("node:child_process").ChildProcess, restarts?: number[] }} [options]
 *   relaunch：受控重启（退出码 75）时重新拉起同一条命令；不提供则任何退出都结束会话。
 */
function supervise(name, child, options = {}) {
  child.once("error", (error) => {
    console.error(`[dev] ${name} 启动失败：${error.message}`);
    void stop(1);
  });
  child.once("close", (code, signal) => {
    if (stopping) return;
    if (options.relaunch) {
      const restarts = options.restarts ?? [];
      const decision = decideBackendExit({ restarts }, { code, signal, stopping });
      if (decision.action === "ignore") return;
      if (decision.action === "restart") {
        console.log(`[dev] ${name} 请求重启（退出码 75），重新拉起（第 ${decision.attempt} 次）`);
        supervise(name, options.relaunch(), { ...options, restarts });
        return;
      }
      if (decision.reason === "restart-loop") {
        console.error(`[dev] ${name} 在 ${RESTART_LOOP_WINDOW_MS / 1000} 秒内连续 ${RESTART_LOOP_LIMIT} 次请求重启，按崩溃处理并关闭开发服务器`);
        void stop(decision.code);
        return;
      }
    }
    console.error(`[dev] ${name} 已退出（${signal ?? code}），关闭开发服务器`);
    void stop(code || 1);
  });
}

async function main() {
  if (args.includes("--help")) {
    console.log(usage);
    return;
  }
  const options = parseOptions();
  // 非法的 WOOHAA_BEVY_DEV_MODE 在端口探测和任何构建之前失败（change: 2026-10-23）。
  const bevyModeArgs = resolveDevEntryArgs(process.env);
  // 宿主 watch 默认开启；--no-watch 回到「构建一次 + 普通 node 进程」的旧行为。
  const watch = options.watch ?? true;
  const serviceEnv = loadServiceEnv(root, process.env.WOOHAA3_SERVICE_ENV_FILE);
  // change: 2026-10-15-support-configurable-app-base-path：启动阶段规范化挂载配置；非法配置在
  // 构建与监听前失败。前后端使用同一规范结果。
  let basePath;
  try {
    basePath = resolveAppBasePath(serviceEnv);
  } catch (error) {
    console.error(`[dev] ${error.message}`);
    process.exit(1);
  }
  const frontendPort = portNumber(options["frontend-port"] ?? process.env.FRONTEND_PORT ?? 5173, "前端端口");
  const backendPort = portNumber(
    options["backend-port"] ?? process.env.BACKEND_PORT ?? process.env.PORT ?? serviceEnv.BACKEND_PORT ?? serviceEnv.PORT ?? 5180,
    "后端端口"
  );
  if (frontendPort === backendPort) throw new Error("前后端端口必须不同");

  // 端口守卫：残留 dev 会话（典型是后端崩溃后只留下 vite，见 dev.mjs 的 supervise）会占着端口，
  // 等到 Vite 抛「Port xxx is already in use」时已经白跑了一轮构建，且报错看不出是谁占的。
  // 启动前先探测：默认给出占用进程并退出；显式 --free-port 才结束占用进程（SIGTERM，超时 SIGKILL）。
  for (const port of new Set([frontendPort, backendPort])) {
    if (await canBindPort(port)) continue;
    if (!options.freePort) {
      const owners = await findPortOwners(port).catch((error) => {
        console.error(`[dev] 解析端口 ${port} 占用进程失败：${error.message}`);
        return [];
      });
      const detail = owners.length
        ? owners.map((owner) => `pid ${owner.pid}${owner.command ? `（${owner.command}）` : ""}`).join("、")
        : "占用进程未知（需要 lsof 或 ss）";
      console.error(`[dev] 端口 ${port} 已被占用：${detail}`);
      console.error("[dev] 结束占用进程后重试，或加 --free-port 让 dev 先自动清理（SIGTERM，超时 SIGKILL）");
      await stop(1);
      return;
    }
    try {
      const result = await freePort(port, { log: (message) => console.log(`[dev] --free-port：${message}`) });
      if (!result.freed) {
        console.error(`[dev] 端口 ${port} 仍被占用，无法启动`);
        await stop(1);
        return;
      }
      console.log(`[dev] 端口 ${port} 已释放`);
    } catch (error) {
      console.error(`[dev] 端口 ${port} 无法释放：${error.message}`);
      await stop(1);
      return;
    }
  }

  syncBevyAssets();
  // Vite resolves both generated binding modules even when the native canvas is active.
  // Build helpers reuse their caches; --skip-build still ensures Rust freshness: the script
  // always runs Cargo for the selected mode, so a changed bevy/ source cannot be served stale.
  // change: 2026-10-23-optimize-bevy-development-build —— 模式由 WOOHAA_BEVY_DEV_MODE 选择。
  await run(process.execPath, ["scripts/build-bevy-wasm.mjs", ...bevyModeArgs]);
  if (stopping) return;
  if (stopping) return;
  if (!options.skipBuild) {
    console.log("[dev] 构建模块（已有产物时可用 --skip-build 快速重启）");
    await runManager(["-C", "web", "run", "build:units"]);
  }
  if (stopping) return;

  // 独立 browser 产物（change: 2026-10-12-build-and-load-extensions-independently，任务 6.5）：
  // dev 启动前构建扩展 browser-dist 并装配发布目录，使 Vite dev 能像生产一样从
  // `/extension-releases/<id>.json` 加载；失败不阻断（保留上次完整产物/无扩展能力），
  // MUST NOT 回退到 eager 源码扫描；扩展装配不重建 WASM/backend。
  if (!options.skipBuild || !existsSync(path.join(root, "web/frontend/dist/extension-releases"))) {
    try {
      await runManager(["-C", "web", "run", "build:browser"]);
      await runManager(["-C", "web", "run", "assemble:extensions"]);
    } catch (error) {
      console.warn(`[dev] 扩展 browser 产物构建/装配失败，保留上次产物：${error.message}`);
    }
  }
  if (stopping) return;

  const rendererCommand = resolveModelRendererCommand({ root, env: serviceEnv });
  if (rendererCommand) serviceEnv.WOOHAA3_MODEL_RENDERER_CMD = rendererCommand;

  const backendHost = serviceEnv.HOST || serviceEnv.BACKEND_HOST || "127.0.0.1";
  const proxyHost = backendHost === "0.0.0.0" ? "127.0.0.1" : backendHost === "::" ? "::1" : backendHost;
  const backendUrl = `http://${proxyHost.includes(":") ? `[${proxyHost}]` : proxyHost}:${backendPort}`;
  const require = createRequire(path.join(root, "web/frontend/package.json"));
  const vite = path.join(path.dirname(require.resolve("vite/package.json")), "bin/vite.js");

  const backendDir = path.join(root, "web/backend");
  const backendEntry = "web/backend/server-dist/index.js";
  if (watch && !existsSync(path.join(root, backendEntry))) {
    console.error(`[dev] 宿主 watch 需要已有构建产物，但 ${backendEntry} 不存在；先跑 pnpm -C web run build:units，或去掉 --skip-build。`);
    await stop(1);
    return;
  }

  console.log(`[dev] 前端：http://localhost:${frontendPort}${basePath === "/" ? "" : basePath} → 后端：${backendUrl}`);
  // node --watch：宿主崩溃或改坏代码时不结束会话，等待文件变化后自动重启（输出保留在终端）。
  // 退出码 75（受控重启，change: 2026-10-21-harden-extension-fault-isolation）：重新拉起同一条命令，
  // 会话不结束；连续重启循环按崩溃处理（见 lib/dev-restart-policy.mjs）。
  const backendWatchArgs = process.platform === "win32"
    ? ["--watch", `--watch-path=${backendEntry}`, "--watch-preserve-output", backendEntry]
    : ["--watch", "--watch-preserve-output", backendEntry];
  const startBackend = () => start(process.execPath, watch ? backendWatchArgs : [backendEntry], {
    env: { ...serviceEnv, WOOHAA3_BASE_PATH: basePath, PORT: String(backendPort), BACKEND_PORT: String(backendPort) }
  });
  supervise("backend", startBackend(), { relaunch: startBackend });
  // 显式监听 IPv4，避免容器禁用 IPv6 回环时 ATC 无法连接通配地址。
  supervise("frontend", start(process.execPath, [vite, "--host", "0.0.0.0", "--port", String(frontendPort), "--strictPort"], {
    cwd: path.join(root, "web/frontend"),
    env: {
      ...process.env,
      WOOHAA3_BASE_PATH: basePath,
      WOOHAA3_PAGE_TITLE: resolveAppPageTitle(serviceEnv),
      WOOHAA3_BACKEND_URL: backendUrl
    }
  }));

  if (watch) {
    hostWatch = startHostWatch({
      repoRoot: root,
      backendDir,
      env: { ...serviceEnv, ...process.env },
      log: (event) => {
        if (event.event === "rebuild-failed") {
          console.warn(`[dev] ${event.target} 本轮重建已中止（跳过剩余步骤），继续监听后续变化`);
          return;
        }
        const where = event.root ? ` ${path.relative(root, event.root)}` : "";
        console.warn(`[dev] ${event.event}${where}${event.message ? `：${event.message}` : ""}`);
      },
      runStep: rebuildStep
    });
    console.log(`[dev] 宿主 watch：${hostWatch.roots.length} 个源码根（--no-watch 关闭）；改宿主代码自动重建，宿主按需重启`);
  }
}

main().catch(async (error) => {
  console.error(`[dev] ${error.message}`);
  await stop(1);
});
