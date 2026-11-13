/**
 * Agent 角色纯数据校验与摘要（change: 2026-11-07-add-pluggable-agent-roles）。
 *
 * 只做**无副作用**的形状/字段校验、工具集合规范化、输入上下文 schema 校验与快照编解码。
 * 注册表、生命周期与授权在宿主实现里；本模块不读 I/O、不持有实现。
 */
import { isBoundedId, isJsonObject } from "../../validation.js";
import { stableStringify } from "../../canvas/canvas-script/planner/hash.js";
import { sha256Hex } from "./agent-role-digest.js";
import type {
  AgentNativeCapability,
  AgentPromptMessage,
  AgentRoleDefinition,
  AgentRoleDescriptor,
  AgentRoleFailure,
  AgentRoleImplementation,
  AgentRoleJsonSchema,
  AgentRoleOutput,
  AgentRolePrompt,
  AgentRoleRef,
  AgentRoleRequirements,
  AgentRoleStructuredOutput,
  AgentRoleToolset,
  PreparedAgentRoleTurn
} from "./agent-role.js";
import { decodeCanvasWorkspaceHandle } from "./canvas-agent-workspace.js";
import {
  isAgentNativeCapability,
  isAgentRoleStructuredOutput,
  isAgentRoleErrorCode
} from "./agent-role.js";

const DEFINITION_KEYS = [
  "id",
  "revision",
  "title",
  "specialty",
  "instructions",
  "inputSchema",
  "contextSchema",
  "tools",
  "nativeCapabilities",
  "requirements",
  "output"
] as const;

const TOOLSET_KEYS = ["required", "optional"] as const;
const NATIVE_KEYS = ["required", "optional"] as const;
const REQUIREMENT_KEYS = ["imageInput", "toolCalling", "structuredOutput"] as const;
const OUTPUT_KINDS = ["reply", "candidate", "tool-receipts"] as const;
const ROLE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

/** 规范化工具集合：去重、保序、拒绝空名或非字符串。 */
export function normalizeAgentRoleToolNames(value: unknown): AgentRoleFailure | { ok: true; value: string[] } {
  if (!Array.isArray(value)) return { ok: false, code: "role-invalid-definition", message: "工具集合必须是字符串数组" };
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !TOOL_NAME_PATTERN.test(entry)) {
      return { ok: false, code: "role-invalid-definition", message: `工具名非法：${String(entry)}` };
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    names.push(entry);
  }
  return { ok: true, value: names };
}

function decodeToolset(value: unknown): AgentRoleFailure | { ok: true; value: AgentRoleToolset } {
  if (!isJsonObject(value)) return { ok: false, code: "role-invalid-definition", message: "tools 必须是对象" };
  if (Object.keys(value).some((key) => !(TOOLSET_KEYS as readonly string[]).includes(key))) {
    return { ok: false, code: "role-invalid-definition", message: "tools 含未知字段" };
  }
  const required = normalizeAgentRoleToolNames(value.required);
  if (!required.ok) return required;
  const optional = normalizeAgentRoleToolNames(value.optional);
  if (!optional.ok) return optional;
  const requiredSet = new Set(required.value);
  const overlap = optional.value.filter((name) => requiredSet.has(name));
  if (overlap.length > 0) {
    return { ok: false, code: "role-invalid-definition", message: `工具不能同时是必需与可选：${overlap.join(", ")}` };
  }
  return { ok: true, value: { required: required.value, optional: optional.value } };
}

function decodeNative(value: unknown): AgentRoleFailure | { ok: true; value: { required: AgentNativeCapability[]; optional: AgentNativeCapability[] } } {
  if (!isJsonObject(value)) return { ok: false, code: "role-invalid-definition", message: "nativeCapabilities 必须是对象" };
  if (Object.keys(value).some((key) => !(NATIVE_KEYS as readonly string[]).includes(key))) {
    return { ok: false, code: "role-invalid-definition", message: "nativeCapabilities 含未知字段" };
  }
  const read = (raw: unknown, label: string): AgentRoleFailure | { ok: true; value: AgentNativeCapability[] } => {
    if (!Array.isArray(raw) || !raw.every(isAgentNativeCapability)) {
      return { ok: false, code: "role-invalid-definition", message: `${label} 含未知内建能力` };
    }
    return { ok: true, value: [...new Set(raw)] };
  };
  const required = read(value.required, "nativeCapabilities.required");
  if (!required.ok) return required;
  const optional = read(value.optional, "nativeCapabilities.optional");
  if (!optional.ok) return optional;
  if (optional.value.some((item) => required.value.includes(item))) {
    return { ok: false, code: "role-invalid-definition", message: "内建能力不能同时是必需与可选" };
  }
  return { ok: true, value: { required: required.value, optional: optional.value } };
}

function decodeRequirements(value: unknown): AgentRoleFailure | { ok: true; value: AgentRoleRequirements } {
  if (!isJsonObject(value)) return { ok: false, code: "role-invalid-definition", message: "requirements 必须是对象" };
  if (Object.keys(value).some((key) => !(REQUIREMENT_KEYS as readonly string[]).includes(key))) {
    return { ok: false, code: "role-invalid-definition", message: "requirements 含未知字段" };
  }
  if (typeof value.imageInput !== "boolean" || typeof value.toolCalling !== "boolean" || !isAgentRoleStructuredOutput(value.structuredOutput)) {
    return { ok: false, code: "role-invalid-definition", message: "requirements 字段非法" };
  }
  return {
    ok: true,
    value: {
      imageInput: value.imageInput,
      toolCalling: value.toolCalling,
      structuredOutput: value.structuredOutput
    }
  };
}

function decodeOutput(value: unknown): AgentRoleFailure | { ok: true; value: AgentRoleOutput } {
  if (!isJsonObject(value) || typeof value.kind !== "string" || !(OUTPUT_KINDS as readonly string[]).includes(value.kind)) {
    return { ok: false, code: "role-invalid-definition", message: "output.kind 非法" };
  }
  if (value.kind === "candidate") {
    const schema = decodeJsonSchema(value.schema);
    if (!schema.ok) return schema;
    return { ok: true, value: { kind: "candidate", schema: schema.value } };
  }
  if (Object.keys(value).some((key) => key !== "kind")) {
    return { ok: false, code: "role-invalid-definition", message: "output 含未知字段" };
  }
  return { ok: true, value: { kind: value.kind as "reply" | "tool-receipts" } };
}

/** 仅接受可序列化的 JSON schema 对象；拒绝函数、类实例与非普通对象。 */
export function decodeJsonSchema(value: unknown): AgentRoleFailure | { ok: true; value: AgentRoleJsonSchema } {
  if (!isJsonObject(value)) return { ok: false, code: "role-invalid-definition", message: "schema 必须是对象" };
  try {
    const copy = JSON.parse(JSON.stringify(value)) as unknown;
    if (!isJsonObject(copy)) return { ok: false, code: "role-invalid-definition", message: "schema 必须是可序列化对象" };
    return { ok: true, value: copy };
  } catch {
    return { ok: false, code: "role-invalid-definition", message: "schema 必须是可序列化对象" };
  }
}

/**
 * 校验角色定义形状（严格拒绝未知字段）。
 *
 * 定义里出现 owner/connection/model/credential 等就应被拒绝：那些属于执行与授权，不属于角色。
 */
export function decodeAgentRoleDefinition(value: unknown): AgentRoleFailure | { ok: true; value: AgentRoleDefinition } {
  if (!isJsonObject(value)) return { ok: false, code: "role-invalid-definition", message: "角色定义必须是对象" };
  const unknownKey = Object.keys(value).find((key) => !(DEFINITION_KEYS as readonly string[]).includes(key));
  if (unknownKey) {
    const forbidden = ["model", "connectionId", "owner", "credential", "apiKey", "endpoint", "provider", "account"].includes(unknownKey);
    return {
      ok: false,
      code: forbidden ? "role-forbidden-field" : "role-invalid-definition",
      message: `角色定义不允许字段：${unknownKey}`
    };
  }
  if (typeof value.id !== "string" || !ROLE_ID_PATTERN.test(value.id)) {
    return { ok: false, code: "role-invalid-definition", message: "角色 id 非法" };
  }
  for (const key of ["revision", "title", "specialty", "instructions"] as const) {
    if (typeof value[key] !== "string" || value[key].trim() === "") {
      return { ok: false, code: "role-invalid-definition", message: `角色 ${key} 必须是非空字符串` };
    }
  }
  if ((value.instructions as string).length > 20_000) {
    return { ok: false, code: "role-invalid-definition", message: "角色指令过长" };
  }
  const inputSchema = decodeJsonSchema(value.inputSchema);
  if (!inputSchema.ok) return inputSchema;
  const contextSchema = decodeJsonSchema(value.contextSchema);
  if (!contextSchema.ok) return contextSchema;
  const tools = decodeToolset(value.tools);
  if (!tools.ok) return tools;
  const native = decodeNative(value.nativeCapabilities);
  if (!native.ok) return native;
  const requirements = decodeRequirements(value.requirements);
  if (!requirements.ok) return requirements;
  const output = decodeOutput(value.output);
  if (!output.ok) return output;
  return {
    ok: true,
    value: {
      id: value.id as string,
      revision: value.revision as string,
      title: value.title as string,
      specialty: value.specialty as string,
      instructions: value.instructions as string,
      inputSchema: inputSchema.value,
      contextSchema: contextSchema.value,
      tools: tools.value,
      nativeCapabilities: native.value,
      requirements: requirements.value,
      output: output.value
    }
  };
}

/** 校验注册的实现形状（定义 + prepare 函数）。 */
export function decodeAgentRoleImplementation(value: unknown): AgentRoleFailure | { ok: true; value: AgentRoleImplementation } {
  if (!isJsonObject(value) || typeof value.prepare !== "function") {
    return { ok: false, code: "role-invalid-definition", message: "角色实现缺少 prepare" };
  }
  const unknownKey = Object.keys(value).find((key) => key !== "definition" && key !== "prepare");
  if (unknownKey) return { ok: false, code: "role-invalid-definition", message: `角色实现不允许字段：${unknownKey}` };
  const definition = decodeAgentRoleDefinition(value.definition);
  if (!definition.ok) return definition;
  return { ok: true, value: { definition: definition.value, prepare: value.prepare as AgentRoleImplementation["prepare"] } };
}

/** 定义内容摘要（不含实现制品）。 */
export function agentRoleDescriptorDigest(definition: AgentRoleDefinition): string {
  return sha256Hex(stableStringify(definition));
}

export function agentRoleNamespacedId(extensionId: string, roleId: string): string {
  return `${extensionId}/${roleId}`;
}

export function makeAgentRoleRef(input: {
  extensionId: string;
  roleId: string;
  revision: string;
  descriptorDigest: string;
  artifactId: string;
  configVersion?: number;
}): AgentRoleRef {
  return {
    namespacedId: agentRoleNamespacedId(input.extensionId, input.roleId),
    roleId: input.roleId,
    extensionId: input.extensionId,
    revision: input.revision,
    descriptorDigest: input.descriptorDigest,
    artifactId: input.artifactId,
    ...(input.configVersion !== undefined ? { configVersion: input.configVersion } : {})
  };
}

export function agentRoleRefEquals(left: AgentRoleRef | null | undefined, right: AgentRoleRef | null | undefined): boolean {
  if (!left || !right) return left === right;
  return (
    left.namespacedId === right.namespacedId &&
    left.revision === right.revision &&
    left.descriptorDigest === right.descriptorDigest &&
    left.artifactId === right.artifactId &&
    (left.configVersion ?? 0) === (right.configVersion ?? 0)
  );
}

export function isAgentRoleRef(value: unknown): value is AgentRoleRef {
  if (!isJsonObject(value)) return false;
  return (
    isBoundedId(value.namespacedId) &&
    isBoundedId(value.roleId) &&
    isBoundedId(value.extensionId) &&
    typeof value.revision === "string" && value.revision.length > 0 &&
    typeof value.descriptorDigest === "string" && value.descriptorDigest.length > 0 &&
    typeof value.artifactId === "string" && value.artifactId.length > 0 &&
    (value.configVersion === undefined || Number.isSafeInteger(value.configVersion))
  );
}

function decodeMessages(value: unknown): AgentRoleFailure | { ok: true; value: AgentPromptMessage[] } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, code: "role-prepare-failed", message: "prepare 必须返回至少一条消息" };
  }
  const messages: AgentPromptMessage[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry) || (entry.role !== "system" && entry.role !== "user" && entry.role !== "assistant") || typeof entry.content !== "string") {
      return { ok: false, code: "role-prepare-failed", message: "prepare 返回了非法消息" };
    }
    messages.push({ role: entry.role, content: entry.content });
  }
  return { ok: true, value: messages };
}

/**
 * 校验 prepare 结果：消息合法，且工具收窄集合必须是声明的子集。
 *
 * 角色不能借 prepare 引入未声明的工具或内建能力。
 */
export function decodeAgentRolePrompt(
  value: unknown,
  allowedTools: readonly string[]
): AgentRoleFailure | { ok: true; value: AgentRolePrompt } {
  if (!isJsonObject(value)) return { ok: false, code: "role-prepare-failed", message: "prepare 必须返回对象" };
  const unknownKey = Object.keys(value).find((key) => key !== "messages" && key !== "tools");
  if (unknownKey) return { ok: false, code: "role-prepare-failed", message: `prepare 不允许字段：${unknownKey}` };
  const messages = decodeMessages(value.messages);
  if (!messages.ok) return messages;
  if (value.tools === undefined) return { ok: true, value: { messages: messages.value } };
  const tools = normalizeAgentRoleToolNames(value.tools);
  if (!tools.ok) return { ok: false, code: "role-prepare-failed", message: tools.message };
  const allowed = new Set(allowedTools);
  const escaped = tools.value.filter((tool) => !allowed.has(tool));
  if (escaped.length > 0) {
    return { ok: false, code: "role-prepare-failed", message: `prepare 不能引入未声明的工具：${escaped.join(", ")}` };
  }
  return { ok: true, value: { messages: messages.value, tools: tools.value } };
}

/** 合成规范消息：definition.instructions 始终在最前，prepare 不得覆盖它。 */
export function composeAgentRoleMessages(
  instructions: string,
  prepared: readonly AgentPromptMessage[]
): AgentPromptMessage[] {
  const system: AgentPromptMessage = { role: "system", content: instructions };
  const rest = prepared[0]?.role === "system"
    ? [{ ...prepared[0], content: `${instructions}\n\n${prepared[0].content}` }, ...prepared.slice(1)]
    : [system, ...prepared];
  return rest;
}

export type AgentRoleDigestInput = {
  input: unknown;
  context: unknown;
  attachments?: readonly unknown[];
};

export function agentRoleTurnDigests(values: AgentRoleDigestInput): {
  inputDigest: string;
  contextDigest: string;
  attachmentDigests: string[];
} {
  return {
    inputDigest: sha256Hex(stableStringify(values.input ?? null)),
    contextDigest: sha256Hex(stableStringify(values.context ?? null)),
    attachmentDigests: (values.attachments ?? []).map((entry) => sha256Hex(stableStringify(entry ?? null)))
  };
}

export function preparedTurnHash(turn: Omit<PreparedAgentRoleTurn, "preparedHash">): string {
  return sha256Hex(stableStringify(turn));
}

/** 严格解码可序列化 prepared turn（仅供宿主内部恢复/核对，不用于浏览器请求）。 */
export function decodePreparedAgentRoleTurn(value: unknown): AgentRoleFailure | { ok: true; value: PreparedAgentRoleTurn } {
  if (!isJsonObject(value)) return { ok: false, code: "role-version-conflict", message: "prepared turn 必须是对象" };
  if (value.schemaVersion !== 1 || !isAgentRoleRef(value.roleRef)) {
    return { ok: false, code: "role-version-conflict", message: "prepared turn 版本或角色身份非法" };
  }
  const messages = decodeMessages(value.messages);
  if (!messages.ok) return { ok: false, code: "role-version-conflict", message: messages.message };
  const tools = normalizeAgentRoleToolNames(value.tools);
  if (!tools.ok) return { ok: false, code: "role-version-conflict", message: tools.message };
  if (!Array.isArray(value.nativeCapabilities) || !value.nativeCapabilities.every(isAgentNativeCapability)) {
    return { ok: false, code: "role-version-conflict", message: "prepared turn 内建能力非法" };
  }
  const output = decodeOutput(value.output);
  if (!output.ok) return { ok: false, code: "role-version-conflict", message: output.message };
  const inputDigest = value.inputDigest;
  const contextDigest = value.contextDigest;
  const preparedHash = value.preparedHash;
  for (const [key, entry] of [["inputDigest", inputDigest], ["contextDigest", contextDigest], ["preparedHash", preparedHash]] as const) {
    if (typeof entry !== "string" || entry.length === 0) {
      return { ok: false, code: "role-version-conflict", message: `prepared turn 缺少 ${key}` };
    }
  }
  if (!Array.isArray(value.attachmentDigests) || !(value.attachmentDigests as unknown[]).every((entry) => typeof entry === "string")) {
    return { ok: false, code: "role-version-conflict", message: "prepared turn 附件摘要非法" };
  }
  if (!isJsonObject(value.target) || (value.target.canvasId !== undefined && !isBoundedId(value.target.canvasId))) {
    return { ok: false, code: "role-version-conflict", message: "prepared turn 目标非法" };
  }
  const workspace = value.workspace === undefined ? undefined : decodeCanvasWorkspaceHandle(value.workspace);
  if (workspace === null || (workspace && workspace.canvasId !== value.target.canvasId)) {
    return { ok: false, code: "role-version-conflict", message: "prepared turn 工作目录授权非法" };
  }
  const turn: PreparedAgentRoleTurn = {
    ...(workspace ? { workspace } : {}),
    schemaVersion: 1,
    roleRef: value.roleRef,
    messages: messages.value,
    tools: tools.value,
    nativeCapabilities: value.nativeCapabilities,
    output: output.value,
    inputDigest: inputDigest as string,
    contextDigest: contextDigest as string,
    attachmentDigests: value.attachmentDigests as string[],
    target: {
      ...(isBoundedId(value.target.canvasId) ? { canvasId: value.target.canvasId } : {}),
      ...(isBoundedId(value.target.nodeId) ? { nodeId: value.target.nodeId } : {}),
      ...(typeof value.target.mode === "string" ? { mode: value.target.mode as PreparedAgentRoleTurn["target"]["mode"] } : {}),
      ...(isBoundedId(value.target.cameraId) ? { cameraId: value.target.cameraId } : {}),
      ...(typeof value.target.expectedContentHash === "string" ? { expectedContentHash: value.target.expectedContentHash } : {}),
      ...(typeof value.target.allowSceneAreaExpansion === "boolean" ? { allowSceneAreaExpansion: value.target.allowSceneAreaExpansion } : {}),
      // worldScope 参与 preparedHash：恢复时必须保留，否则重算摘要会与原文不一致。
      ...(isJsonObject(value.target.worldScope) ? { worldScope: value.target.worldScope as never } : {})
    },
    preparedHash: preparedHash as string
  };
  const recomputed = preparedTurnHash(stripPreparedHash(turn));
  if (recomputed !== turn.preparedHash) {
    return { ok: false, code: "role-version-conflict", message: "preparedHash 与内容不一致" };
  }
  return { ok: true, value: turn };
}

export function stripPreparedHash(turn: PreparedAgentRoleTurn): Omit<PreparedAgentRoleTurn, "preparedHash"> {
  const { preparedHash: _preparedHash, ...rest } = turn;
  return rest;
}

export function isAgentRoleDescriptor(value: unknown): value is AgentRoleDescriptor {
  if (!isJsonObject(value)) return false;
  if (!isAgentRoleRef(value.ref)) return false;
  if (typeof value.title !== "string" || typeof value.specialty !== "string") return false;
  if (typeof value.available !== "boolean") return false;
  if (!isJsonObject(value.requirements)) return false;
  if (value.tools !== undefined && !isJsonObject(value.tools)) return false;
  if (value.nativeCapabilities !== undefined && !isJsonObject(value.nativeCapabilities)) return false;
  return typeof value.outputKind === "string";
}

export function isAgentRoleFailure(value: unknown): value is AgentRoleFailure {
  return isJsonObject(value) && value.ok === false && isAgentRoleErrorCode(value.code) && typeof value.message === "string";
}

/** 供诊断：稳定序列化角色定义（不含实现）。 */
export function serializeAgentRoleDefinition(definition: AgentRoleDefinition): string {
  return stableStringify(definition);
}

export function isAgentRoleStructuredOutputValue(value: unknown): value is AgentRoleStructuredOutput {
  return isAgentRoleStructuredOutput(value);
}

export function isAgentRoleSchemaObject(value: unknown): value is AgentRoleJsonSchema {
  return isJsonObject(value);
}
