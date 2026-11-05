/**
 * 四喜发行形态：画布上不出现的「生成模型与导演区」入口。
 *
 * 同一个浮窗在宿主里有三个入口，全部走 `openTarget(nodeId)`：
 *   1. 节点动作横条 `canvas.node-action`（文案「转 3D」）—— **四喜保留**；
 *   2. 右键菜单 `canvas.context-menu`（文案「生成模型与导演区」）—— 这里隐藏；
 *   3. 图片聚焦页顶栏图标 `canvas.focus-header`（title 同为「生成模型与导演区」）—— 这里隐藏。
 *
 * 为什么只留横条那个：横条的「转 3D」是四喜用户在画布上唯一认得的入口，位置也最顺手；
 * 另外两处是同一个浮窗的第二、第三个门，功能完全重复，而「生成模型与导演区」这个名字
 * 对四喜用户没有意义（点开其实是一个「拿这张图当参考、跟助手聊着生成新场景」的面板）。
 * 留三个名字不同、点开是同一个东西的入口，只会让人以为是三个功能。
 *
 * 与 `settings-plugins-sixi.ts`、`task-execution/workspace/generation-trace-sixi.ts` 同一套做法：
 * 清单放这里，上游只在两个注册处各加一句判断，不删注册流程、不改浮窗本身。
 */

/**
 * 隐藏清单。加一行即可多藏一个入口。
 *
 * - `context-menu`：右键菜单里的「生成模型与导演区」。
 * - `focus-header`：图片聚焦页顶栏的 ✦ 图标（title 为「生成模型与导演区」）。
 *
 * `node-action`（「转 3D」）**不在此列**：那是四喜保留的唯一入口。
 */
export const SIXI_HIDDEN_IMAGE_DIRECTOR_ENTRIES: readonly string[] = ["context-menu", "focus-header"];

/** 这个入口在四喜发行形态下是否隐藏。纯函数，菜单/聚焦页每次渲染都能调。 */
export function isSixiHiddenImageDirectorEntry(entry: "context-menu" | "focus-header"): boolean {
  return SIXI_HIDDEN_IMAGE_DIRECTOR_ENTRIES.includes(entry);
}
