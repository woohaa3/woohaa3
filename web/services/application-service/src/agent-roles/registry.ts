/**
 * 核心 Agent 角色注册表与准备协调（change: 2026-11-07-add-pluggable-agent-roles）。
 *
 * 只做四件事：
 * 1. 按**可信扩展 owner** 登记角色实现，拒绝重复完整身份，并在扩展停用时收回；
 * 2. 只读投影角色目录与可用性（不准备、不推理）；
 * 3. 用角色允许集合 ∩ 收窄集合 ∩ 实际工具目录 ∩ 通道能力求交，缺失 required 即拒绝；
 * 4. 调用确定性 `prepare`，校验它只能收窄，产出可重放的 `PreparedAgentRoleTurn`。
 *
 * 这里不认识任何业务角色 ID，也不签发工具授权或写作品。
 */
import type {
  AgentNativeCapability,
  AgentPromptMessage,
  AgentRoleChannelCapabilities,
  AgentRoleDefinition,
  AgentRoleDescriptor,
  AgentRoleFailure,
  AgentRoleImplementation,
  AgentRoleRef,
  AgentRoleTargetRef,
  PreparedAgentRoleTurn
} from "@woohaa3/contracts";
import {
  agentRoleDescriptorDigest,
  agentRoleFailure,
  agentRoleRefEquals,
  agentRoleTurnDigests,
  composeAgentRoleMessages,
  decodeAgentRoleImplementation,
  decodeAgentRolePrompt,
  makeAgentRoleRef,
  normalizeAgentRoleToolNames,
  preparedTurnHash,
  validateAgentRoleValue
} from "@woohaa3/contracts";

export type RegisteredAgentRole = {
  readonly ref: AgentRoleRef;
  readonly definition: AgentRoleDefinition;
  readonly implementation: AgentRoleImplementation;
  readonly extensionId: string;
  readonly configVersion: number;
  readonly registeredAt: string;
};

export type AgentRoleRegisterInput = {
  /** 实际装载上下文给出的扩展身份；插件不能自报别的扩展。 */
  extensionId: string;
  implementation: AgentRoleImplementation;
  /** 宿主确认的实现制品身份（模块位置/版本），与定义摘要分开保存。 */
  artifactId: string;
  configVersion?: number;
};

export type AgentRolePrepareRequest = {
  roleId: string;
  input: unknown;
  context: unknown;
  target: AgentRoleTargetRef;
  requestId: string;
  expectedContentHash?: string;
  channel: AgentRoleChannelCapabilities;
  /** 业务入口显式收窄（只能是角色声明子集）。 */
  requestedTools?: readonly string[];
  attachments?: readonly unknown[];
};

export type AgentRolePrepareResult = { ok: true; turn: PreparedAgentRoleTurn } | AgentRoleFailure;

export type AgentRoleRegistryOptions = {
  /** 当前**实际注册**的工具目录；缺省为空（require 工具的角色因此不可用）。 */
  availableTools?: () => readonly string[];
  now?: () => string;
  logger?: (event: Record<string, unknown>) => void;
};

export type AgentRoleUnregisteredListener = (ref: AgentRoleRef, reason: "disposed" | "extension-disposed") => void;

export type AgentRoleRegistry = {
  register(input: AgentRoleRegisterInput): { ok: true; dispose: () => void } | AgentRoleFailure;
  /** 扩展停用/回滚：收回它的全部角色并通知监听者（用于精确取消与 grant 撤销）。 */
  disposeExtension(extensionId: string): void;
  resolve(namespacedId: string): RegisteredAgentRole | null;
  list(): readonly AgentRoleDescriptor[];
  listForExtension(extensionId: string): readonly AgentRoleDescriptor[];
  availability(namespacedId: string, channel?: AgentRoleChannelCapabilities): { available: boolean; reason?: string; missing?: readonly string[] };
  prepare(request: AgentRolePrepareRequest): AgentRolePrepareResult;
  /** 冻结实现仍在本进程内且定义未变（重放/重传核对用，不重新准备）。 */
  matchesFrozen(ref: AgentRoleRef): boolean;
  onUnregistered(listener: AgentRoleUnregisteredListener): () => void;
  /** 让每个注册面按扩展身份拿到带记账的 facade。 */
  forExtension(extensionId: string, configVersion?: number, artifactId?: string): {
    register: (implementation: AgentRoleImplementation) => () => void;
    list: () => readonly AgentRoleDescriptor[];
    availability: (namespacedId: string) => { available: boolean; reason?: string };
  };
};

function channelMissing(definition: AgentRoleDefinition, channel: AgentRoleChannelCapabilities): string[] {
  const missing: string[] = [];
  if (definition.requirements.toolCalling && !channel.toolCalling) missing.push("tool-calling");
  if (definition.requirements.imageInput && !channel.imageInput) missing.push("image-input");
  const structured = definition.requirements.structuredOutput;
  if (structured === "schema-enforced" && channel.structuredOutput !== "schema-enforced") missing.push("structured-output:schema-enforced");
  if (structured === "validated-json" && channel.structuredOutput === "none") missing.push("structured-output:validated-json");
  for (const capability of definition.nativeCapabilities.required) {
    if (!channel.nativeCapabilities.includes(capability)) missing.push(`native:${capability}`);
  }
  return missing;
}

export function createAgentRoleRegistry(options: AgentRoleRegistryOptions = {}): AgentRoleRegistry {
  const roles = new Map<string, RegisteredAgentRole>();
  const listeners = new Set<AgentRoleUnregisteredListener>();
  const now = options.now ?? (() => new Date().toISOString());
  const log = options.logger ?? (() => undefined);
  const tools = () => new Set(options.availableTools?.() ?? []);

  const notify = (ref: AgentRoleRef, reason: "disposed" | "extension-disposed") => {
    for (const listener of listeners) {
      try {
        listener(ref, reason);
      } catch (error) {
        log({ event: "agent-role-unregister-listener-failed", role: ref.namespacedId, message: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  const descriptor = (role: RegisteredAgentRole, channel?: AgentRoleChannelCapabilities): AgentRoleDescriptor => {
    const available = tools();
    const missingRequired = role.definition.tools.required.filter((tool) => !available.has(tool));
    const channelMissingItems = channel ? channelMissing(role.definition, channel) : [];
    const missing = [...missingRequired.map((tool) => `tool:${tool}`), ...channelMissingItems];
    return {
      ref: role.ref,
      title: role.definition.title,
      specialty: role.definition.specialty,
      requirements: role.definition.requirements,
      tools: role.definition.tools,
      nativeCapabilities: role.definition.nativeCapabilities,
      outputKind: role.definition.output.kind,
      available: missing.length === 0,
      ...(missing.length > 0 ? { reason: `缺少必要能力：${missing.join(", ")}`, missing } : {})
    };
  };

  const availability = (namespacedId: string, channel?: AgentRoleChannelCapabilities) => {
    const role = roles.get(namespacedId);
    if (!role) return { available: false, reason: "角色未注册或所属插件未启用", missing: [`role:${namespacedId}`] } as const;
    const entry = descriptor(role, channel);
    return entry.available
      ? { available: true } as const
      : { available: false, reason: entry.reason, missing: entry.missing ?? ["role-unavailable"] } as const;
  };

  const prepare: AgentRoleRegistry["prepare"] = (request) => {
    const role = roles.get(request.roleId);
    if (!role) return agentRoleFailure("role-not-found", `角色不存在或未启用：${request.roleId}`);
    const definition = role.definition;
    const inputViolation = validateAgentRoleValue(definition.inputSchema, request.input);
    if (inputViolation) return agentRoleFailure("role-input-invalid", `角色输入非法：${inputViolation.path} ${inputViolation.message}`);
    const contextViolation = validateAgentRoleValue(definition.contextSchema, request.context);
    if (contextViolation) return agentRoleFailure("role-context-invalid", `角色上下文非法：${contextViolation.path} ${contextViolation.message}`);

    const declared = [...definition.tools.required, ...definition.tools.optional];
    const declaredSet = new Set(declared);
    let narrowed = declared;
    if (request.requestedTools !== undefined) {
      const normalized = normalizeAgentRoleToolNames(request.requestedTools);
      if (!normalized.ok) return agentRoleFailure("role-input-invalid", normalized.message);
      const escaped = normalized.value.filter((tool) => !declaredSet.has(tool));
      // prepare 收窄不能引入未声明的工具；业务入口也不能凭空扩大角色边界。
      if (escaped.length > 0) return agentRoleFailure("role-input-invalid", `请求包含角色未声明的工具：${escaped.join(", ")}`);
      narrowed = [...definition.tools.required, ...normalized.value.filter((tool) => !definition.tools.required.includes(tool))];
    }

    const missingChannel = channelMissing(definition, request.channel);
    if (missingChannel.length > 0) {
      return agentRoleFailure("role-requirement-unsatisfied", `所选执行通道不满足角色要求：${missingChannel.join(", ")}`, missingChannel);
    }

    const native: AgentNativeCapability[] = [
      ...definition.nativeCapabilities.required,
      ...definition.nativeCapabilities.optional.filter((capability) => request.channel.nativeCapabilities.includes(capability))
    ];
    let preparedMessage: { messages: readonly AgentPromptMessage[]; tools?: readonly string[] };
    try {
      const raw = role.implementation.prepare({
        input: request.input,
        context: request.context,
        target: request.target,
        requestId: request.requestId,
        ...(request.expectedContentHash !== undefined ? { expectedContentHash: request.expectedContentHash } : {}),
        nativeCapabilities: native
      });
      const decoded = decodeAgentRolePrompt(raw, declared);
      if (!decoded.ok) return decoded;
      preparedMessage = decoded.value;
    } catch (error) {
      return agentRoleFailure("role-prepare-failed", `角色准备失败：${error instanceof Error ? error.message : String(error)}`);
    }

    const allowedNow = new Set(narrowed);
    const promptNarrowed = preparedMessage.tools
      ? narrowed.filter((tool) => preparedMessage.tools!.includes(tool))
      : narrowed;
    const catalog = tools();
    const finalTools = request.channel.toolCalling ? promptNarrowed.filter((tool) => catalog.has(tool)) : [];
    const missingRequired = definition.tools.required.filter((tool) => !finalTools.includes(tool));
    if (missingRequired.length > 0) {
      return agentRoleFailure(
        "role-requirement-unsatisfied",
        `本轮缺少必要工具：${missingRequired.join(", ")}`,
        missingRequired.map((tool) => `tool:${tool}`)
      );
    }
    // prompt 收窄后仍需保持声明子集（防御 prepare 返回未声明项的实现错误）。
    if (preparedMessage.tools && preparedMessage.tools.some((tool) => !allowedNow.has(tool))) {
      return agentRoleFailure("role-prepare-failed", "prepare 收窄集合越界");
    }

    const digests = agentRoleTurnDigests({ input: request.input, context: request.context, attachments: request.attachments });
    const turnWithoutHash: Omit<PreparedAgentRoleTurn, "preparedHash"> = {
      schemaVersion: 1,
      roleRef: role.ref,
      messages: composeAgentRoleMessages(definition.instructions, preparedMessage.messages),
      tools: finalTools,
      nativeCapabilities: native satisfies AgentNativeCapability[],
      output: definition.output,
      inputDigest: digests.inputDigest,
      contextDigest: digests.contextDigest,
      attachmentDigests: digests.attachmentDigests,
      target: request.target
    };
    return {
      ok: true,
      turn: { ...turnWithoutHash, preparedHash: preparedTurnHash(turnWithoutHash) }
    };
  };

  const registry: AgentRoleRegistry = {
    register(input) {
      const decoded = decodeAgentRoleImplementation(input.implementation);
      if (!decoded.ok) return decoded;
      if (!input.extensionId || !input.artifactId) {
        return agentRoleFailure("role-invalid-definition", "缺少可信扩展身份或实现制品身份");
      }
      const definition = decoded.value.definition;
      const ref = makeAgentRoleRef({
        extensionId: input.extensionId,
        roleId: definition.id,
        revision: definition.revision,
        descriptorDigest: agentRoleDescriptorDigest(definition),
        artifactId: input.artifactId,
        configVersion: input.configVersion
      });
      const existing = roles.get(ref.namespacedId);
      if (existing) {
        return agentRoleFailure("role-duplicate", `角色已注册：${ref.namespacedId}`);
      }
      const registered: RegisteredAgentRole = {
        ref,
        definition,
        implementation: decoded.value,
        extensionId: input.extensionId,
        configVersion: input.configVersion ?? 0,
        registeredAt: now()
      };
      roles.set(ref.namespacedId, registered);
      log({ event: "agent-role-registered", role: ref.namespacedId, revision: ref.revision });
      let disposed = false;
      return {
        ok: true,
        dispose: () => {
          if (disposed) return;
          disposed = true;
          if (roles.get(ref.namespacedId) !== registered) return;
          roles.delete(ref.namespacedId);
          log({ event: "agent-role-unregistered", role: ref.namespacedId });
          notify(ref, "disposed");
        }
      };
    },

    disposeExtension(extensionId) {
      for (const [namespacedId, role] of [...roles]) {
        if (role.extensionId !== extensionId) continue;
        roles.delete(namespacedId);
        log({ event: "agent-role-extension-disposed", role: namespacedId, extensionId });
        notify(role.ref, "extension-disposed");
      }
    },

    resolve: (namespacedId) => roles.get(namespacedId) ?? null,
    list: () => [...roles.values()].map((role) => descriptor(role)),
    listForExtension: (extensionId) => [...roles.values()].filter((role) => role.extensionId === extensionId).map((role) => descriptor(role)),
    availability,
    prepare,
    matchesFrozen(ref) {
      const role = roles.get(ref.namespacedId);
      if (!role) return false;
      return agentRoleRefEquals(role.ref, ref) && agentRoleDescriptorDigest(role.definition) === ref.descriptorDigest;
    },
    onUnregistered(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    forExtension(extensionId, configVersion = 0, artifactId = `inproc:${extensionId}@${configVersion}`) {
      return {
        register: (implementation) => {
          const registered = registry.register({ extensionId, implementation, artifactId, configVersion });
          if (!registered.ok) {
            throw Object.assign(new Error(registered.message), { code: registered.code, roleFailure: registered });
          }
          return registered.dispose;
        },
        list: () => registry.listForExtension(extensionId),
        availability: (namespacedId) => {
          const role = roles.get(namespacedId);
          return role && role.extensionId === extensionId
            ? { available: descriptor(role).available, ...(descriptor(role).reason ? { reason: descriptor(role).reason } : {}) }
            : { available: false, reason: "角色不属于本扩展" };
        }
      };
    }
  };
  return registry;
}
