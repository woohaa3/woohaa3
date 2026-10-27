/**
 * `ctx.capabilities`：能力注册面。
 *
 * 服务契约在这里定义，宿主提供注册表实现；扩展把能力对象交给宿主，由核心层按 id 解析。
 */
export type HostCapabilityService = {
  /** 注册一个能力对象；返回注销函数。重复 id 抛错（不同插件不能抢同一个能力）。 */
  register(id: string, value: unknown): () => void;
};
