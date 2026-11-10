/**
 * 内置执行器。
 *
 * - `echo`：验证协议/事件/CLI 的最小执行器，不产生外部副作用；
 * - `process`：运行任意本机 CLI（Codex/OpenCode 或测试命令），把 stdout 行转成事件；
 * 真实业务执行器（SDK/OAuth/生成 Provider）由宿主或 CLI 模块注入，不写死在这里。
 */
import { spawn } from "node:child_process";
import { resolveSpawnTarget } from "./endpoints.js";
import type { Executor, ExecutorOutcome, TurnRunInput } from "./protocol.js";

function preparedText(input: TurnRunInput): string {
  return (input.prepared?.messages ?? [])
    .map((message) => message.role === "system" ? message.content : message.role === "assistant" ? `助手：${message.content}` : message.content)
    .join("\n\n");
}

export const echoExecutor: Executor = {
  id: "echo",
  kind: "any",
  async run(input, context): Promise<ExecutorOutcome> {
    const text = preparedText(input);
    context.emit("message", { role: "assistant", text });
    return { status: "succeeded", result: { text, preparedHash: input.prepared?.preparedHash ?? null } };
  }
};

type ProcessPayload = {
  command?: unknown;
  args?: unknown;
  cwd?: unknown;
  env?: unknown;
  stdin?: unknown;
};

export const processExecutor: Executor = {
  id: "process",
  kind: "any",
  async run(input, context): Promise<ExecutorOutcome> {
    const payload = (input.payload ?? {}) as ProcessPayload;
    const command = typeof payload.command === "string" ? payload.command : "";
    if (!command) return { status: "failed", error: { code: "malformed-request", message: "process 执行器需要 payload.command" } };
    const args = Array.isArray(payload.args) ? payload.args.filter((arg): arg is string => typeof arg === "string") : [];
    const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
    const env = {
      ...process.env,
      ...(payload.env && typeof payload.env === "object" ? payload.env as Record<string, string> : {})
    };
    const target = resolveSpawnTarget(command, args);
    const child = spawn(target.command, target.args, {
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      ...(target.shell ? { shell: true } : {})
    });
    const kill = () => {
      try {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid!, "SIGTERM");
      } catch { /* already gone */ }
    };
    context.signal.addEventListener("abort", kill, { once: true });
    const stdin = typeof payload.stdin === "string" ? payload.stdin : preparedText(input);
    child.stdin?.end(stdin);
    let stdout = "";
    let stderr = "";
    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line !== "") context.emit("output", { stream: "stdout", text: line });
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      for (const line of String(chunk).split(/\r?\n/)) if (line !== "") context.emit("output", { stream: "stderr", text: line });
    });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (exitCode) => resolve(exitCode));
      });
      if (buffer !== "") context.emit("output", { stream: "stdout", text: buffer });
      if (context.signal.aborted) return { status: "cancelled", error: { code: "cancelled", message: "执行已取消" }, result: { stdout, stderr } };
      if (code === 0) return { status: "succeeded", result: { stdout, stderr, code } };
      return { status: "failed", error: { code: "process-exit", message: `命令退出码 ${code ?? "unknown"}${stderr ? `：${stderr.slice(-500)}` : ""}` }, result: { stdout, stderr, code } };
    } catch (error) {
      return { status: "failed", error: { code: "process-start-failed", message: error instanceof Error ? error.message : String(error) } };
    } finally {
      context.signal.removeEventListener("abort", kill);
    }
  }
};

export const builtInExecutors: readonly Executor[] = [echoExecutor, processExecutor];
