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
