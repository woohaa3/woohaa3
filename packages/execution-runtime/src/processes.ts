/**
 * 本机子进程监管（从既有 dev supervisor 提升而来）。
 *
 * 只做“按稳定 key 启动/停止/查询子进程 + 转接 stdio 事件”，不认识 Codex/OpenCode 等具体
 * 协议。进程操作统一通过 `proc.*` RPC。
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { hashKey, resolveSpawnTarget, stdioEndpoint } from "./endpoints.js";
import type { ProcessEnsureInput, ProcessEvent, ProcessHandleInfo, ProcessRunRecord } from "./protocol.js";

type Entry = {
  key: string;
  workspaceKey: string;
  adapterId: string;
  owner: string;
  connectionId: string;
  requestId: string | null;
  kind: "http" | "stdio";
  loopbackUrl: string | null;
  stdioPath: string | null;
  httpHeaders?: Record<string, string>;
  child: ChildProcess;
  server?: net.Server;
  socket: net.Socket | null;
  events: ProcessEvent[];
  cursor: number;
  deliveredCursor: number;
  buffer: Buffer[];
  startedAt: number;
};

const keyFor = (input: { adapterId: string; owner: string; connectionId: string }) =>
  `${input.adapterId}\u0000${input.owner}\u0000${input.connectionId}`;

function killTree(child: ChildProcess | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export type ProcessHostOptions = {
  stateDir: string;
  workspaceKey: string;
  logger?: (event: Record<string, unknown>) => void;
};

export class ProcessHost {
  private readonly processes = new Map<string, Entry>();
  private readonly stdioDir: string;
  private readonly journalDir: string;
  private readonly ledgerPath: string;
  private ledger: { version: number; runs: ProcessRunRecord[] };

  constructor(private readonly options: ProcessHostOptions) {
    this.stdioDir = path.join(options.stateDir, "stdio");
    this.journalDir = path.join(options.stateDir, "process-events");
    fs.mkdirSync(this.stdioDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.journalDir, { recursive: true, mode: 0o700 });
    this.ledgerPath = path.join(options.stateDir, "ledger.json");
    this.ledger = this.readLedger();
  }

  private readLedger(): { version: number; runs: ProcessRunRecord[] } {
    try {
      const value = JSON.parse(fs.readFileSync(this.ledgerPath, "utf8")) as { runs?: unknown };
      return value && Array.isArray(value.runs) ? { version: 1, runs: value.runs as ProcessRunRecord[] } : { version: 1, runs: [] };
    } catch {
      return { version: 1, runs: [] };
    }
  }

  private writeLedger(): void {
    const temporary = `${this.ledgerPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.ledger), { mode: 0o600 });
    fs.renameSync(temporary, this.ledgerPath);
  }

  private updateRun(key: string, patch: Partial<ProcessRunRecord>): void {
    const index = this.ledger.runs.findIndex((run) => run.key === key);
    const current = index >= 0 ? this.ledger.runs[index]! : ({ key } as ProcessRunRecord);
    const next = { ...current, ...patch, updatedAt: Date.now() };
    if (index >= 0) this.ledger.runs[index] = next;
    else this.ledger.runs.push(next);
    this.writeLedger();
  }

  private journalPath(key: string): string {
    return path.join(this.journalDir, `${hashKey(key)}.jsonl`);
  }

  private appendEvent(entry: Entry, bytes: Buffer): ProcessEvent {
    entry.cursor += 1;
    const event: ProcessEvent = { cursor: entry.cursor, data: Buffer.from(bytes).toString("base64") };
    entry.events.push(event);
    if (entry.events.length > 2_000) entry.events.shift();
    fs.appendFileSync(this.journalPath(entry.key), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    this.updateRun(entry.key, { cursor: entry.cursor, status: "running", requestId: entry.requestId });
    return event;
  }

  private async freePort(min: number, max: number): Promise<number | null> {
    for (let port = min; port <= max; port += 1) {
      const probe = net.createServer();
      const available = await new Promise<boolean>((resolve) => {
        probe.once("error", () => resolve(false));
        probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => probe.close(() => resolve(true)));
      });
      if (available) return port;
    }
    return null;
  }

  private attachStdio(entry: Entry, socket: net.Socket): void {
    if (entry.socket && !entry.socket.destroyed) entry.socket.destroy();
    entry.socket = socket;
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      if (entry.child.stdin && !entry.child.stdin.destroyed) entry.child.stdin.write(chunk);
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (entry.socket === socket) entry.socket = null;
    });
    for (const event of entry.events) {
      if (event.cursor <= entry.deliveredCursor) continue;
      socket.write(Buffer.from(event.data, "base64"));
      entry.deliveredCursor = event.cursor;
    }
    entry.buffer = [];
  }

  private register(child: ChildProcess, metadata: Omit<Entry, "child" | "socket" | "events" | "cursor" | "deliveredCursor" | "buffer" | "startedAt">): Entry {
    const entry: Entry = {
      ...metadata,
      child,
      socket: null,
      events: [],
      cursor: 0,
      deliveredCursor: 0,
      buffer: [],
      startedAt: Date.now()
    };
    try {
      const saved = fs.readFileSync(this.journalPath(metadata.key), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ProcessEvent);
      entry.events = saved.slice(-2_000);
      entry.cursor = entry.events.at(-1)?.cursor ?? 0;
    } catch { /* first run */ }
    this.processes.set(metadata.key, entry);
    child.stdout?.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      const event = this.appendEvent(entry, bytes);
      if (entry.socket && !entry.socket.destroyed) {
        entry.socket.write(bytes);
        entry.deliveredCursor = event.cursor;
      } else {
        entry.buffer.push(bytes);
        if (entry.buffer.length > 2_000) entry.buffer.shift();
      }
    });
    child.stderr?.on("data", () => undefined);
    child.once("exit", () => {
      if (this.processes.get(metadata.key) === entry) this.processes.delete(metadata.key);
      try { fs.unlinkSync(metadata.stdioPath ?? ""); } catch { /* gone */ }
      this.updateRun(metadata.key, { status: "unknown", pid: child.pid, endedAt: Date.now(), cursor: entry.cursor });
    });
    this.updateRun(metadata.key, { ...metadata, pid: child.pid, status: "running", cursor: 0 });
    this.options.logger?.({ event: "executor-process-started", key: metadata.key, adapterId: metadata.adapterId, pid: child.pid });
    return entry;
  }

  private describe(entry: Entry): ProcessHandleInfo {
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
      startedAt: entry.startedAt
    };
  }

  async ensure(input: ProcessEnsureInput): Promise<ProcessHandleInfo> {
    const key = keyFor(input);
    const existing = this.processes.get(key);
    if (existing && existing.child.exitCode === null) return this.describe(existing);
    if (existing) this.processes.delete(key);
    const command = String(input.command ?? "");
    if (!command) throw new Error("缺少 Agent 可执行文件");
    const childEnv = { ...process.env, ...(input.env ?? {}) } as Record<string, string>;
    let loopbackUrl: string | null = null;
    let httpHeaders: Record<string, string> | undefined;
    const childArgs = [...(input.args ?? [])];
    if (input.kind === "http" && input.adapterId === "opencode-server") {
      const password = crypto.randomBytes(32).toString("hex");
      childEnv.OPENCODE_SERVER_PASSWORD = password;
      httpHeaders = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
    }
    if (input.kind === "http") {
      const port = await this.freePort(Number(input.portMin ?? 42_000), Number(input.portMax ?? 42_100));
      if (port === null) throw new Error("Agent 回环端口已用尽");
      childEnv.PORT = String(port);
      childEnv.HOST = "127.0.0.1";
      childArgs.push("--port", String(port));
      loopbackUrl = `http://127.0.0.1:${port}`;
    }
    const stdioPath = input.kind === "stdio" ? stdioEndpoint({ key, stdioDir: this.stdioDir }) : null;
    if (stdioPath) {
      if (process.platform !== "win32") {
        try { fs.unlinkSync(stdioPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      try { fs.unlinkSync(this.journalPath(key)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const target = resolveSpawnTarget(command, childArgs);
    let child: ChildProcess;
    try {
      child = spawn(target.command, target.args, {
        cwd: input.cwd,
        env: childEnv,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: input.kind === "stdio" ? ["pipe", "pipe", "pipe"] : ["ignore", "ignore", "ignore"],
        ...(target.shell ? { shell: true } : {})
      });
    } catch (error) {
      throw new Error(`无法启动 Agent 可执行文件「${command}」：${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    const entry = this.register(child, {
      key,
      workspaceKey: this.options.workspaceKey,
      adapterId: input.adapterId,
      owner: input.owner,
      connectionId: input.connectionId,
      requestId: input.requestId ?? null,
      kind: input.kind,
      loopbackUrl,
      stdioPath,
      ...(httpHeaders ? { httpHeaders } : {})
    });
    if (stdioPath) {
      const server = net.createServer((socket) => this.attachStdio(entry, socket));
      entry.server = server;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(stdioPath, () => resolve());
      });
    }
    return this.describe(entry);
  }

  list(): ProcessHandleInfo[] {
    return [...this.processes.values()].map((entry) => this.describe(entry));
  }

  query(input: string | { requestId?: string; adapterId?: string; owner?: string; connectionId?: string }): ProcessRunRecord | null {
    if (typeof input !== "string" && input.requestId) {
      return this.ledger.runs.find((run) => run.requestId === input.requestId) ?? null;
    }
    const key = typeof input === "string" ? input : keyFor(input as { adapterId: string; owner: string; connectionId: string });
    return this.ledger.runs.find((run) => run.key === key) ?? null;
  }

  events(input: string | { key?: string; adapterId?: string; owner?: string; connectionId?: string }, after = 0): { key: string; events: ProcessEvent[]; cursor: number } {
    const key = typeof input === "string" ? input : typeof input.key === "string" ? input.key : keyFor(input as { adapterId: string; owner: string; connectionId: string });
    const entry = this.processes.get(key);
    let events = entry?.events ?? [];
    if (!entry) {
      try {
        events = fs.readFileSync(this.journalPath(key), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ProcessEvent);
        if (events.length > 2_000) events = events.slice(-2_000);
      } catch { events = []; }
    }
    return {
      key,
      events: events.filter((event) => event.cursor > after),
      cursor: entry?.cursor ?? this.ledger.runs.find((run) => run.key === key)?.cursor ?? after
    };
  }

  async stop(input: string | { adapterId: string; owner: string; connectionId: string }): Promise<void> {
    const key = typeof input === "string" ? input : keyFor(input);
    const entry = this.processes.get(key);
    if (!entry) return;
    this.processes.delete(key);
    this.updateRun(key, { status: "stopping", endedAt: Date.now() });
    entry.server?.close();
    entry.socket?.destroy();
    killTree(entry.child, "SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      entry.child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    killTree(entry.child, "SIGKILL");
    try { fs.unlinkSync(entry.stdioPath ?? ""); } catch { /* gone */ }
    this.updateRun(key, { status: "stopped", endedAt: Date.now() });
    this.options.logger?.({ event: "executor-process-stopped", key });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.processes.keys()].map((key) => this.stop(key)));
  }
}
