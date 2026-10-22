/**
 * Extension 公共富文本 prompt 编辑器
 * （change: 2026-10-10-extract-optional-feature-extensions，design D4）。
 *
 * `MentionEditor` 是宿主拥有的通用受控 Lexical 编辑器（`@` mention 与 `#` 片段候选），被
 * Task Execution 执行面板与 prompt-snippets 编辑器共用。作为公共能力经本入口转出，使扩展
 * 消费它而不 import 宿主内部目录。运行时依赖闭包包含 `task-execution/mention`（编辑器实现）
 * 与其纯函数依赖 `prompt-keyboard`。
 */
export { LazyMentionEditor as MentionEditor } from "../cordis/plugins/task-execution/mention/lazy-mention-editor.js";
export { setEditorFromTokenString } from "../cordis/plugins/task-execution/mention/mention-token-writer.js";
export type {
  MentionCandidate,
  MentionEditorProps,
  MentionSelectionApi,
  SnippetCandidate,
  SnippetTrigger
} from "../cordis/plugins/task-execution/mention/MentionEditor.js";
