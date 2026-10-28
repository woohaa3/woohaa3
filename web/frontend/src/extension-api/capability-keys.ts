/**
 * Extension 公共 capability key 常量
 * （change: 2026-10-10-extract-optional-feature-extensions，design D4）。
 *
 * feature 之间通过注入的 Context 查找的稳定 key。放在 leaf API，使宿主与对应 extension 共享
 * 同一常量而不互相 import 业务实现。
 */

/**
 * 片段引用来源 capability key（由 prompt-snippets extension 提供）。
 *
 * Task Execution 的 `#` 引用按此 key 查找；optional 扩展缺失时不出现 `#` 入口，普通 prompt
 * 编辑继续工作。
 */
export const PROMPT_SNIPPET_SOURCE = "promptSnippetSource";

/**
 * 宿主 Agent 会话 capability key（由 task-execution plugin 提供）
 * （change: 2026-10-12-add-agent-conversation-panel，design D1/D6a）。
 *
 * 宿主生成的会话详情入口与详情面板都经此读取**宿主拥有的**会话服务；业务生成扩展（如
 * ChatGPT）只提供 adapter，不提供本 key。optional 缺失时不显示详情入口，普通生成继续工作。
 */
export const AGENT_CONVERSATION_SERVICE = "agentConversationService";

/**
 * 图片聚焦编辑 capability（由图片编辑扩展提供）
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history；
 *   change: 2026-10-27-add-image-history-to-photocraft-focus，design D4）。
 *
 * 宿主节点历史只依赖本契约读取活动文档身份、草稿状态与只读历史预览，不判断扩展 id、也不
 * import 具体编辑器。缺少 provider（扩展停用或尚未加载）时历史列表仍可浏览，预览与草稿
 * 提示按「不可用」降级。
 */
export const IMAGE_EDIT_SERVICE = "imageEdit";

export type ImageEditService = {
  /** 窗口内是否仍持有图片编辑文档会话。 */
  isActive(): boolean;
  /** 当前活动文档对应的来源节点；文件文档或没有活动文档时为 null。 */
  nodeId(): string | null;
  /**
   * 安装/清除只读历史预览 override。
   *
   * `nodeId` 由调用方（历史面板）显式给出：多标签下活动文档可能是另一篇，只改活动文档会让
   * 预览「点了没反应」；缺省时作用于活动节点。
   */
  setHistoryOverride(override: { url: string } | null, nodeId?: string): void;
  /** 历史恢复成功后，等待对应权威修订并刷新当前编辑内容。 */
  refreshFromCanonical(revision: number): void;
  /** 当前草稿状态（供历史面板「当前版本 · 未保存」呈现）。 */
  draftState(): "saved" | "unsaved" | "saving" | "history-pending" | "error";
};
