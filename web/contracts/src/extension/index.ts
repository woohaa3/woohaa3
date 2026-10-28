/**
 * 扩展与宿主之间的共享契约。
 *
 * 根上只有两份形状：插件自己（`plugin`）和装载后 `ctx` 上的服务（`service`）。
 * 站点清单、身份、浏览器加载、画布外部来源在 `host/`。
 * 会话、连接、执行和文本生成在 `assistant/`。
 */
export * from "./plugin.js";
export * from "./service.js";
export * from "./host/index.js";
export * from "./assistant/index.js";
