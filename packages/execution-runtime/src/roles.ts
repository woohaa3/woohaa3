/**
 * CLI 侧的角色装载与准备。
 *
 * 这是**独立使用**所需的角色入口：从显式模块加载 `AgentRoleImplementation`，按契约做
 * input/context schema 校验、工具/内建能力求交、prepare 收窄校验与 preparedHash 冻结。
 * 不读取画布、不签发 grant、不认识具体业务角色 ID —— 角色由调用方通过模块提供。
 */
import {
  agentRoleDescriptorDigest,
  agentRoleTurnDigests,
  composeAgentRoleMessages,
  decodeAgentRoleImplementation,
  decodeAgentRolePrompt,
  makeAgentRoleRef,
  normalizeAgentRoleToolNames,
  preparedTurnHash,
  validateAgentRoleValue,
  type AgentNativeCapability,
  type AgentRoleChannelCapabilities,
  type AgentRoleDefinition,
  type AgentRoleImplementation,
  type AgentRoleTargetRef,
  type PreparedAgentRoleTurn
} from "@woohaa3/contracts";

export type CliRoleEntry = {
  namespacedId: string;
  extensionId: string;
  definition: AgentRoleDefinition;
  implementation: AgentRoleImplementation;
  artifactId: string;
};

export function roleEntries(
  implementations: readonly AgentRoleImplementation[],
  input: { extensionId?: string; artifactId?: string; moduleLabel?: string } = {}
): CliRoleEntry[] {
  const entries: CliRoleEntry[] = [];
  for (const raw of implementations) {
    const decoded = decodeAgentRoleImplementation(raw);
    if (!decoded.ok) throw new Error(`角色实现无效：${decoded.message}`);
    const definition = decoded.value.definition;
    const extensionId = input.extensionId ?? "cli";
    const artifactId = input.artifactId ?? `cli:${input.moduleLabel ?? extensionId}@1`;
    entries.push({
      namespacedId: `${extensionId}/${definition.id}`,
      extensionId,
      definition,
      implementation: decoded.value,
      artifactId
    });
  }
  return entries;
}

export function channelForDefinition(definition: AgentRoleDefinition): AgentRoleChannelCapabilities {
  return {
    toolCalling: definition.requirements.toolCalling,
    imageInput: definition.requirements.imageInput,
    // 独立执行器未声明原生结构化能力；候选角色按 validated-json 走宿主端严格解码。
    structuredOutput: definition.requirements.structuredOutput === "schema-enforced" ? "validated-json" : definition.requirements.structuredOutput,
    // 默认只开启必需内建能力；可选生图等必须由调用方在 --channel 中显式声明。
    nativeCapabilities: [...definition.nativeCapabilities.required]
  };
}

export function prepareCliRoleTurn(input: {
  entry: CliRoleEntry;
  roleInput: unknown;
  context: unknown;
  target: AgentRoleTargetRef;
  requestId: string;
  channel?: AgentRoleChannelCapabilities;
  requestedTools?: readonly string[];
  availableTools?: readonly string[];
  expectedContentHash?: string;
}): PreparedAgentRoleTurn {
  const { definition, implementation } = input.entry;
  const inputViolation = validateAgentRoleValue(definition.inputSchema, input.roleInput);
  if (inputViolation) throw new Error(`角色输入非法：${inputViolation.path} ${inputViolation.message}`);
  const contextViolation = validateAgentRoleValue(definition.contextSchema, input.context);
  if (contextViolation) throw new Error(`角色上下文非法：${contextViolation.path} ${contextViolation.message}`);
  const channel = input.channel ?? channelForDefinition(definition);
  const missing: string[] = [];
  if (definition.requirements.toolCalling && !channel.toolCalling) missing.push("tool-calling");
  if (definition.requirements.imageInput && !channel.imageInput) missing.push("image-input");
  if (definition.requirements.structuredOutput === "schema-enforced" && channel.structuredOutput !== "schema-enforced") missing.push("structured-output:schema-enforced");
  if (definition.requirements.structuredOutput === "validated-json" && channel.structuredOutput === "none") missing.push("structured-output:validated-json");
  for (const capability of definition.nativeCapabilities.required) {
    if (!channel.nativeCapabilities.includes(capability)) missing.push(`native:${capability}`);
  }
  if (missing.length > 0) throw new Error(`所选执行通道不满足角色要求：${missing.join(", ")}`);

  const declared = [...definition.tools.required, ...definition.tools.optional];
  const requested = input.requestedTools ? normalizeAgentRoleToolNames(input.requestedTools) : null;
  if (requested && !requested.ok) throw new Error(requested.message);
  if (requested) {
    const escaped = requested.value.filter((tool) => !declared.includes(tool));
    if (escaped.length > 0) throw new Error(`请求包含角色未声明的工具：${escaped.join(", ")}`);
  }
  const catalog = new Set(input.availableTools ?? declared);
  const allowed = (requested ? requested.value : declared).filter((tool) => catalog.has(tool));
  const nativeCapabilities: AgentNativeCapability[] = [
    ...definition.nativeCapabilities.required,
    ...definition.nativeCapabilities.optional.filter((capability) => channel.nativeCapabilities.includes(capability))
  ];
  const prompt = implementation.prepare({
    input: input.roleInput,
    context: input.context,
    target: input.target,
    requestId: input.requestId,
    ...(input.expectedContentHash ? { expectedContentHash: input.expectedContentHash } : {}),
    nativeCapabilities
  });
  const decodedPrompt = decodeAgentRolePrompt(prompt, declared);
  if (!decodedPrompt.ok) throw new Error(decodedPrompt.message);
  const promptTools = decodedPrompt.value.tools;
  const finalTools = promptTools
    ? allowed.filter((tool) => promptTools.includes(tool))
    : allowed;
  const missingRequired = definition.tools.required.filter((tool) => !finalTools.includes(tool));
  if (missingRequired.length > 0) throw new Error(`本轮缺少必要工具：${missingRequired.join(", ")}`);

  const digests = agentRoleTurnDigests({ input: input.roleInput, context: input.context });
  const base: Omit<PreparedAgentRoleTurn, "preparedHash"> = {
    schemaVersion: 1,
    roleRef: makeAgentRoleRef({
      extensionId: input.entry.extensionId,
      roleId: definition.id,
      revision: definition.revision,
      descriptorDigest: agentRoleDescriptorDigest(definition),
      artifactId: input.entry.artifactId
    }),
    messages: composeAgentRoleMessages(definition.instructions, decodedPrompt.value.messages),
    tools: finalTools,
    nativeCapabilities,
    output: definition.output,
    inputDigest: digests.inputDigest,
    contextDigest: digests.contextDigest,
    attachmentDigests: digests.attachmentDigests,
    target: input.target
  };
  return { ...base, preparedHash: preparedTurnHash(base) };
}
