/**
 * `ctx.capabilities`：能力注册面。
 *
 * 服务契约在这里定义，宿主提供注册表实现；扩展把能力对象交给宿主，由核心层按 id 解析。
 *
 * ## 为什么要带 `version`（change: 2026-11-13-add-extension-capability-abi）
 *
 * 跨扩展依赖此前只有 `id` 是契约，`value` 是 `unknown`：生产方把
 * `agent-conversation-adapter:remote-assistant` 的 value 从 `{discussion, textDelivery}` 改成
 * `{discuss, text}`，消费方**双方都不会有任何编译或装载期报错**，只会在某次属性访问上炸。
 *
 * 加上 `version` 后，`id@version` 才是能力的完整身份：
 *
 * - 同一 `id` 的不同 `version` **并存**，互不覆盖——所以提供一个新形状不会静默顶掉旧的；
 * - 消费方按自己需要的 `version` 解析，拿不到就是 `undefined`，可以按自己的策略降级；
 * - 插件在 `extension.json` 的 `engines.capabilities` 里声明所需版本，装载期就能判定兼容性。
 *
 * `version` 是**人工推进的整数**，规则与 `HOST_SERVICE_ABI` 一致：破坏性变更抬版本，
 * 纯增量不抬。
 */

/** 一次能力注册。`value` 的形状由该 `id` + `version` 共同约定。 */
export type CapabilityRegistration = {
  /** 能力标识（kebab 或 `namespace:name` 形式，由各自的领域约定）。 */
  id: string;
  /** 该能力对象的形状版本。同 id 不同 version 并存。 */
  version: number;
  /** 能力对象本身；形状由消费方按 id + version 解释。 */
  value: unknown;
};

export type HostCapabilityService = {
  /**
   * 注册一个能力对象；返回注销函数。
   *
   * 同一 `id` + `version` 重复注册抛错（不同插件不能抢同一个能力）；同一 `id` 的其它 `version`
   * 不受影响。
   */
  register(registration: CapabilityRegistration): () => void;
};
