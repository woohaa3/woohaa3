/**
 * 运行时状态与显式停机（change: 2026-11-10-split-agent-runtime-lifecycle，任务 1.2）。
 *
 * `runtime status|stop` 是唯一停机入口：先读身份快照，再按 workspace 校验并探活。
 * 不匹配 workspace / schema 的实例只报告，不结束（design D1）。
 */
import { createExecutorClient } from "./client.js";
import { EXECUTOR_IDENTITY_SCHEMA_VERSION, isAdoptableIdentity, readExecutorIdentity, type ExecutorIdentity } from "./identity.js";

export type RuntimeReport = {
  status: "healthy" | "missing" | "unreachable" | "workspace-mismatch" | "incompatible" | "insecure" | "legacy" | "malformed";
  workspaceKey: string;
  runtimeDir: string;
  socketPath?: string;
  pid?: number;
  runtimeVersion?: string;
  detail?: string;
  health?: unknown;
};

const baseOf = (identity: ExecutorIdentity, runtimeDir: string) => ({
  workspaceKey: identity.workspaceKey,
  runtimeDir,
  socketPath: identity.socketPath,
  pid: identity.pid,
  runtimeVersion: identity.runtimeVersion
});

export async function inspectRuntime(input: { runtimeDir: string; workspaceKey: string }): Promise<RuntimeReport> {
  const identity = readExecutorIdentity(input.runtimeDir);
  if (!identity.ok) {
    const status = identity.reason === "missing"
      ? "missing"
      : identity.reason === "legacy"
        ? "legacy"
        : identity.reason === "insecure-directory"
          ? "insecure"
          : "malformed";
    return { status, workspaceKey: input.workspaceKey, runtimeDir: input.runtimeDir, detail: identity.message };
  }
  const value = identity.identity;
  const base = baseOf(value, input.runtimeDir);
  if (value.workspaceKey !== input.workspaceKey) {
    return { status: "workspace-mismatch", ...base, detail: `运行时属于 workspace ${value.workspaceKey}，当前为 ${input.workspaceKey}；不结束该实例` };
  }
  const adoptable = isAdoptableIdentity(value);
  if (!adoptable.ok) return { status: "incompatible", ...base, detail: adoptable.reason };
  const api = createExecutorClient({ socketPath: value.socketPath, token: value.token, workspaceKey: value.workspaceKey, timeoutMs: 2_000 });
  try {
    const health = await api.health();
    if (health.schemaVersion !== undefined && health.schemaVersion !== EXECUTOR_IDENTITY_SCHEMA_VERSION) {
      return { status: "incompatible", ...base, detail: `运行中实例 schema ${health.schemaVersion} 与当前 ${EXECUTOR_IDENTITY_SCHEMA_VERSION} 不兼容` };
    }
    return { status: "healthy", ...base, health };
  } catch (error) {
    return { status: "unreachable", ...base, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function stopExecutorRuntime(input: { runtimeDir: string; workspaceKey: string; timeoutMs?: number }): Promise<{ stopped: boolean; report: RuntimeReport; detail?: string }> {
  const report = await inspectRuntime(input);
  if (report.status !== "healthy") return { stopped: false, report };
  const identity = readExecutorIdentity(input.runtimeDir);
  if (!identity.ok) return { stopped: false, report, detail: identity.message };
  const api = createExecutorClient({
    socketPath: identity.identity.socketPath,
    token: identity.identity.token,
    workspaceKey: identity.identity.workspaceKey,
    timeoutMs: 3_000
  });
  await api.shutdown();
  const timeoutMs = input.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = await api.health().then(() => true, () => false);
    const current = readExecutorIdentity(input.runtimeDir);
    const identityGone = !current.ok || current.identity.pid !== identity.identity.pid;
    if (!alive && identityGone) return { stopped: true, report };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { stopped: false, report, detail: `运行时在 ${timeoutMs}ms 内未停止` };
}
