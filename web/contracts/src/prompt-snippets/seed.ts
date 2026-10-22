/**
 * 内置片段与受保护标签的确定性 seed
 * （change: add-prompt-snippet-library，任务 1.5 / design D6）。
 *
 * 使用稳定 ID 与固定 format version；部署时幂等写入。普通 API 拒绝更新/删除内置条目。
 */
import { PROMPT_SNIPPET_FORMAT_VERSION, type PromptSnippetTag } from "./dto.js";

export const BUILT_IN_TAG_IMAGE_REFERENCE = "pstag-builtin-image-reference";
export const BUILT_IN_TAG_STORYBOARD = "pstag-builtin-storyboard";

/** 受保护（内置）标签 ID；删除请求被拒绝。 */
export const BUILT_IN_PROMPT_SNIPPET_TAG_IDS = [BUILT_IN_TAG_IMAGE_REFERENCE, BUILT_IN_TAG_STORYBOARD] as const;

export type SeedPromptSnippet = {
  id: string;
  name: string;
  body: string;
  tagIds: string[];
  materials: [];
};

export type SeedPromptSnippetTag = Pick<PromptSnippetTag, "id" | "name">;

/** 内置标签 seed（稳定 ID + 规范化名）。 */
export const BUILT_IN_PROMPT_SNIPPET_TAGS: readonly SeedPromptSnippetTag[] = [
  { id: BUILT_IN_TAG_IMAGE_REFERENCE, name: "图片参考" },
  { id: BUILT_IN_TAG_STORYBOARD, name: "分镜" }
];

/** 内置片段 seed（稳定 ID + 固定 format version）。 */
export const BUILT_IN_PROMPT_SNIPPETS: readonly SeedPromptSnippet[] = [
  {
    id: "psnip-builtin-photorealistic",
    name: "写实增强",
    body: "以写实摄影风格重绘：电影级布光，浅景深，细腻皮肤质感，8K 细节。",
    tagIds: [],
    materials: []
  },
  {
    id: "psnip-builtin-storyboard-grid",
    name: "分镜九宫格",
    body: "把内容拆解为九宫格分镜：每格描述镜头、主体、动作与构图，保持角色一致性。",
    tagIds: [BUILT_IN_TAG_STORYBOARD],
    materials: []
  }
];

export const BUILT_IN_PROMPT_SNIPPET_FORMAT_VERSION = PROMPT_SNIPPET_FORMAT_VERSION;

export function isBuiltInPromptSnippetId(id: string): boolean {
  return BUILT_IN_PROMPT_SNIPPETS.some((snippet) => snippet.id === id);
}

export function isBuiltInPromptSnippetTagId(id: string): boolean {
  return (BUILT_IN_PROMPT_SNIPPET_TAG_IDS as readonly string[]).includes(id);
}

/** 返回稳定的内置 seed 副本（调用方不得修改返回值）。 */
export function buildBuiltInSeed(): {
  tags: readonly SeedPromptSnippetTag[];
  snippets: readonly SeedPromptSnippet[];
  formatVersion: typeof PROMPT_SNIPPET_FORMAT_VERSION;
} {
  return { tags: BUILT_IN_PROMPT_SNIPPET_TAGS, snippets: BUILT_IN_PROMPT_SNIPPETS, formatVersion: BUILT_IN_PROMPT_SNIPPET_FORMAT_VERSION };
}
