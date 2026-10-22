/**
 * 执行面板的片段触发器派生
 * （change: 2026-09-28-align-execution-reference-and-expansion；
 *   change: 2026-09-29-add-pluggable-model-interactions，任务 4.5：移除 video-specific 分支）。
 *
 * 纯派生：只读取已注入的片段来源与节点 id，不提交命令、不判断具体模型。
 */
import type { SnippetCandidate, SnippetTrigger } from "./mention/MentionEditor.js";
import type { PromptSnippetSource } from "../../contracts.js";

/** `#` 片段触发器的宿主适配（未装配片段来源时返回 undefined）。 */
export function buildSnippetTrigger(
  snippetSource: PromptSnippetSource | undefined,
  nodeId: string
): SnippetTrigger | undefined {
  if (!snippetSource) return undefined;
  return {
    search: async (query: string): Promise<readonly SnippetCandidate[]> =>
      (await snippetSource.search(query)).map((entry) => ({
        id: entry.id,
        name: entry.name,
        summary: entry.summary
      })),
    select: (snippetId: string): string | null => snippetSource.materialize(snippetId, nodeId)
  };
}
