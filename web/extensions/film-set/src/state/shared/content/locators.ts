import type { ContentNodeLocator } from "@woohaa3/contracts";

/**
 * 片场 group marker 的序列化定位声明（change: 2026-10-28-generic-extension-content-ownership，任务 1.2）。
 *
 * 内核只按节点类别和字段名判断「声明属于谁」；字段内容仍由 `filmSetInteractionPolicy`
 * 与 owner codec 解码，不把 marker 存在当成写授权。
 */
export const filmSetOwnerLocators: readonly ContentNodeLocator[] = [
  { nodeTypes: ["group"], fields: ["filmSetGroup"] }
];
