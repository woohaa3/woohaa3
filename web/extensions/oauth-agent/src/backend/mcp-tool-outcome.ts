/** SDK transport completion does not imply that the MCP domain operation succeeded. */
export function mcpToolOutcome(item: { status: string; result?: unknown; error?: { message?: string } | null }): { ok: boolean; message?: string } {
  if (item.status !== "completed" || item.error) return { ok: false, message: item.error?.message ?? "工具调用未完成" };
  const result = item.result as { isError?: boolean; structuredContent?: unknown; content?: Array<{ text?: string }> } | undefined;
  const structured = result?.structuredContent as { ok?: boolean; message?: string; error?: string } | undefined;
  if (result?.isError || structured?.ok === false) return { ok: false, message: structured?.message ?? structured?.error ?? result?.content?.find(block => block.text)?.text ?? "工具操作失败" };
  return { ok: true };
}
