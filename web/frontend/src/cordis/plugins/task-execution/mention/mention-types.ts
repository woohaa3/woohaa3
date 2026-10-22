/**
 * Mention 编辑器共享类型
 * （change: 2026-10-09-improve-canvas-workflow，任务 3.2；从 MentionEditor 抽出以保持文件守卫）。
 */
import type { Woohaa3CanvasMention } from "@woohaa3/contracts";

export type MentionCandidate = {
  slotId: string;
  type: Woohaa3CanvasMention["type"];
  label: string;
  /** 失效候选（仍可显示，但插入前提示）。 */
  disabled?: boolean;
};

/**
 * `#` 片段候选（change: add-prompt-snippet-library，design D10 修订）。
 * 选中后由宿主 materialize 为可插入文本；这里只负责触发 `#` 菜单与选择回调。
 */
export type SnippetCandidate = {
  id: string;
  name: string;
  summary: string;
};

export type SnippetTrigger = {
  /** 按 query 搜索片段；空 query 返回默认列表。 */
  search(query: string): Promise<readonly SnippetCandidate[]>;
  /** 选中片段：返回要插入选区/光标位置的正文（已 materialize）；null 表示放弃。 */
  select(snippetId: string): string | null;
};

/**
 * 编辑器命令式选区 API（change: add-prompt-snippet-library，任务 6.1 / design D10）。
 * 供宿主（执行面板）在插入片段时替换当前选区或光标位置文本；不暴露编辑器内部结构。
 */
export type MentionSelectionApi = {
  /** 当前选区字符范围；无选区时为 null（光标位置）。 */
  getSelection: () => { start: number; end: number } | null;
  /** 用文本替换当前选区；无选区时插入光标位置。 */
  replaceSelection: (text: string) => void;
};
