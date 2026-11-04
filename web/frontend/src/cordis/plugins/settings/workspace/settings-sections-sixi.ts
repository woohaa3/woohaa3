/**
 * 四喜发行形态的设置分区（左栏一级导航）。
 *
 * 上游的 `settings-workspace.tsx` 里 `SECTIONS` 是个模块常量，列了六个分区：
 * 核心服务 / 插件配置 / 外观 / 运行时组件 / 通知 / 关于。后四个是宿主运维与开发用的：
 * - 核心服务：存储后端、对外地址提供者、遥测、插件市场 —— 四喜的数据全在服务端，
 *   这些开关留给用户只会让人把任务库指到本地某个目录，然后「生成任务说没有对外地址」；
 * - 运行时组件：下载 Codex / Claude / 模型渲染器 —— 四喜不用这些；
 * - 通知 / 关于：宿主自己的任务提醒与版本事实，和四喜的会员体系无关。
 *
 * **数据放在这里、`workspace` 只引一行**，是因为直接改 `SECTIONS` 数组会在每次合并上游时
 * 变成冲突（sd-ppp 的 rebase 台账是同一套做法）。分区组件本身仍留在上游文件里，
 * 只是不再出现在导航上：`SettingsSectionId` 类型不变，`settingsOpen.open({ section })`
 * 的签名也不会变，只是外部不该再指向被藏掉的那几个。
 *
 * **要放开某个分区，往 `SIXI_SETTINGS_SECTIONS` 里加一行即可**，渲染分支都还在。
 */

/** 左栏显示的分区 id（顺序即左栏顺序）。类型与上游 `SettingsSectionId` 保持一致。 */
export const SIXI_SETTINGS_SECTIONS = ["plugins", "appearance"] as const;

export type SixiSettingsSectionId = (typeof SIXI_SETTINGS_SECTIONS)[number];

/**
 * 打开设置时落在哪个分区。
 *
 * 必须是显示出来的分区之一：上游默认是 `backend`，藏掉之后会打开一个左栏没有选中项、
 * 正文却是存储/遥测的空视图。插件配置是四喜用户唯一真会改的地方（模型来源、密钥）。
 */
export const SIXI_SETTINGS_DEFAULT_SECTION: SixiSettingsSectionId = "plugins";

/** 某个分区当前是否显示；外部（`settingsOpen.open`）据此把请求收敛到默认分区。 */
export function isSixiSettingsSectionVisible(id: string): id is SixiSettingsSectionId {
  return (SIXI_SETTINGS_SECTIONS as readonly string[]).includes(id);
}
