/**
 * 固定引擎的 runtime 准备状态。
 *
 * npm registry 只是 runtime 的取得方式：这里把 manager 的状态和安装失败原因翻译成连接可见的
 * `preparing / ready / unavailable`，并保证同引擎并发准备被 manager 的 single-flight 合并。
 * 准备过程不发起模型推理。
 */
import { getRuntimeComponentManager } from "@woohaa3/runtime-components";
import type { AgentEngineId } from "@woohaa3/contracts";

export type RuntimeComponentId = "dsh" | "claude" | "codex";

export type EnginePreparation = {
  engine: AgentEngineId;
  component: RuntimeComponentId | null;
  state: "ready" | "preparing" | "unavailable";
  version?: string;
  source?: string;
  reason?: string;
  /** 稳定原因码，供连接状态与测试判断。 */
  code?: string;
};

export function componentForEngine(engine: AgentEngineId): RuntimeComponentId | null {
  if (engine === "dsh-agent-sdk") return "dsh";
  if (engine === "claude-agent-sdk") return "claude";
  if (engine === "codex-agent-sdk") return "codex";
  return null;
}

/** 安装失败原因 → 用户可行动文案；不再指向“重新安装扩展”。 */
export function preparationMessage(code: string, fallback: string): string {
  switch (code) {
    case "RUNTIME_INSTALL_DISABLED": return fallback || "管理员未启用运行时安装";
    case "REGISTRY_UNAVAILABLE": return `npm registry 暂不可达：${fallback}。请检查网络后重试准备。`;
    case "INVALID_HASH":
    case "INVALID_INTEGRITY": return `运行时完整性校验失败：${fallback}。请重试准备。`;
    case "INSUFFICIENT_SPACE": return "磁盘空间不足，无法安装运行时。请清理磁盘后重试。";
    case "UNAPPROVED_LIFECYCLE_SCRIPT": return `运行时包含未审核的安装脚本：${fallback}`;
    case "INVALID_LAYOUT":
    case "INVALID_ENTRY": return `运行时安装结果未通过校验：${fallback}。请重试准备。`;
    case "NPM_TOOLCHAIN_MISSING": return "应用自带的 npm 工具链缺失，请重新安装应用。";
    case "INCOMPATIBLE_COMPONENT": return `当前平台没有可用的运行时：${fallback}`;
    default: return fallback || "运行时准备失败，请重试。";
  }
}

export type FixedEnginePreparation = {
  prepare(engine: AgentEngineId): Promise<EnginePreparation>;
};

/**
 * @param manager 测试注入；缺省取宿主注入的 singleton。
 * 没有 manager 只发生在未配置 runtime 环境的开发桌面：此时 SDK 从随仓依赖解析。
 */
export function createFixedEnginePreparation(manager = getRuntimeComponentManager()): FixedEnginePreparation {
  const inFlight = new Map<RuntimeComponentId, Promise<EnginePreparation>>();
  async function run(component: RuntimeComponentId, engine: AgentEngineId): Promise<EnginePreparation> {
    if (!manager) return { engine, component, state: "ready", source: "development" };
    let state;
    try {
      state = await manager.inspect(component);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      return { engine, component, state: "unavailable", code, reason: preparationMessage(code, error instanceof Error ? error.message : "") };
    }
    const base = { engine, component, version: state.version, source: state.source } as const;
    if (state.status === "ready") return { ...base, state: "ready" };
    if (state.status === "unavailable") return { ...base, state: "unavailable", code: "RUNTIME_INSTALL_DISABLED", reason: state.error ?? "管理员未启用运行时安装" };
    // 安装由 manager 合并；连接侧只等待同一结果。
    try {
      const installed = await manager.install(component);
      if (installed.status === "ready") return { ...base, version: installed.version, state: "ready" };
      return { ...base, state: "unavailable", code: "RUNTIME_COMPONENT_MISSING", reason: installed.error ?? "运行时安装未完成，请重试准备" };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      return { ...base, state: "unavailable", code, reason: preparationMessage(code, error instanceof Error ? error.message : "") };
    }
  }
  return {
    prepare(engine) {
      const component = componentForEngine(engine);
      if (!component) return Promise.resolve({ engine, component: null, state: "ready", source: "builtin" });
      const existing = inFlight.get(component);
      if (existing) return existing;
      const job = run(component, engine).finally(() => inFlight.delete(component));
      inFlight.set(component, job);
      return job;
    }
  };
}
