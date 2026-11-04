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

/**
 * 设置页插件列表里隐藏的扩展 id。加一行即可隐藏，不用动 `plugin-groups.ts` 的实现。
 *
 * - `ppserver-provider`：生图的唯一执行者，必须装配；但行上有 6 项配置（地址、令牌…）、
 *   34 个模型和一个启停开关，客户改掉或关掉就是「生成失败 / 401」。四喜的模型选择在
 *   自己的面板里，不需要看见这个 Provider。
 * - `sqlite-storage` / `local-storage`：存储槽位与本地对象存储后端。它们是宿主基础设施，
 *   对客户没有可调的意义；改坏了表现是画布/素材读写失败。
 * - `sixi-spike`：四喜前端本体。客户看到的每一页都是它，设置里再列一条「四喜（迁移 spike）」
 *   只会让人以为这是个能卸掉的插件 —— 卸掉等于四喜整个消失。
 *
 * 隐藏只作用于设置列表与详情入口：装配、`/api/settings` 快照、生成链路都不受影响。
 */
export const SIXI_HIDDEN_SETTINGS_PLUGINS: readonly string[] = [
  "ppserver-provider",
  "sqlite-storage",
  "local-storage",
  "sixi-spike"
];

/** 这个插件在设置列表里是否隐藏。纯函数，`indexPlugins` 每次重算都能调。 */
export function isSixiHiddenSettingsPlugin(id: string): boolean {
  return SIXI_HIDDEN_SETTINGS_PLUGINS.includes(id);
}

/**
 * 是否允许在设置里「添加扩展」（右下角悬浮 `+` → 市场 / 文件安装）。
 *
 * 四喜发行版关掉：那是宿主的开发者入口，能装任意第三方插件 ——
 * 从市场装进来的扩展落在受管目录 `.woohaa3/extensions`，与发行包无关，
 * 但**能装**本身就会让客户以为可以自行扩展，装坏了还会污染同一份数据目录。
 *
 * 客户端要随包发布的扩展走另一条路：目录进 `web/extensions/<id>/`，
 * 再把 id 加进 `scripts/lib/sixi-extension-inventory.json`，重新打包。
 *
 * 排查时想临时装一个，把 `WOOHAA3_DESKTOP_DEV` 之类的手段没有意义 ——
 * 这是前端常量，改这一行重新构建即可。
 */
export const SIXI_ALLOW_EXTENSION_INSTALL = false;
