/**
 * 片段素材清单同步
 * （change: add-prompt-snippet-library，任务 3.2 / design D3）。
 *
 * 纯函数：根据正文引用的 material key 与当前候选，维护 materials 一一对应。
 * 新增 token → 补 material；删除 mention → 移除 material；其它 key 保持不变。
 */
import { referencedMaterialKeys } from "@woohaa3/contracts";
import type { PromptSnippetMaterial } from "@woohaa3/contracts";
import type { MaterialCandidate } from "./materials.js";

export function syncSnippetMaterials(input: {
  body: string;
  materials: readonly PromptSnippetMaterial[];
  candidates: readonly MaterialCandidate[];
}): { materials: PromptSnippetMaterial[]; missingKeys: string[] } {
  const referenced = referencedMaterialKeys(input.body);
  const byKey = new Map(input.materials.map((material) => [material.key, material]));
  const candidateByKey = new Map(input.candidates.map((candidate) => [candidate.key, candidate.material]));
  const materials: PromptSnippetMaterial[] = [];
  const missingKeys: string[] = [];
  for (const key of referenced) {
    const existing = byKey.get(key);
    if (existing) {
      materials.push(existing);
      continue;
    }
    const candidate = candidateByKey.get(key);
    if (candidate) {
      materials.push(candidate);
      continue;
    }
    missingKeys.push(key);
  }
  return { materials, missingKeys };
}

/** 为编辑器候选构造 mention 选项（key 即 token identity）。 */
export function candidateMentionOptions(candidates: readonly MaterialCandidate[]) {
  return candidates.map((candidate) => ({
    slotId: candidate.key,
    type: mentionTypeFor(candidate.mediaKind),
    label: candidate.label
  }));
}

function mentionTypeFor(mediaKind: MaterialCandidate["mediaKind"]) {
  if (mediaKind === "image") return "input_image" as const;
  if (mediaKind === "video") return "input_video" as const;
  if (mediaKind === "audio") return "input_audio" as const;
  return "input_text" as const;
}
