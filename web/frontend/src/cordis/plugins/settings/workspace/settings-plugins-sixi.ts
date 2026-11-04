/**
 * 四喜发行形态：设置页「插件配置」里不该出现的插件。
 *
 * 与 `settings-sections-sixi.ts` 同一套做法 —— 规则放在我们自己的文件，只在上游那个
 * 纯函数 `indexPlugins` 里加一句过滤，不删行、不改分组逻辑。
 *
 * 为什么是「隐藏行」而不是「不装配」：
 * `ppserver-provider` 是生图/生视频的唯一执行者（任务路由 `/tasks/*`、模板目录、模型清单），
 * 四喜的每一次生成都走它。**必须继续装配**，否则生成整条链路直接断。
 * 它的问题是「对客户暴露了什么」：那一行上有 6 项配置（ppserver 地址、令牌…）、
 * 34 个模型、一个启停开关 —— 客户改了或关了，表现是「生成失败 / 401」，而且会拿来抱怨。
 * 四喜用户的模型选择在四喜自己的模型面板里，不需要看见这个 Provider。
 *
 * 隐藏只作用于设置列表：装配、`/api/settings` 快照、生成任务、模型目录都不受影响。
 * 内部要看它时，从「核心服务」的存储/生成页签与四喜的模型面板仍能看到它提供的模型。
 */

/** 设置页插件列表里隐藏的扩展 id。加一行即可隐藏，不用动 `plugin-groups.ts` 的实现。 */
export const SIXI_HIDDEN_SETTINGS_PLUGINS: readonly string[] = ["ppserver-provider"];

/** 这个插件在设置列表里是否隐藏。纯函数，`indexPlugins` 每次重算都能调。 */
export function isSixiHiddenSettingsPlugin(id: string): boolean {
  return SIXI_HIDDEN_SETTINGS_PLUGINS.includes(id);
}
