/**
 * 片段目录写协议 DTO
 * （change: add-prompt-snippet-library，任务 1.1/1.4 / design D2/D7）。
 *
 * 创建用 `operationId` 幂等；更新/标签重命名用 `expectedRevision` 乐观并发；删除标签
 * 在单个目录事务内解绑。所有字段都做无副作用校验。
 */
import { normalizePromptSnippetName, type PromptSnippetMaterial } from "./dto.js";

export type CreatePromptSnippetInput = {
  operationId: string;
  name: string;
  body: string;
  materials: PromptSnippetMaterial[];
  tagIds: string[];
};

export type UpdatePromptSnippetInput = {
  snippetId: string;
  expectedRevision: number;
  name: string;
  body: string;
  materials: PromptSnippetMaterial[];
  tagIds: string[];
};

export type CreatePromptSnippetTagInput = {
  operationId: string;
  name: string;
};

export type RenamePromptSnippetTagInput = {
  tagId: string;
  expectedRevision: number;
  name: string;
};

export type PromptSnippetDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "SNIPPET_INVALID"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function decodeCreatePromptSnippet(input: unknown): PromptSnippetDecodeResult<CreatePromptSnippetInput> {
  if (!isRecord(input)) return invalid("请求体必须是对象");
  const operationId = input.operationId;
  if (!isNonEmptyString(operationId) || operationId.length > 200) return invalid("operationId 非法");
  const name = normalizePromptSnippetName(input.name);
  if (!name) return invalid("片段名称非法");
  const body = input.body;
  if (typeof body !== "string") return invalid("片段正文非法");
  if (!Array.isArray(input.materials)) return invalid("materials 必须是数组");
  if (!Array.isArray(input.tagIds)) return invalid("tagIds 必须是数组");
  return {
    ok: true,
    value: {
      operationId,
      name,
      body,
      materials: input.materials as PromptSnippetMaterial[],
      tagIds: input.tagIds.filter((entry): entry is string => typeof entry === "string" && entry !== "")
    }
  };
}

export function decodeUpdatePromptSnippet(input: unknown): PromptSnippetDecodeResult<UpdatePromptSnippetInput> {
  if (!isRecord(input)) return invalid("请求体必须是对象");
  const snippetId = input.snippetId;
  if (!isNonEmptyString(snippetId)) return invalid("snippetId 非法");
  const expectedRevision = input.expectedRevision;
  if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
    return invalid("expectedRevision 非法");
  }
  const name = normalizePromptSnippetName(input.name);
  if (!name) return invalid("片段名称非法");
  const body = input.body;
  if (typeof body !== "string") return invalid("片段正文非法");
  if (!Array.isArray(input.materials)) return invalid("materials 必须是数组");
  if (!Array.isArray(input.tagIds)) return invalid("tagIds 必须是数组");
  return {
    ok: true,
    value: {
      snippetId,
      expectedRevision,
      name,
      body,
      materials: input.materials as PromptSnippetMaterial[],
      tagIds: input.tagIds.filter((entry): entry is string => typeof entry === "string" && entry !== "")
    }
  };
}

export function decodeCreatePromptSnippetTag(input: unknown): PromptSnippetDecodeResult<CreatePromptSnippetTagInput> {
  if (!isRecord(input)) return invalid("请求体必须是对象");
  const operationId = input.operationId;
  if (!isNonEmptyString(operationId) || operationId.length > 200) return invalid("operationId 非法");
  const name = normalizePromptSnippetName(input.name);
  if (!name) return invalid("标签名称非法");
  return { ok: true, value: { operationId, name } };
}

export function decodeRenamePromptSnippetTag(input: unknown): PromptSnippetDecodeResult<RenamePromptSnippetTagInput> {
  if (!isRecord(input)) return invalid("请求体必须是对象");
  const tagId = input.tagId;
  if (!isNonEmptyString(tagId)) return invalid("tagId 非法");
  const expectedRevision = input.expectedRevision;
  if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
    return invalid("expectedRevision 非法");
  }
  const name = normalizePromptSnippetName(input.name);
  if (!name) return invalid("标签名称非法");
  return { ok: true, value: { tagId, expectedRevision, name } };
}

function invalid(message: string): { ok: false; code: "SNIPPET_INVALID"; message: string } {
  return { ok: false, code: "SNIPPET_INVALID", message };
}
