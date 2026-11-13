import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { windowsWorkspaceJob } from "./workspace-windows-job.js";
import { decodeCanvasWorkspaceHandle } from "@woohaa3/contracts";
import type {
  CanvasWorkspaceHandle, CanvasWorkspacePort, CanvasWorkspaceSettings,
  WorkspaceExecution, WorkspaceExecuteInput, WorkspaceMigration, WorkspaceOutput
} from "@woohaa3/contracts";

type Lease = { handle: CanvasWorkspaceHandle; status: "active" | "terminal" | "unknown" | "cancelled" };
type Execution = WorkspaceExecution & { handle: CanvasWorkspaceHandle; digest: string; pid?: number };
type MigrationPlan = { inventory: Record<string, string>; published: string[]; identities?: Record<string, { dev: number; ino: number }> };
type State = {
  version: 1; rootPath: string; rootRevision: number; generation: number;
  directories: Record<string, { owner: string; canvasId: string }>;
  leases: Record<string, Lease>; executions: Record<string, Execution>;
  migrations: Record<string, WorkspaceMigration>; migrationId?: string; plans?: Record<string, MigrationPlan>;
};
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
const inside = (root: string, target: string) => target === root || (!path.relative(root, target).startsWith(`..${path.sep}`) && path.relative(root, target) !== ".." && !path.isAbsolute(path.relative(root, target)));
const activePhase = (migration?: WorkspaceMigration) => !!migration && !["completed", "failed", "cancelled"].includes(migration.phase);
const activeExecution = (e: Execution) => ["queued", "running", "cancel-requested", "unknown"].includes(e.status);

/** One authority in the daemon owns directory leases, files and auxiliary processes. */
export class CanvasWorkspaces implements CanvasWorkspacePort {
  private readonly stateFile: string;
  private readonly eventsDir: string;
  private readonly installation: string;
  private state: State;
  private children = new Map<string, { child: ChildProcess; done: Promise<void> }>();
  private migrationWork: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly options: { stateDir: string; defaultRoot: string; profileKey: string; protectedPaths?: string[] }) {
    fs.mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    this.stateFile = path.join(options.stateDir, "canvas-workspaces.json");
    this.eventsDir = path.join(options.stateDir, "workspace-output");
    fs.mkdirSync(this.eventsDir, { recursive: true, mode: 0o700 });
    this.installation = hash(options.profileKey);
    if (fs.existsSync(this.stateFile)) {
      this.state = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as State;
      this.validateState();
      for (const e of Object.values(this.state.executions)) if (activeExecution(e)) {
        e.status = "unknown";
        e.error = "执行器重启，无法证明原进程终态；不会自动重跑";
      }
      for (const lease of Object.values(this.state.leases)) if (lease.status === "active") lease.status = "unknown";
    } else {
      fs.mkdirSync(options.defaultRoot, { recursive: true, mode: 0o700 });
      this.state = { version: 1, rootPath: fs.realpathSync(options.defaultRoot), rootRevision: 1, generation: 1, directories: {}, leases: {}, executions: {}, migrations: {} };
    }
    // User operation IDs may be arbitrary strings, including Object prototype names.
    for (const key of ["directories", "leases", "executions", "migrations", "plans"] as const) {
      if (this.state[key]) Object.setPrototypeOf(this.state[key]!, null);
    }
    this.recoverMigration();
    this.persist();
    this.resumeMigration();
  }

  private validateState(): void {
    const s = this.state;
    const valid = (ok: unknown) => { if (!ok) fail("workspace-unavailable", "工作目录持久状态损坏，保留原文件等待恢复"); };
    const record = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
    const key = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
    const identity = (h: CanvasWorkspaceHandle) => key(h.directoryKey) && h.directoryKey === hash(JSON.stringify([this.installation, h.owner, h.canvasId])) && h.runKey === hash(JSON.stringify([h.owner, h.requestId]));
    valid(record(s) && s.version === 1 && typeof s.rootPath === "string" && path.isAbsolute(s.rootPath) && !s.rootPath.includes("\0") && Number.isSafeInteger(s.rootRevision) && s.rootRevision > 0 && Number.isSafeInteger(s.generation) && s.generation > 0);
    valid(record(s.directories) && record(s.leases) && record(s.executions) && record(s.migrations) && (s.plans === undefined || record(s.plans)));
    for (const [directoryKey, d] of Object.entries(s.directories)) valid(key(directoryKey) && record(d) && typeof d.owner === "string" && typeof d.canvasId === "string" && directoryKey === hash(JSON.stringify([this.installation, d.owner, d.canvasId])));
    for (const [leaseKey, l] of Object.entries(s.leases)) valid(record(l) && decodeCanvasWorkspaceHandle(l.handle) && identity(l.handle) && leaseKey === this.leaseKey(l.handle) && ["active", "terminal", "unknown", "cancelled"].includes(l.status));
    for (const [executionId, e] of Object.entries(s.executions)) valid(record(e) && key(executionId) && e.executionId === executionId && key(e.digest) && decodeCanvasWorkspaceHandle(e.handle) && identity(e.handle) && e.requestId === e.handle.requestId && ["queued", "running", "cancel-requested", "exited", "failed", "interrupted", "unknown"].includes(e.status) && Number.isSafeInteger(e.cursor) && e.cursor >= 0);
    for (const [operationId, m] of Object.entries(s.migrations)) valid(record(m) && m.operationId === operationId && typeof m.source === "string" && path.isAbsolute(m.source) && typeof m.target === "string" && path.isAbsolute(m.target) && ["validating", "waiting-for-idle", "copying", "verifying", "switching", "completed", "failed", "recovering", "cancelled"].includes(m.phase) && Number.isSafeInteger(m.expectedRootRevision) && m.expectedRootRevision > 0);
    valid(s.migrationId === undefined || (typeof s.migrationId === "string" && Object.hasOwn(s.migrations, s.migrationId)));
    for (const [operationId, p] of Object.entries(s.plans ?? {})) {
      valid(Object.hasOwn(s.migrations, operationId) && record(p) && record(p.inventory) && Array.isArray(p.published));
      valid(p.published.every(k => key(k) && Object.hasOwn(s.directories, k)));
      for (const [relative, digest] of Object.entries(p.inventory)) valid(!path.isAbsolute(relative) && !relative.includes("\0") && !relative.split(/[\\/]/).includes("..") && (digest === "directory" || key(digest)));
      for (const [directoryKey, id] of Object.entries(p.identities ?? {})) valid(key(directoryKey) && record(id) && Number.isFinite(id.dev) && Number.isFinite(id.ino));
    }
  }

  private persist(): void {
    const temp = `${this.stateFile}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      try { fs.writeFileSync(fd, JSON.stringify(this.state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, this.stateFile);
      // Windows does not expose directory fsync; the replaced file is already flushed.
      if (process.platform !== "win32") {
        const directory = fs.openSync(path.dirname(this.stateFile), "r");
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
    } finally { fs.rmSync(temp, { force: true }); }
  }
  private leaseKey(h: Pick<CanvasWorkspaceHandle, "owner" | "canvasId" | "requestId">) { return hash(JSON.stringify([h.owner, h.canvasId, h.requestId])); }
  private directory(h: CanvasWorkspaceHandle): string { return path.join(this.state.rootPath, h.directoryKey); }
  private migration() { return this.state.migrationId ? this.state.migrations[this.state.migrationId] : undefined; }
  settings(): CanvasWorkspaceSettings {
    const migration = this.migration();
    const blocked = migration?.phase === "waiting-for-idle" && (Object.values(this.state.leases).some(l => l.status === "unknown") || Object.values(this.state.executions).some(e => e.status === "unknown"));
    return structuredClone({ available: true, rootPath: this.state.rootPath, rootRevision: this.state.rootRevision, generation: this.state.generation, ...(migration ? { migration: { ...migration, ...(blocked ? { error: "存在状态未知的回合或进程，无法确认已排空；请先核对任务状态，或取消本次迁移。" } : {}) } } : {}) });
  }
  location(input: { owner: string; canvasId: string }): string {
    const key = hash(JSON.stringify([this.installation, input.owner, input.canvasId]));
    if (!this.state.directories[key]) fail("workspace-unavailable", "该画布尚未创建工作目录");
    return path.join(this.state.rootPath, key);
  }
  private check(h: CanvasWorkspaceHandle, allowTerminal = false): Lease {
    if (!decodeCanvasWorkspaceHandle(h)) fail("workspace-forbidden", "工作目录授权格式无效");
    const lease = this.state.leases[this.leaseKey(h)];
    if (!lease || Object.entries(lease.handle).some(([key, value]) => h[key as keyof CanvasWorkspaceHandle] !== value)) fail("workspace-forbidden", "工作目录授权不匹配");
    if (h.generation !== this.state.generation) fail("workspace-stale", "工作目录位置已改变");
    if (!allowTerminal && lease.status !== "active") fail("workspace-forbidden", "回合工作目录授权已结束");
    if (!fs.existsSync(this.state.rootPath) || fs.realpathSync(this.state.rootPath) !== this.state.rootPath) fail("workspace-unavailable", "工作目录位置不可用或已变更");
    const base = this.directory(h);
    if (!fs.existsSync(base) || fs.lstatSync(base).isSymbolicLink() || fs.realpathSync(base) !== base) fail("workspace-path-invalid", "画布目录已被替换或指向链接");
    return lease;
  }
  leases() { return Object.values(this.state.leases).map(({ handle, status }) => ({ owner: handle.owner, canvasId: handle.canvasId, requestId: handle.requestId, status })); }
  lookup(input: { owner: string; canvasId: string; requestId: string }): CanvasWorkspaceHandle {
    const lease = this.state.leases[this.leaseKey(input)];
    if (!lease) fail("workspace-forbidden", "回合未取得工作目录授权");
    this.check(lease.handle);
    return structuredClone(lease.handle);
  }
  /** Trusted host recovery only: never re-runs commands or clears unknown executions. */
  async settle(input: { owner: string; canvasId: string; requestId: string; outcome: "terminal" | "unknown" | "cancelled" | "active" }): Promise<void> {
    const lease = this.state.leases[this.leaseKey(input)];
    if (!lease) return;
    if (lease.handle.generation !== this.state.generation) return;
    if (!["terminal", "unknown", "cancelled", "active"].includes(input.outcome)) fail("workspace-forbidden", "回合结算状态非法");
    if (input.outcome === "active" && !["active", "unknown"].includes(lease.status)) fail("workspace-forbidden", "终态回合不可重新授权");
    lease.status = input.outcome;
    this.persist();
    if (input.outcome === "cancelled") for (const e of Object.values(this.state.executions)) {
      if (this.leaseKey(e.handle) === this.leaseKey(lease.handle) && activeExecution(e)) await this.stop(lease.handle, e.executionId);
    }
    this.resumeMigration();
  }
  async acquire(input: { owner: string; canvasId: string; requestId: string }): Promise<CanvasWorkspaceHandle> {
    if (this.stopped) fail("workspace-unavailable", "执行器正在停止");
    if (![input.owner, input.canvasId, input.requestId].every(x => typeof x === "string" && x.length > 0 && x.length <= 512)) fail("workspace-forbidden", "缺少可信画布回合身份");
    const existing = this.state.leases[this.leaseKey(input)];
    if (existing) { this.check(existing.handle); return structuredClone(existing.handle); }
    if (activePhase(this.migration())) fail("workspace-migrating", "工作目录正在迁移，请稍后重试");
    const directoryKey = hash(JSON.stringify([this.installation, input.owner, input.canvasId]));
    const runKey = hash(JSON.stringify([input.owner, input.requestId]));
    const handle: CanvasWorkspaceHandle = { schemaVersion: 1, ...input, directoryKey, runKey, generation: this.state.generation };
    const base = this.directory(handle);
    const manifest = path.join(base, ".woohaa-workspace.json");
    if (fs.existsSync(base)) {
      if (fs.lstatSync(base).isSymbolicLink() || !fs.existsSync(manifest)) fail("workspace-conflict", "工作目录归属不明");
      const identity = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (identity.installation !== this.installation || identity.owner !== input.owner || identity.canvasId !== input.canvasId) fail("workspace-conflict", "工作目录已属于其他主体");
    } else {
      fs.mkdirSync(base, { mode: 0o700 });
      fs.writeFileSync(manifest, JSON.stringify({ installation: this.installation, owner: input.owner, canvasId: input.canvasId }), { mode: 0o600, flag: "wx" });
    }
    for (const relative of ["shared", `runs/${runKey}`]) {
      const target = this.resolve(handle, relative, true, false);
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    }
    this.state.directories[directoryKey] = { owner: input.owner, canvasId: input.canvasId };
    this.state.leases[this.leaseKey(handle)] = { handle, status: "active" };
    this.persist();
    return structuredClone(handle);
  }
  async release(h: CanvasWorkspaceHandle, outcome: "terminal" | "unknown"): Promise<void> {
    if (!["terminal", "unknown"].includes(outcome)) fail("workspace-forbidden", "回合结算状态非法");
    const lease = this.check(h, true);
    lease.status = outcome;
    this.persist();
    this.resumeMigration();
  }
  async cancel(h: CanvasWorkspaceHandle): Promise<void> {
    const lease = this.check(h, true);
    lease.status = "cancelled";
    this.persist();
    for (const e of Object.values(this.state.executions)) if (this.leaseKey(e.handle) === this.leaseKey(h) && activeExecution(e)) await this.stop(h, e.executionId);
    this.resumeMigration();
  }
  private resolve(h: CanvasWorkspaceHandle, relative: string, missing = false, authorized = true): string {
    if (authorized) this.check(h);
    if (typeof relative !== "string" || relative.includes("\0") || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.includes("\\") || relative.includes(":")) fail("workspace-path-invalid", "需要画布内相对路径");
    const parts = relative.split("/").filter(Boolean);
    if (parts.some(p => p === ".." || p.startsWith(".woohaa"))) fail("workspace-path-invalid", "路径不在可用工作目录内");
    const base = this.directory(h);
    const target = path.resolve(base, ...parts);
    if (!inside(base, target)) fail("workspace-path-invalid", "路径超出画布目录");
    let current = base;
    for (const part of parts) {
      current = path.join(current, part);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(current); }
      catch (error) { if (missing && (error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (stat.isSymbolicLink() || !inside(base, fs.realpathSync(current)) || (!stat.isDirectory() && !stat.isFile())) fail("workspace-path-invalid", "不允许链接或特殊文件路径");
    }
    return target;
  }
  async list(h: CanvasWorkspaceHandle, relative = ".") {
    const target = this.resolve(h, relative);
    return fs.readdirSync(target, { withFileTypes: true }).filter(e => !e.name.startsWith(".woohaa") && !e.isSymbolicLink()).map(e => ({ path: path.posix.join(relative, e.name), kind: e.isDirectory() ? "directory" as const : "file" as const, size: fs.lstatSync(path.join(target, e.name)).size }));
  }
  async read(h: CanvasWorkspaceHandle, relative: string) {
    const target = this.resolve(h, relative);
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) fail("workspace-io-failed", "需要不超过 4 MiB 的普通文件，请使用脚本处理或分片");
      const bytes = fs.readFileSync(fd);
      return { content: bytes.toString("utf8"), hash: hash(bytes) };
    } finally { fs.closeSync(fd); }
  }
  async assetBytes(h: CanvasWorkspaceHandle, relative: string) {
    const target = this.resolve(h, relative);
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) fail("workspace-io-failed", "资产导入需要不超过 64 MiB 的普通文件");
      return { bytesBase64: fs.readFileSync(fd).toString("base64"), fileName: path.basename(target) };
    } finally { fs.closeSync(fd); }
  }
  async mkdir(h: CanvasWorkspaceHandle, relative: string) { fs.mkdirSync(this.resolve(h, relative, true), { recursive: true, mode: 0o700 }); }
  async write(h: CanvasWorkspaceHandle, input: { path: string; content: string; expectedHash?: string | null }) {
    const target = this.resolve(h, input.path, true);
    if (input.expectedHash !== undefined) {
      let before: string | null = null;
      if (fs.existsSync(target)) {
        const digest = createHash("sha256"), fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        try {
          if (!fs.fstatSync(fd).isFile()) fail("workspace-path-invalid", "目标不是普通文件");
          const buffer = Buffer.allocUnsafe(64 * 1024);
          let size: number;
          while ((size = fs.readSync(fd, buffer)) > 0) digest.update(buffer.subarray(0, size));
          before = digest.digest("hex");
        } finally { fs.closeSync(fd); }
      }
      if (input.expectedHash !== before) fail("workspace-conflict", "文件已被其他操作修改");
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, input.content, { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, target); }
    finally { fs.rmSync(temporary, { force: true }); }
    return { hash: hash(input.content) };
  }

  async execute(h: CanvasWorkspaceHandle, input: WorkspaceExecuteInput): Promise<WorkspaceExecution> {
    this.check(h);
    if (typeof input.operationId !== "string" || typeof input.command !== "string" || !input.operationId || !input.command || input.command.includes("\0") || input.operationId.length > 256 || (input.args !== undefined && (!Array.isArray(input.args) || input.args.some(a => typeof a !== "string" || a.includes("\0")))) || (input.shell !== undefined && typeof input.shell !== "boolean")) fail("workspace-conflict", "命令或操作身份无效");
    const executionId = hash(JSON.stringify([this.leaseKey(h), input.operationId]));
    const digest = hash(JSON.stringify({ command: input.command, args: input.args ?? [], cwd: input.cwd ?? `runs/${h.runKey}`, shell: input.shell ?? false }));
    const prior = this.state.executions[executionId];
    if (prior) {
      if (prior.digest !== digest) fail("workspace-conflict", "同一操作身份对应不同命令");
      return this.view(prior);
    }
    const cwd = this.resolve(h, input.cwd ?? `runs/${h.runKey}`);
    const now = new Date().toISOString();
    const execution: Execution = { executionId, requestId: h.requestId, handle: structuredClone(h), digest, status: "queued", createdAt: now, updatedAt: now, cursor: 0 };
    this.state.executions[executionId] = execution;
    this.persist();
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];
    let command = input.command === "node" ? process.execPath : input.command;
    if (process.platform === "win32" && !input.shell) {
      const candidates = /[\\/]/.test(command) ? [path.resolve(cwd, command)] : (env.PATH ?? "").split(path.delimiter).map(directory => path.join(directory, command));
      const found = candidates.flatMap(candidate => path.extname(candidate) ? [candidate] : [candidate, ...(env.PATHEXT ?? ".EXE;.COM").split(";").map(ext => candidate + ext)])
        .find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } });
      if (!found) { execution.status = "failed"; execution.error = "runtime-missing"; this.persist(); return this.view(execution); }
      command = found;
    }
    const control = path.join(this.eventsDir, executionId);
    const target = process.platform === "win32" ? windowsWorkspaceJob({ command, args: input.args ?? [], cwd, env, shell: input.shell ?? false, control }) : { command, args: input.args ?? [] };
    let child: ChildProcess;
    try {
      child = spawn(target.command, target.args, { cwd, env, shell: process.platform !== "win32" && (input.shell ?? false), windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      execution.status = "failed"; execution.error = String(error); this.persist(); return this.view(execution);
    }
    execution.pid = child.pid;
    execution.status = "running";
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    let outputFailed = false;
    const append = (stream: WorkspaceOutput["stream"], text: string) => {
      if (!text || outputFailed) return;
      try {
        const event: WorkspaceOutput = { cursor: execution.cursor + 1, stream, text };
        const fd = fs.openSync(path.join(this.eventsDir, `${executionId}.jsonl`), "a", 0o600);
        try { fs.writeFileSync(fd, `${JSON.stringify(event)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        execution.cursor = event.cursor;
        this.persist();
      } catch (error) {
        // Output callbacks must not crash the daemon on ENOSPC/EACCES. Stop the
        // execution and preserve an explicit failure instead of losing output silently.
        outputFailed = true;
        execution.error = `保存执行输出失败：${String(error)}`;
        if (child.pid) {
          if (process.platform === "win32") {
            try { fs.writeFileSync(`${control}.stop`, "stop"); }
            catch { child.kill(); } // KILL_ON_JOB_CLOSE still owns the descendants.
          } else { try { process.kill(-child.pid, "SIGKILL"); } catch { /* final drain determines certainty */ } }
        }
      }
    };
    if (process.platform !== "win32") child.once("exit", () => {
      // Descendants can inherit the pipes. Waiting for `close` before draining
      // would then wait forever, even though the command itself has exited.
      if (child.pid) try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") execution.error = String(error); }
    });
    child.stdout?.on("data", b => append("stdout", decoders.stdout.write(b)));
    child.stderr?.on("data", b => append("stderr", decoders.stderr.write(b)));
    const done = new Promise<void>(resolve => {
      child.once("error", error => { execution.error = (error as NodeJS.ErrnoException).code === "ENOENT" ? "runtime-missing" : error.message; });
      child.once("close", async (code, signal) => {
        append("stdout", decoders.stdout.end()); append("stderr", decoders.stderr.end());
        let finalStatus: WorkspaceExecution["status"] = !execution.error && code === 0 ? "exited" : "failed";
        execution.exitCode = code; execution.signal = signal; execution.updatedAt = new Date().toISOString();
        // A script may exit after leaving background descendants. They must drain
        // before its directory can be migrated or cleaned.
        if (process.platform === "win32") {
          try {
            const receipt = JSON.parse(fs.readFileSync(`${control}.json`, "utf8"));
            if (receipt.drained !== true || !Number.isInteger(receipt.exitCode)) throw new Error("无法确认 Windows 进程树终态");
            execution.exitCode = receipt.exitCode;
            finalStatus = !execution.error && !receipt.stopped && receipt.exitCode === 0 ? "exited" : "failed";
          } catch (error) { finalStatus = "unknown"; execution.error = String(error); }
        } else if (child.pid) {
          try {
            try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
            if (!(await this.groupDrained(child.pid))) { finalStatus = "unknown"; execution.error = "仍有无法确认终态的子进程"; }
          } catch (error) { finalStatus = "unknown"; execution.error = String(error); }
        }
        execution.status = finalStatus;
        try { this.persist(); }
        catch (error) { execution.status = "unknown"; execution.error = `保存执行终态失败：${String(error)}`; }
        this.children.delete(executionId);
        try { this.resumeMigration(); }
        catch (error) { execution.status = "unknown"; execution.error = String(error); }
        finally { resolve(); }
      });
    });
    this.children.set(executionId, { child, done });
    try { this.persist(); }
    catch (error) {
      execution.error = `保存启动状态失败：${String(error)}`;
      // A failed acknowledgement must never leave a second untracked execution.
      try { await this.stop(h, executionId); } catch { execution.status = "unknown"; }
      throw error;
    }
    return this.view(execution);
  }
  private async groupDrained(group: number): Promise<boolean> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const output = await new Promise<string>((resolve, reject) => execFile("ps", ["-eo", "pgid=,stat="], { encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolve(stdout)));
      const alive = output.split("\n").some(line => { const [id, state] = line.trim().split(/\s+/); return Number(id) === group && !state?.startsWith("Z"); });
      if (!alive) return true;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return false;
  }
  private view(e: Execution): WorkspaceExecution {
    const { handle, digest, pid, ...view } = e; void handle; void digest; void pid;
    return structuredClone(view);
  }
  async query(h: CanvasWorkspaceHandle, input: { executionId: string; after?: number }) {
    this.check(h, true);
    const e = this.state.executions[input.executionId];
    if (!e || this.leaseKey(e.handle) !== this.leaseKey(h)) fail("execution-not-found", "执行不存在或无权访问");
    const file = path.join(this.eventsDir, `${e.executionId}.jsonl`);
    if (!Number.isSafeInteger(input.after ?? 0) || (input.after ?? 0) < 0) fail("workspace-conflict", "输出游标非法");
    const events: WorkspaceOutput[] = [];
    if (fs.existsSync(file)) {
      const stream = fs.createReadStream(file, { encoding: "utf8" });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line) continue;
          let event: WorkspaceOutput;
          try { event = JSON.parse(line) as WorkspaceOutput; }
          catch { break; } // A crash may leave an incomplete final append; never fabricate it.
          if (event.cursor > (input.after ?? 0)) events.push(event);
          if (events.length >= 128) break;
        }
      } finally { lines.close(); stream.destroy(); }
    }
    return { execution: this.view(e), events };
  }
  async stop(h: CanvasWorkspaceHandle, executionId: string): Promise<WorkspaceExecution> {
    await this.query(h, { executionId });
    const e = this.state.executions[executionId]!;
    const tracked = this.children.get(executionId);
    if (!activeExecution(e)) { await tracked?.done; return this.view(e); }
    if (!tracked) return this.view(e); // Never signal an unverified PID after a daemon restart.
    e.status = "cancel-requested";
    try { this.persist(); } catch (error) { e.error = `保存停止状态失败：${String(error)}`; }
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(this.eventsDir, `${executionId}.stop`), "stop", { mode: 0o600 });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([tracked.done, new Promise<void>(resolve => { timeout = setTimeout(() => { tracked.child.kill(); resolve(); }, 10_000); })]);
      } finally { if (timeout) clearTimeout(timeout); }
    } else if (tracked.child.pid) {
      try { process.kill(-tracked.child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await tracked.done;
    return this.view(e);
  }

  async clean(input: { owner: string; canvasId: string }): Promise<{ removed: string[]; retained: string[] }> {
    if (activePhase(this.migration())) fail("workspace-migrating", "工作目录正在迁移");
    const directory = this.location(input);
    for (const target of [this.state.rootPath, directory, path.join(directory, "runs")]) {
      if (fs.lstatSync(target).isSymbolicLink() || fs.realpathSync(target) !== target) fail("workspace-path-invalid", "清理目录已被替换为链接");
    }
    const removed: string[] = [], retained: string[] = [];
    for (const lease of Object.values(this.state.leases)) {
      const h = lease.handle;
      if (h.owner !== input.owner || h.canvasId !== input.canvasId) continue;
      if (!["terminal", "cancelled"].includes(lease.status) || Object.values(this.state.executions).some(e => this.leaseKey(e.handle) === this.leaseKey(h) && activeExecution(e))) { retained.push(h.runKey); continue; }
      const target = path.join(directory, "runs", h.runKey);
      if (!fs.existsSync(target)) continue;
      if (fs.lstatSync(target).isSymbolicLink()) { retained.push(h.runKey); continue; }
      try { fs.rmSync(target, { recursive: true }); removed.push(h.runKey); } catch { retained.push(h.runKey); }
    }
    return { removed, retained };
  }
  async migrate(input: { operationId: string; targetPath: string; expectedRootRevision: number }): Promise<WorkspaceMigration> {
    if (typeof input.operationId !== "string" || !input.operationId || input.operationId.length > 256 || typeof input.targetPath !== "string" || !input.targetPath || input.targetPath.includes("\0") || !path.isAbsolute(input.targetPath)) fail("workspace-path-invalid", "迁移需要操作身份和绝对目录路径");
    const target = path.resolve(input.targetPath);
    // Resolve aliases consistently even when the final directory does not exist.
    let ancestor = target;
    while (!fs.existsSync(ancestor)) { const parent = path.dirname(ancestor); if (parent === ancestor) fail("workspace-path-invalid", "无法解析目标目录"); ancestor = parent; }
    const canonical = path.join(fs.realpathSync(ancestor), path.relative(ancestor, target));
    const previous = this.state.migrations[input.operationId];
    if (previous) {
      if (previous.target !== canonical || previous.expectedRootRevision !== input.expectedRootRevision) fail("workspace-conflict", "同一迁移身份对应不同输入");
      return structuredClone(previous);
    }
    if (input.expectedRootRevision !== this.state.rootRevision || activePhase(this.migration()) || this.migrationWork) fail("workspace-conflict", "根位置版本已变化或已有迁移");
    if (canonical !== this.state.rootPath) {
      if (inside(this.state.rootPath, canonical) || inside(canonical, this.state.rootPath)) fail("workspace-path-invalid", "新旧根目录不能互相包含");
      for (const protectedPath of [this.options.stateDir, ...(this.options.protectedPaths ?? [])]) {
        const resolved = fs.existsSync(protectedPath) ? fs.realpathSync(protectedPath) : path.resolve(protectedPath);
        if (inside(resolved, canonical) || inside(canonical, resolved)) fail("workspace-path-invalid", "目标位置与应用运行数据重叠");
      }
    }
    const migration: WorkspaceMigration = { ...input, source: this.state.rootPath, target: canonical, phase: canonical === this.state.rootPath ? "completed" : "waiting-for-idle" };
    this.state.migrations[input.operationId] = migration;
    this.state.migrationId = input.operationId;
    this.persist();
    this.resumeMigration();
    return structuredClone(migration);
  }
  async cancelMigration(operationId: string): Promise<WorkspaceMigration> {
    const m = this.state.migrations[operationId];
    if (!m) fail("workspace-conflict", "迁移不存在");
    if (["waiting-for-idle", "copying", "verifying", "validating"].includes(m.phase)) { m.phase = "cancelled"; this.persist(); }
    return structuredClone(m);
  }
  private busy() { return Object.values(this.state.leases).some(l => ["active", "unknown"].includes(l.status)) || Object.values(this.state.executions).some(activeExecution); }
  private resumeMigration(): void {
    const m = this.migration();
    if (this.stopped || this.migrationWork || !m) return;
    if (m.phase === "completed" && m.cleanupPending) {
      this.migrationWork = this.cleanupSource(m).catch(error => { m.error = String(error); try { this.persist(); } catch { /* keep the durable cleanup intent */ } }).finally(() => { this.migrationWork = null; });
    } else if (activePhase(m) && !this.busy()) {
      this.migrationWork = this.copyAndSwitch(m).catch(error => { m.error = String(error); }).finally(() => { this.migrationWork = null; });
    }
  }
  private async inventory(root: string): Promise<Record<string, string>> {
    if (fs.realpathSync(root) !== root) fail("workspace-path-invalid", "迁移目录在操作期间被替换为链接");
    const result: Record<string, string> = {};
    const walk = async (relative: string) => {
      const full = path.join(root, relative);
      const stat = await fs.promises.lstat(full);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail("workspace-path-invalid", "受管目录包含链接或特殊文件，迁移已停止");
      if (stat.isFile()) {
        const digest = createHash("sha256");
        for await (const chunk of fs.createReadStream(full)) digest.update(chunk);
        result[relative] = digest.digest("hex");
      }
      else {
        result[`${relative}/`] = "directory";
        for (const entry of (await fs.promises.readdir(full)).sort()) await walk(path.join(relative, entry));
      }
    };
    for (const key of Object.keys(this.state.directories).sort()) await walk(key);
    return result;
  }
  /** Disk journal decides authority. Uncommitted target copies never become a root. */
  private recoverMigration(): void {
    const m = this.migration();
    if (!m || !activePhase(m)) return;
    if (this.state.rootPath === m.target) { m.phase = "completed"; m.cleanupPending = true; return; }
    if (["copying", "verifying", "switching", "recovering"].includes(m.phase)) {
      try { this.rollbackPublished(m); m.phase = "waiting-for-idle"; }
      catch (error) { m.phase = "failed"; m.error = String(error); }
    }
  }
  private inventorySync(root: string, keys: string[]): Record<string, string> {
    if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root) fail("workspace-path-invalid", "迁移目录已被替换为链接");
    const output: Record<string, string> = {};
    const walk = (relative: string) => {
      const full = path.join(root, relative), stat = fs.lstatSync(full);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) fail("workspace-path-invalid", "受管目录包含链接或特殊文件");
      if (stat.isFile()) {
        const digest = createHash("sha256"), fd = fs.openSync(full, "r"), buffer = Buffer.allocUnsafe(64 * 1024);
        try { let size: number; while ((size = fs.readSync(fd, buffer)) > 0) digest.update(buffer.subarray(0, size)); }
        finally { fs.closeSync(fd); }
        output[relative] = digest.digest("hex");
      }
      else { output[`${relative}/`] = "directory"; for (const entry of fs.readdirSync(full).sort()) walk(path.join(relative, entry)); }
    };
    for (const key of keys.sort()) walk(key);
    return output;
  }
  private flushTree(root: string): void {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail("workspace-path-invalid", "暂存目录包含链接或特殊文件");
    if (stat.isDirectory()) for (const entry of fs.readdirSync(root)) this.flushTree(path.join(root, entry));
    if (stat.isFile() || process.platform !== "win32") {
      const fd = fs.openSync(root, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  }
  private flushDirectory(root: string): void {
    if (process.platform === "win32") return;
    const fd = fs.openSync(root, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  private rollbackPublished(m: WorkspaceMigration): void {
    const plan = this.state.plans?.[m.operationId];
    if (!plan) return;
    for (const key of plan.published) {
      const target = path.join(m.target, key);
      if (!fs.existsSync(target)) continue;
      const identity = plan.identities?.[key], stat = fs.lstatSync(target);
      if (!identity || stat.dev !== identity.dev || stat.ino !== identity.ino || stat.isSymbolicLink()) fail("workspace-conflict", "目标副本归属无法证明；保留源目录与冲突目录");
      const expected = Object.fromEntries(Object.entries(plan.inventory).filter(([p]) => p === `${key}/` || p.startsWith(`${key}${path.sep}`)));
      if (JSON.stringify(this.inventorySync(m.target, [key])) !== JSON.stringify(expected)) fail("workspace-conflict", "未提交的目标副本已被外部修改；源位置保留，请处理冲突后重试");
      fs.rmSync(target, { recursive: true });
    }
    plan.published = [];
  }
  private async cleanupSource(m: WorkspaceMigration): Promise<void> {
    const plan = this.state.plans?.[m.operationId];
    if (!plan) { m.error = "缺少清理校验记录，保留旧副本"; this.persist(); return; }
    for (const key of Object.keys(this.state.directories)) {
      if (!fs.existsSync(path.join(m.source, key))) continue;
      const expected = Object.fromEntries(Object.entries(plan.inventory).filter(([p]) => p === `${key}/` || p.startsWith(`${key}${path.sep}`)));
      if (JSON.stringify(this.inventorySync(m.source, [key])) !== JSON.stringify(expected)) {
        m.error = "旧副本被外部修改，已保留；当前生效位置仍为新目录"; this.persist(); return;
      }
      fs.rmSync(path.join(m.source, key), { recursive: true });
    }
    m.cleanupPending = false; delete m.error; this.persist();
  }
  private async copyAndSwitch(m: WorkspaceMigration): Promise<void> {
    const staging = path.join(m.target, `.woohaa-migrate-${this.installation}-${hash(m.operationId)}`);
    const marker = path.join(staging, ".woohaa-migration.json");
    const owned = () => {
      try {
        if (fs.lstatSync(staging).isSymbolicLink()) return false;
        const v = JSON.parse(fs.readFileSync(marker, "utf8"));
        return v.installation === this.installation && v.operationId === m.operationId;
      } catch { return false; }
    };
    let created = false;
    const cancelled = () => m.phase === "cancelled" || this.stopped;
    try {
      m.phase = "copying"; this.persist();
      await fs.promises.mkdir(m.target, { recursive: true, mode: 0o700 });
      if (fs.realpathSync(m.target) !== m.target) fail("workspace-path-invalid", "目标位置在迁移期间发生变化");
      for (const key of Object.keys(this.state.directories)) if (fs.existsSync(path.join(m.target, key))) fail("workspace-conflict", "目标已有冲突画布目录");
      if (fs.existsSync(staging)) {
        if (!owned()) fail("workspace-conflict", "目标含归属不明的迁移暂存目录，已保留");
        await fs.promises.rm(staging, { recursive: true });
      }
      await fs.promises.mkdir(staging, { mode: 0o700 });
      fs.writeFileSync(marker, JSON.stringify({ installation: this.installation, operationId: m.operationId }), { mode: 0o600, flag: "wx" });
      created = true;
      const before = await this.inventory(m.source);
      const plan: MigrationPlan = { inventory: before, published: [], identities: {} };
      (this.state.plans ??= Object.create(null))[m.operationId] = plan;
      this.persist();
      for (const key of Object.keys(this.state.directories)) {
        if (cancelled()) return;
        await fs.promises.cp(path.join(m.source, key), path.join(staging, key), { recursive: true, errorOnExist: true, force: false });
      }
      if (cancelled()) return;
      m.phase = "verifying"; this.persist();
      const copied = await this.inventory(staging), after = await this.inventory(m.source);
      if (JSON.stringify(before) !== JSON.stringify(copied) || JSON.stringify(before) !== JSON.stringify(after)) fail("workspace-conflict", "复制校验失败或源文件被外部修改");
      if (cancelled()) return;
      // Data must reach the target volume before publishing its root revision.
      this.flushTree(staging);
      m.phase = "switching"; this.persist();
      for (const key of Object.keys(this.state.directories)) {
        if (fs.existsSync(path.join(m.target, key))) fail("workspace-conflict", "目标目录在迁移时出现冲突");
        const stat = fs.lstatSync(path.join(staging, key));
        plan.identities![key] = { dev: stat.dev, ino: stat.ino };
        // Intent is durable before each rename, including a crash between rename and persist.
        plan.published.push(key); this.persist();
        fs.renameSync(path.join(staging, key), path.join(m.target, key));
      }
      this.flushDirectory(staging);
      this.flushDirectory(m.target);
      this.flushDirectory(path.dirname(m.target));
      const old = { rootPath: this.state.rootPath, rootRevision: this.state.rootRevision, generation: this.state.generation };
      this.state.rootPath = m.target; this.state.rootRevision++; this.state.generation++;
      m.phase = "completed"; m.cleanupPending = true;
      try { this.persist(); }
      catch (error) {
        const disk = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as State;
        if (disk.rootPath !== m.target || disk.rootRevision !== this.state.rootRevision) { Object.assign(this.state, old); m.phase = "switching"; throw error; }
      }
      await this.cleanupSource(m);
    } catch (error) {
      if (this.state.rootPath !== m.target) {
        try { this.rollbackPublished(m); } catch (rollbackError) { m.error = String(rollbackError); }
        m.phase = "failed";
      }
      m.error ??= error instanceof Error ? error.message : String(error);
      this.persist();
    } finally {
      if (created && owned()) await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (this.stopped && activePhase(m)) { m.phase = "waiting-for-idle"; this.persist(); }
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    for (const e of Object.values(this.state.executions)) if (this.children.has(e.executionId)) await this.stop(e.handle, e.executionId);
    await this.migrationWork;
  }
}
