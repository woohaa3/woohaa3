/**
 * 开发端口守卫：`scripts/dev.mjs` 启动前探测前后端端口，避免把「残留 dev 会话占着端口」
 * 误报成构建失败。
 *
 * 设计要点：
 * - 占用判定用「自己能不能 bind」而不是连一下或读 /proc：与真实启动语义一致（vite --strictPort
 *   与后端 listen 都是 bind），且不依赖 lsof/ss 是否安装。
 * - 解析占用进程才需要 lsof（macOS 自带）或 ss/netstat（Linux），只用于给出可读诊断与 `--free-port`。
 * - 只结束**监听该端口**的进程；先 SIGTERM，超时再 SIGKILL。残留的 `scripts/dev.mjs` 监听到前端
 *   退出后会自行收掉后端，因此通常 SIGTERM 一次即可整棵会话退出。
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";

/** vite 监听通配地址；用它判定端口是否还能被本进程占用。 */
const WILDCARD_HOST = "0.0.0.0";
const POLL_INTERVAL_MS = 100;

export function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", timeout: 5000, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

/** `lsof -t` 输出：每行一个 PID。 */
export function parseLsofPids(stdout) {
  const pids = new Set();
  for (const line of String(stdout).split("\n")) {
    const value = line.trim();
    if (/^\d+$/.test(value)) pids.add(Number(value));
  }
  return [...pids];
}

/** `ss -ltnp 'sport = :PORT'` 输出：`users:(("MainThread",pid=3695537,fd=30))`。 */
export function parseSsListeners(stdout) {
  const listeners = new Map();
  for (const line of String(stdout).split("\n")) {
    if (!/^\s*LISTEN\b/.test(line)) continue;
    const pattern = /\(\("([^"]*)",pid=(\d+)/g;
    for (const match of line.matchAll(pattern)) {
      listeners.set(Number(match[2]), match[1]);
    }
  }
  return [...listeners].map(([pid, name]) => ({ pid, name }));
}

/** Windows `netstat -ano`：本地地址以 :PORT 结尾且状态为 LISTENING，最后一列是 PID。 */
export function parseWindowsNetstat(stdout, port) {
  const listeners = new Map();
  const suffix = `:${port}`;
  for (const line of String(stdout).split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || !/^TCP/i.test(columns[0])) continue;
    const [, localAddress, , state, pid] = columns;
    if (!localAddress?.endsWith(suffix) || !/^LISTENING$/i.test(state) || !/^\d+$/.test(pid)) continue;
    listeners.set(Number(pid), "");
  }
  return [...listeners].map(([pid, name]) => ({ pid, name }));
}

async function describeProcess(pid, { platform = process.platform, run = execFileAsync } = {}) {
  try {
    const raw = platform === "linux"
      ? await readFile(`/proc/${pid}/cmdline`, "utf8")
      : await run("ps", ["-p", String(pid), "-o", "command="]);
    return raw.replace(/\0/g, " ").trim();
  } catch {
    return "";
  }
}

/**
 * 解析监听指定端口的进程。lsof 缺失时退回 ss（Linux），再退回 netstat（Windows）。
 * 返回 `[{ pid, command }]`；无法解析时返回空数组（端口仍可能被占用）。
 */
export async function findPortOwners(port, { platform = process.platform, run = execFileAsync } = {}) {
  let listeners = [];
  if (platform === "win32") {
    listeners = await parseWindowsNetstat(await run("netstat", ["-ano"]), port);
  } else {
    try {
      listeners = parseLsofPids(await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])).map((pid) => ({ pid }));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        listeners = parseSsListeners(await run("ss", ["-ltnp", `sport = :${port}`]));
      } catch (fallbackError) {
        if (fallbackError.code !== "ENOENT") throw fallbackError;
        const output = await run("netstat", ["-ltnp"]).catch(() => "");
        listeners = parseSsListeners(output);
      }
    }
  }
  return Promise.all(
    listeners.map(async (listener) => ({ ...listener, command: await describeProcess(listener.pid, { platform, run }) }))
  );
}

/** 端口能否被本进程 bind：等价于「启动时会不会 EADDRINUSE」。 */
export function canBindPort(port, host = WILDCARD_HOST) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen({ port, host, exclusive: true });
  });
}

export function waitForPortFree(port, timeoutMs = 3000, { host = WILDCARD_HOST } = {}) {
  const deadline = Date.now() + timeoutMs;
  return (async function poll() {
    if (await canBindPort(port, host)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    return poll();
  })();
}

/**
 * 结束监听该端口的进程，直到端口可 bind。
 * 返回 `{ port, freed, killed }`；无法解析出占用进程但端口仍被占用时抛错。
 */
export async function freePort(port, {
  log = () => {},
  platform = process.platform,
  run = execFileAsync,
  kill = process.kill,
  graceMs = 3000,
  forceMs = 2000
} = {}) {
  if (await canBindPort(port)) return { port, freed: true, killed: [] };

  const owners = await findPortOwners(port, { platform, run });
  if (owners.length === 0) {
    throw new Error(`端口 ${port} 被占用，但无法解析占用进程（需要 lsof 或 ss）`);
  }

  const killed = [];
  for (const owner of owners) {
    if (owner.pid === process.pid) continue;
    log(`结束占用 ${port} 的进程 pid ${owner.pid}${owner.command ? `（${owner.command}）` : ""}`);
    try {
      kill(owner.pid, "SIGTERM");
      killed.push(owner.pid);
    } catch (error) {
      if (error.code !== "ESRCH") log(`结束 pid ${owner.pid} 失败：${error.message}`);
    }
  }

  if (await waitForPortFree(port, graceMs)) return { port, freed: true, killed };

  log(`pid ${owners.map((owner) => owner.pid).join("、")} 未在 ${graceMs}ms 内退出，发送 SIGKILL`);
  for (const owner of owners) {
    try {
      kill(owner.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") log(`强制结束 pid ${owner.pid} 失败：${error.message}`);
    }
  }
  return { port, freed: await waitForPortFree(port, forceMs), killed, forced: true };
}
