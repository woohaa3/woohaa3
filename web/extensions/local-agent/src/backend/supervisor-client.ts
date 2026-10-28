import net from "node:net";
import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ProcessHandle, ProcessManager, ProcessManagerOptions, StdioConnection } from "./process-manager.js";

type SupervisorConfig = { socketPath: string; token: string; workspaceKey: string; portRange: { min: number; max: number } };
type SupervisorResponse = { id: number; ok: boolean; result?: Record<string, unknown>; error?: string };

function splitLines(onLine: (line: string) => void) {
  let buffer = "";
  return (chunk: Buffer | string) => {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line) onLine(line);
  };
}

function safeSegment(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, process.platform === "win32" ? 32 : 64);
}

function connect(pathname: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pathname);
    const fail = (error: Error) => { socket.destroy(); reject(error); };
    socket.once("connect", () => resolve(socket));
    socket.once("error", fail);
  });
}

export function createSupervisorProcessManager(options: ProcessManagerOptions, supervisor: SupervisorConfig): ProcessManager {
  let requestId = 0;
  const handles = new Map<string, ProcessHandle>();
  const call = async (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const socket = await connect(supervisor.socketPath);
    const id = ++requestId;
    return await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("Agent Supervisor 请求超时")); }, 10_000);
      socket.setEncoding("utf8");
      socket.on("data", chunk => {
        buffer += String(chunk);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          let response: SupervisorResponse;
          try { response = JSON.parse(line) as SupervisorResponse; } catch { continue; }
          if (response.id !== id) continue;
          clearTimeout(timer);
          socket.end();
          if (response.ok) resolve(response.result ?? {});
          else reject(new Error(response.error ?? "Agent Supervisor 请求失败"));
        }
      });
      socket.once("error", error => { clearTimeout(timer); reject(error); });
      socket.write(JSON.stringify({ id, token: supervisor.token, workspaceKey: supervisor.workspaceKey, method, params }) + "\n");
    });
  };

  const stdio = async (stdioPath: string): Promise<StdioConnection> => {
    const socket = await connect(stdioPath);
    const listeners = new Set<(line: string) => void>();
    const stderrListeners = new Set<(line: string) => void>();
    const consume = splitLines(line => listeners.forEach(listener => listener(line)));
    socket.setEncoding("utf8");
    socket.on("data", consume);
    socket.on("error", error => stderrListeners.forEach(listener => listener(error.message)));
    return {
      send: line => socket.write(`${line}\n`),
      onLine: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      onStderr: listener => { stderrListeners.add(listener); return () => stderrListeners.delete(listener); },
      close: () => socket.destroy()
    };
  };

  const ensure = async (input: Parameters<ProcessManager["ensure"]>[0]): Promise<ProcessHandle> => {
    const key = `${input.adapterId}\u0000${input.owner}\u0000${input.connectionId}`;
    const existing = handles.get(key);
    if (existing) return existing;
    const workDir = path.join(options.workDirRoot, safeSegment(input.adapterId), safeSegment(input.owner), safeSegment(input.connectionId));
    const configDir = path.join(workDir, "config");
    // cwd 必须先存在：supervisor 里 `spawn(command, { cwd })` 在目录缺失时只报
    // `spawn <可执行文件> ENOENT`，看起来像 CLI 没装，实际是工作目录不存在。
    // 进程内 spawn 路径（process-manager）一直有这一步；Supervisor 模式漏了，只有带
    // prepareConfigDir 钩子的 codex 顺手建了目录，opencode / codebuddy 全挂（2026-10-28 回归）。
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    await options.prepareConfigDir?.({ adapterId: input.adapterId, owner: input.owner, connectionId: input.connectionId, workDir, configDir });
    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("WOOHAA3_"))),
      PATH: process.env.PATH ?? "",
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...(input.env ?? {})
    };
    if (input.adapterId === "codex-appserver") {
      env.HOME = configDir;
      env.XDG_CONFIG_HOME = configDir;
    }
    let httpHeaders: Record<string, string> | undefined;
    if (input.kind === "http" && input.adapterId === "opencode-server") {
      const password = crypto.randomBytes(32).toString("hex");
      env.OPENCODE_SERVER_PASSWORD = password;
      httpHeaders = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
    }
    const result = await call("ensure", {
      adapterId: input.adapterId, owner: input.owner, connectionId: input.connectionId,
      requestId: input.requestId,
      command: await options.executableFor(input.adapterId), args: [...input.args], cwd: workDir,
      env, kind: input.kind, ...(httpHeaders ? { httpHeaders } : {}), portMin: supervisor.portRange.min, portMax: supervisor.portRange.max
    });
    const handle: ProcessHandle = {
      key, adapterId: input.adapterId, owner: input.owner, connectionId: input.connectionId, kind: input.kind,
      loopbackUrl: typeof result.loopbackUrl === "string" ? result.loopbackUrl : null,
      ...(result.httpHeaders && typeof result.httpHeaders === "object" ? { httpHeaders: result.httpHeaders as Record<string, string> } : httpHeaders ? { httpHeaders } : {}),
      pid: typeof result.pid === "number" ? result.pid : undefined, workDir, configDir, startedAt: Number(result.startedAt ?? Date.now()),
      ...(input.kind === "stdio" && typeof result.stdioPath === "string" ? { stdio: await stdio(result.stdioPath) } : {})
    };
    handles.set(key, handle);
    return handle;
  };
  const stop = async (input: { adapterId: string; owner: string; connectionId: string }) => {
    const key = `${input.adapterId}\u0000${input.owner}\u0000${input.connectionId}`;
    handles.get(key)?.stdio?.close();
    handles.delete(key);
    await call("stop", { adapterId: input.adapterId, owner: input.owner, connectionId: input.connectionId });
  };
  return {
    probe: async adapterId => {
      const entry = await options.executableFor(adapterId);
      return entry ? { ok: true, version: "supervisor" } : { ok: false, code: "runtime-missing" as const, message: `未安装 ${adapterId} 所需可执行文件` };
    },
    ensure,
    get: input => handles.get(`${input.adapterId}\u0000${input.owner}\u0000${input.connectionId}`) ?? null,
    stop,
    stopAll: async () => { handles.forEach(handle => handle.stdio?.close()); handles.clear(); },
    activeCount: () => handles.size
  };
}
