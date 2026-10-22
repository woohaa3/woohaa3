/**
 * SQLite 提示词片段仓库：DTO 映射、查询过滤与光标编解码
 * （自 `snippets.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R26）。
 */
import type { PromptSnippet, PromptSnippetListQuery, PromptSnippetMaterial, PromptSnippetTag } from "@woohaa3/contracts";
import type { SnippetRow, TagRow } from "./snippets-migrations.js";

export function rowToSnippet(row: SnippetRow): PromptSnippet {
  return {
    id: row.id,
    formatVersion: 1,
    builtIn: row.built_in === 1,
    name: row.name,
    body: row.body,
    materials: JSON.parse(row.materials_json) as PromptSnippetMaterial[],
    tagIds: JSON.parse(row.tag_ids_json) as string[],
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function rowToTag(row: TagRow): PromptSnippetTag {
  return {
    id: row.id,
    name: row.name,
    builtIn: row.built_in === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function matchesQuery(
  snippet: PromptSnippet,
  query: PromptSnippetListQuery,
  tagNames: Map<string, string>
): boolean {
  if (query.filter === "builtIn" && !snippet.builtIn) return false;
  if (query.filter === "untagged" && (snippet.builtIn || snippet.tagIds.length > 0)) return false;
  if (query.filter === "tag" && (!query.tagId || !snippet.tagIds.includes(query.tagId))) return false;
  const text = query.query?.trim().toLocaleLowerCase();
  if (!text) return true;
  if (snippet.name.toLocaleLowerCase().includes(text)) return true;
  if (snippet.body.toLocaleLowerCase().includes(text)) return true;
  return snippet.tagIds.some((tagId) => (tagNames.get(tagId) ?? "").toLocaleLowerCase().includes(text));
}

export function encodeOffset(offset: number): string {
  return `o:${offset}`;
}

export function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = /^o:(\d+)$/.exec(cursor);
  return match ? Number(match[1]) : 0;
}
