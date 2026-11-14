/**
 * 宿主对外服务面的 ABI 版本（change: 2026-11-13-add-extension-capability-abi）。
 *
 * `HostExtensionContext` 上的每个属性都是插件在**编写阶段**就依赖的形状：插件写
 * `inject: ["generation", "storage"]`，然后按 `HostGenerationService` / `HostStorageService`
 * 的成员调用。这些类型演化时，既有 `engines.hostAbi` 完全感知不到——它描述的是「后端 SDK 大致长
 * 什么样」，不是「哪个服务面的形状变了」。
 *
 * 这里按**服务面**各给一个整数版本：某个面发生破坏性变更时只抬高它，依赖其余面的插件不受影响。
 *
 * ## 推进规则
 *
 * - **破坏性变更 MUST 抬版本**：删除成员、改签名或参数类型、改变成员语义（同名不同义）。
 * - **纯增量 SHALL NOT 抬版本**：新增可选成员、放宽参数类型。这类变化旧插件仍能正确工作，
 *   抬版本只会让所有依赖者被迫跟着改 `extension.json`。
 * - 版本是**人工推进**的整数，不做类型哈希派生：类型里含别名与泛型，哈希不稳定；且「类型变了」
 *   不等于「不兼容」，只有作者能判断。
 *
 * ## 为什么不做 semver
 *
 * 与 `EXTENSION_SDK_ABI_VERSION` / `protocolVersion` 同一口径：首版用**精确相等**判定，不做未经
 * 实现验证的兼容推断。等真的出现「加可选成员也要能区分」的需求时再放开，届时有证据决定规则。
 *
 * ## 与 `engines.hostAbi` 的关系
 *
 * 两者并列、互不替代：`hostAbi` 描述 SDK 整体契约（扩展工厂签名、context 的可选性等），
 * `HOST_SERVICE_ABI` 描述**逐个服务面**。插件在 `extension.json` 里声明：
 *
 * ```json
 * "engines": { "hostAbi": "^1.0.0", "host": { "generation": 1, "storage": 1 } }
 * ```
 *
 * 未在 `engines.host` 里出现的面视为**不依赖**（过渡期语义，见 `docs/security/COMPATIBILITY.md`）。
 */

/** 服务面名 → 所需（或宿主提供）的整数版本。 */
export type HostServiceRequirement = Readonly<Record<string, number>>;

/**
 * 宿主当前提供的服务面版本。
 *
 * 键必须与 `HostExtensionContext` 上的服务面属性一一对应；新增服务面时同时在这里登记，
 * 否则插件无从声明对它的依赖（`host-service-abi.test.ts` 守着这条一致性）。
 */
export const HOST_SERVICE_ABI = Object.freeze({
  /** `ctx.log`：结构化日志。 */
  log: 1,
  /** `ctx.config`：宿主配置读取（可选面）。 */
  config: 1,
  /** `ctx.generation`：模型 Provider 注册与策略。 */
  generation: 1,
  /** `ctx.storage`：字节存储后端注册。 */
  storage: 1,
  /** `ctx.exposer`：对外地址提供者。 */
  exposer: 1,
  /** `ctx.marketplace`：扩展市场来源注册。 */
  marketplace: 1,
  /** `ctx.webServer`：受控 HTTP 路由（可选面）。 */
  webServer: 1,
  /** `ctx.services`：领域服务 facade（可选面）。 */
  services: 1,
  /** `ctx.telemetry`：遥测核心。 */
  telemetry: 1,
  /** `ctx.capabilities`：能力注册表（可选面）。 */
  capabilities: 1,
  /** `ctx.mediaFormats`：可编辑媒体格式注册（可选面）。 */
  mediaFormats: 1,
  /** `ctx.agentRoles`：Agent 角色注册（可选面）。 */
  agentRoles: 1,
  /** `ctx.executors`：独立执行模块注册（可选面）。 */
  executors: 1
} as const satisfies HostServiceRequirement);

export type HostServiceName = keyof typeof HOST_SERVICE_ABI;

/** 宿主提供的某个服务面版本；未知服务面返回 `undefined`。 */
export function hostServiceAbi(name: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(HOST_SERVICE_ABI, name)
    ? HOST_SERVICE_ABI[name as HostServiceName]
    : undefined;
}

/** 全部服务面名（稳定排序，便于生成清单与错误信息）。 */
export function hostServiceNames(): readonly HostServiceName[] {
  return Object.keys(HOST_SERVICE_ABI).sort() as HostServiceName[];
}
