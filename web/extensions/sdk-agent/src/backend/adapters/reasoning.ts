/**
 * 固定 Agent 引擎的 reasoning 映射与目录裁剪。
 *
 * 目录只公开 adapter 能映射到真实 wire 值的 canonical 档位；Provider 声明的其他值仍保留
 * “支持推理”的事实，但不作为可选项出现。后端在受理时用同一张表校验，避免“界面可选、
 * 传输不支持”。
 */
import { agentReasoningRevision, type AgentEngineId, type AgentReasoningCapability, type AgentReasoningEffort } from "@woohaa3/contracts";

/** dsh 的 thinking level 与外层 wire 值（`off` 之外与 canonical 同名）。 */
export type DshReasoningMapping = { level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; wire: string };

const MAPPINGS: Record<AgentEngineId, Partial<Record<AgentReasoningEffort, string | DshReasoningMapping>>> = {
  "codex-agent-sdk": { low: "low", medium: "medium", high: "high" },
  "claude-agent-sdk": { low: "low", medium: "medium", high: "high" },
  "gemini-agent-adk": { low: "low", high: "high" },
  "dsh-agent-sdk": {
    none: { level: "off", wire: "none" },
    low: { level: "low", wire: "low" },
    medium: { level: "medium", wire: "medium" },
    high: { level: "high", wire: "high" }
  }
};

export function adapterSupportsReasoningEffort(engine: AgentEngineId, effort: AgentReasoningEffort): boolean {
  return MAPPINGS[engine][effort] !== undefined;
}

/** canonical effort → 该引擎的 wire 值；不支持返回 null（不静默降级）。 */
export function resolveReasoningEffort(engine: AgentEngineId, effort: AgentReasoningEffort): string | DshReasoningMapping | null {
  return MAPPINGS[engine][effort] ?? null;
}

/**
 * 把 Provider/runtime 声明裁剪到 adapter 可执行集合。
 *
 * - unknown/unsupported 原样保留；
 * - supported 且有精确档位：只保留可映射项；全部不可映射时保留 supported 无档位；
 * - supported 无档位：保留默认语义。
 */
export function projectReasoningCapability(engine: AgentEngineId, capability: AgentReasoningCapability | undefined): AgentReasoningCapability {
  if (!capability) return { state: "unknown", source: "provider", revision: agentReasoningRevision(engine, "unknown") };
  if (capability.state !== "supported" || !capability.efforts?.length) return capability;
  const efforts = capability.efforts.filter((option) => adapterSupportsReasoningEffort(engine, option.id));
  return {
    state: "supported",
    source: capability.source,
    revision: agentReasoningRevision(capability.revision, engine, efforts.map((option) => option.id).join(",")),
    ...(efforts.length ? { efforts } : {})
  };
}
