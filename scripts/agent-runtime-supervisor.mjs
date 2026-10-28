#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const value = process.argv[i];
  if (value?.startsWith("--")) args.set(value.slice(2), process.argv[i + 1] ?? "");
}
const socketPath = args.get("socket");
const stateDir = args.get("state");
const token = args.get("token");
const workspaceKey = args.get("workspace");
const ownerPid = Number(args.get("owner-pid") || 0);
if (!socketPath || !stateDir || !token || !workspaceKey) throw new Error("agent runtime supervisor 参数不完整");

fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const stdioDir = path.join(stateDir, "stdio");
fs.mkdirSync(stdioDir, { recursive: true, mode: 0o700 });
try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
const ledgerPath = path.join(stateDir, "ledger.json");
const journalDir = path.join(stateDir, "events");
fs.mkdirSync(journalDir, { recursive: true, mode: 0o700 });

function readLedger() {
  try {
    const value = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    return value && typeof value === "object" && Array.isArray(value.runs) ? value : { version: 1, runs: [] };
  } catch { return { version: 1, runs: [] }; }
}
let ledger = readLedger();
function writeLedger() {
  const temporary = `${ledgerPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(ledger), { mode: 0o600 });
  fs.renameSync(temporary, ledgerPath);
}
function updateRun(key, patch) {
  const index = ledger.runs.findIndex(run => run.key === key);
  const current = index >= 0 ? ledger.runs[index] : { key };
  const next = { ...current, ...patch, updatedAt: Date.now() };
  if (index >= 0) ledger.runs[index] = next;
  else ledger.runs.push(next);
  writeLedger();
  return next;
}
function journalPath(key) { return path.join(journalDir, `${safeKey(key)}.jsonl`); }
function appendEvent(entry, bytes) {
  entry.cursor = (entry.cursor ?? 0) + 1;
  const event = { cursor: entry.cursor, data: Buffer.from(bytes).toString("base64") };
  entry.events.push(event);
  if (entry.events.length > 2000) entry.events.shift();
  fs.appendFileSync(journalPath(entry.key), `${JSON.stringify(event)}\n`, { mode: 0o600 });
  updateRun(entry.key, { cursor: entry.cursor, status: "running", requestId: entry.requestId ?? null });
  return event;
}

const processes = new Map();
const clients = new Set();
let stopping = false;
let nextId = 1;
let orphanTimer = null;

const safeKey = value => crypto.createHash("sha256").update(value).digest("hex").slice(0, 40);
const keyFor = input => `${input.adapterId}\u0000${input.owner}\u0000${input.connectionId}`;

/**
 * stdio 通道的端点。Windows 没有 Unix domain socket 的文件语义 —— `server.listen(<文件路径>)`
 * 直接 EACCES、回调永不触发，所以那边改用命名管道（与 dev 的 supervisor socket 同一处理）。
 * 端点字符串原样交给客户端 `connect()`，两种形态它都支持。
 */
const stdioEndpoint = key =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\woohaa-agent-stdio-${safeKey(key)}`
    : path.join(stdioDir, `${safeKey(key)}.sock`);

/**
 * Windows 上 npm/pnpm 装的 CLI 是 `.cmd` 垫片，`spawn()` 直接执行会抛 EINVAL。
 * 与 `web/extensions/local-agent/src/backend/process-supervisor.ts` 同一处理：
 * 引号包住命令并交给 shell。
 */
const isBatchCommand = command => process.platform === "win32" && /\.(cmd|bat)$/i.test(command);

function killTree(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) { if (error.code !== "ESRCH") throw error; }
}

async function freePort(min, max) {
  for (let port = min; port <= max; port += 1) {
    const probe = net.createServer();
    const available = await new Promise(resolve => {
      probe.once("error", () => resolve(false));
      probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => probe.close(() => resolve(true)));
    });
    if (available) return port;
  }
  return null;
}

function attachStdio(entry, socket) {
  if (entry.socket && !entry.socket.destroyed) entry.socket.destroy();
  entry.socket = socket;
  socket.setNoDelay(true);
  socket.on("data", chunk => {
    if (!entry.child.stdin?.destroyed) entry.child.stdin.write(chunk);
  });
  socket.on("error", () => undefined);
  socket.on("close", () => { if (entry.socket === socket) entry.socket = null; });
  // A backend reconnect must receive the live stream, while the child stdin remains open
  // across backend reloads. The protocol is JSONL, so a raw byte proxy is sufficient.
  for (const event of entry.events) {
    if (event.cursor <= (entry.deliveredCursor ?? 0)) continue;
    socket.write(Buffer.from(event.data, "base64"));
    entry.deliveredCursor = event.cursor;
  }
  entry.buffer = [];
}

function registerChild(input, child, metadata) {
  const entry = { ...metadata, child, socket: null, buffer: [], events: [], cursor: 0, deliveredCursor: 0, startedAt: Date.now() };
  try {
    const saved = fs.readFileSync(journalPath(metadata.key), "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    entry.events = saved.slice(-2000);
    entry.cursor = entry.events.at(-1)?.cursor ?? 0;
  } catch { /* first run has no journal */ }
  processes.set(metadata.key, entry);
  child.stdout?.on("data", chunk => {
    const bytes = Buffer.from(chunk);
    const event = appendEvent(entry, bytes);
    if (entry.socket && !entry.socket.destroyed) {
      entry.socket.write(bytes);
      entry.deliveredCursor = event.cursor;
    }
    else {
      entry.buffer.push(bytes);
      if (entry.buffer.length > 2000) entry.buffer.shift();
    }
  });
  child.stderr?.on("data", () => undefined);
  child.once("exit", () => {
    if (processes.get(metadata.key) === entry) processes.delete(metadata.key);
    try { fs.unlinkSync(metadata.stdioPath); } catch { /* already gone */ }
    updateRun(metadata.key, { status: "unknown", pid: metadata.pid, endedAt: Date.now(), cursor: entry.cursor });
  });
  updateRun(metadata.key, { ...metadata, pid: child.pid, status: "running", cursor: 0 });
  return entry;
}

async function ensure(input) {
  const key = keyFor(input);
  const existing = processes.get(key);
  if (existing && existing.child.exitCode === null) return describe(existing);
  if (existing) processes.delete(key);
  const command = String(input.command || "");
  if (!command) throw new Error("缺少 Agent 可执行文件");
  const childEnv = { ...process.env, ...(input.env ?? {}) };
  let loopbackUrl = null;
  const childArgs = [...(input.args ?? [])];
  if (input.kind === "http") {
    const port = await freePort(Number(input.portMin ?? 42000), Number(input.portMax ?? 42100));
    if (port === null) throw new Error("Agent 回环端口已用尽");
    childEnv.PORT = String(port);
    childEnv.HOST = "127.0.0.1";
    childArgs.push("--port", String(port));
    loopbackUrl = `http://127.0.0.1:${port}`;
  }
  const stdioPath = input.kind === "stdio" ? stdioEndpoint(key) : null;
  if (stdioPath) {
    try { fs.unlinkSync(stdioPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    try { fs.unlinkSync(journalPath(key)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const batch = isBatchCommand(command);
  const child = spawn(batch ? `"${command}"` : command, batch ? childArgs.map(arg => (arg === "" ? '""' : arg)) : childArgs, {
    cwd: input.cwd,
    env: childEnv,
    windowsHide: true,
    detached: process.platform !== "win32",
    // `.cmd` 垫片只能经 cmd.exe 执行；shell 模式下参数按空格拼接，空参数要显式写成 ""
    ...(batch ? { shell: true } : {}),
    stdio: input.kind === "stdio" ? ["pipe", "pipe", "pipe"] : ["ignore", "ignore", "ignore"]
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const metadata = { key, workspaceKey, adapterId: input.adapterId, owner: input.owner, connectionId: input.connectionId, requestId: input.requestId ?? null, kind: input.kind, loopbackUrl, stdioPath, httpHeaders: input.httpHeaders };
  const entry = registerChild(input, child, metadata);
  if (stdioPath) {
    const server = net.createServer(socket => attachStdio(entry, socket));
    entry.server = server;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(stdioPath, resolve);
    });
  }
  return describe(entry);
}

function describe(entry) {
  return {
    key: entry.key,
    adapterId: entry.adapterId,
    owner: entry.owner,
    connectionId: entry.connectionId,
    kind: entry.kind,
    loopbackUrl: entry.loopbackUrl,
    ...(entry.httpHeaders ? { httpHeaders: entry.httpHeaders } : {}),
    stdioPath: entry.stdioPath,
    pid: entry.child.pid,
    startedAt: entry.startedAt,
  };
}

async function stop(input) {
  const key = typeof input === "string" ? input : keyFor(input);
  const entry = processes.get(key);
  if (!entry) return;
  processes.delete(key);
  updateRun(key, { status: "stopping", endedAt: Date.now() });
  entry.server?.close();
  entry.socket?.destroy();
  killTree(entry.child, "SIGTERM");
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 3000);
    entry.child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  killTree(entry.child, "SIGKILL");
  try { fs.unlinkSync(entry.stdioPath); } catch { /* already gone */ }
  updateRun(key, { status: "stopped", endedAt: Date.now() });
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  await Promise.all([...processes.keys()].map(stop));
  server.close(() => process.exit(0));
}

function reply(socket, id, result, error) {
  socket.write(`${JSON.stringify({ id, ok: !error, ...(error ? { error: error.message } : { result }) })}\n`);
}

async function dispatch(socket, request) {
  if (request.token !== token || request.workspaceKey !== workspaceKey) throw new Error("Supervisor 身份校验失败");
  switch (request.method) {
    case "ping": return { workspaceKey, pid: process.pid, generation: 1, count: processes.size };
    case "ensure": return ensure(request.params);
    case "query": {
      if (request.params?.requestId) return ledger.runs.find(run => run.requestId === request.params.requestId) ?? null;
      const key = typeof request.params === "string" ? request.params : keyFor(request.params);
      return ledger.runs.find(run => run.key === key) ?? null;
    }
    case "events": {
      const key = typeof request.params?.key === "string" ? request.params.key : keyFor(request.params);
      const after = Number(request.params?.after ?? 0);
      const entry = processes.get(key);
      let events = entry ? entry.events : [];
      if (!entry) {
        try {
          events = fs.readFileSync(journalPath(key), "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
          if (events.length > 2000) events = events.slice(-2000);
        } catch { events = []; }
      }
      return { key, events: events.filter(event => event.cursor > after), cursor: entry?.cursor ?? ledger.runs.find(run => run.key === key)?.cursor ?? after };
    }
    case "stop": return stop(request.params);
    case "stopAll": await Promise.all([...processes.keys()].map(stop)); return { stopped: true };
    case "shutdown": await shutdown(); return { shuttingDown: true };
    default: throw new Error(`未知 Supervisor 方法：${request.method}`);
  }
}

const server = net.createServer(socket => {
  clients.add(socket);
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", chunk => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let request;
      try { request = JSON.parse(line); } catch { continue; }
      void dispatch(socket, request).then(result => reply(socket, request.id, result), error => reply(socket, request.id, null, error));
    }
  });
  socket.once("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
});

// The dev launcher is the lifecycle owner.  A backend reload never reaches
// this process, while an abruptly dead launcher eventually gets cleaned up.
// Keep a grace period so a short launcher restart does not kill an active turn.
if (ownerPid > 0) {
  const ownerAlive = () => {
    try { process.kill(ownerPid, 0); return true; } catch (error) { return error.code === "EPERM"; }
  };
  const checkOwner = () => {
    if (stopping || ownerAlive()) return;
    if (!orphanTimer) orphanTimer = setTimeout(() => void shutdown(), 15_000);
  };
  setInterval(checkOwner, 2_000).unref();
}

server.listen(socketPath, () => {
  fs.writeFileSync(path.join(stateDir, "supervisor.json"), JSON.stringify({ workspaceKey, pid: process.pid, socketPath, generation: 1, startedAt: Date.now() }));
});
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
