/**
 * 提示词片段目录应用服务
 * （change: add-prompt-snippet-library，任务 1.3/1.4/1.5 / design D2/D3/D6/D7）。
 *
 * 拥有目录领域校验（名称规范化/唯一性、正文-material 双向一致、内置只读、tag 关联、
 * operationId 幂等与 revision 乐观并发）与内置 seed；只依赖后端无关的 repository。
 *
 * 关键约束：目录事务不创建 Y.Doc update、不推进 canvas revision、不广播 room update
 * —— 本模块根本不接触 Yjs / room / 画布聚合。
 */
import {
  buildBuiltInSeed,
  BUILT_IN_PROMPT_SNIPPET_FORMAT_VERSION,
  decodePromptSnippet,
  decodePromptSnippetListQuery,
  isBuiltInPromptSnippetTagId,
  promptSnippetNameKey,
  validateSnippetBodyMaterials,
  type CreatePromptSnippetInput,
  type CreatePromptSnippetTagInput,
  type PromptSnippet,
  type PromptSnippetListQuery,
  type PromptSnippetListResult,
  type PromptSnippetMaterial,
  type PromptSnippetTag,
  type RenamePromptSnippetTagInput,
  type UpdatePromptSnippetInput
} from "@woohaa3/contracts";
import { CanvasStorageError } from "./errors.js";
import type { SnippetRepository, SnippetTagWithCount } from "./snippet-contracts.js";

export type PromptSnippetApplicationServiceOptions = {
  repository: SnippetRepository;
  now?: () => string;
  generateId?: (prefix: string) => string;
};

export class PromptSnippetApplicationService {
  private readonly repository: SnippetRepository;
  private readonly now: () => string;
  private readonly generateId: (prefix: string) => string;

  constructor(options: PromptSnippetApplicationServiceOptions) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date().toISOString());
    this.generateId = options.generateId ?? ((prefix) => `${prefix}-${randomId()}`);
  }

  async listSnippets(query: unknown): Promise<PromptSnippetListResult> {
    return this.repository.listSnippets(decodeQuery(query));
  }

  async getSnippet(id: string): Promise<PromptSnippet> {
    const snippet = await this.repository.getSnippet(id);
    if (!snippet) throw new CanvasStorageError("SNIPPET_NOT_FOUND", `片段 ${id} 不存在`);
    return snippet;
  }

  async listTags(): Promise<SnippetTagWithCount[]> {
    return this.repository.listTags();
  }

  async createSnippet(input: CreatePromptSnippetInput): Promise<PromptSnippet> {
    this.assertValidBody(input.body, input.materials);
    await this.assertTagIds(input.tagIds);
    const payloadHash = snippetPayloadHash(input.name, input.body, input.materials, input.tagIds);
    const existing = await this.repository.getOperation(input.operationId);
    if (existing) {
      if (existing.kind !== "create-snippet" || existing.payloadHash !== payloadHash) {
        throw new CanvasStorageError("SNIPPET_OPERATION_CONFLICT", "operationId 已用于不同 payload");
      }
      const snippet = await this.repository.getSnippet(existing.resultId);
      if (!snippet) throw new CanvasStorageError("REPOSITORY_FAILURE", "幂等记录指向的片段不存在");
      return snippet;
    }
    const now = this.now();
    const record = {
      id: this.generateId("psnip"),
      name: input.name,
      nameKey: promptSnippetNameKey(input.name),
      body: input.body,
      materials: input.materials,
      tagIds: dedupe(input.tagIds),
      builtIn: false,
      now
    };
    return this.guardConflict(() =>
      this.repository.createSnippet(record, {
        operationId: input.operationId,
        kind: "create-snippet",
        payloadHash,
        resultId: record.id,
        createdAt: now
      })
    );
  }

  async updateSnippet(input: UpdatePromptSnippetInput): Promise<PromptSnippet> {
    const current = await this.repository.getSnippet(input.snippetId);
    if (!current) throw new CanvasStorageError("SNIPPET_NOT_FOUND", `片段 ${input.snippetId} 不存在`);
    if (current.builtIn) throw new CanvasStorageError("SNIPPET_READ_ONLY", "内置片段只读");
    if (current.revision !== input.expectedRevision) {
      throw new CanvasStorageError("SNIPPET_REVISION_CONFLICT", "片段 revision 已变化", {
        currentRevision: current.revision
      });
    }
    this.assertValidBody(input.body, input.materials);
    await this.assertTagIds(input.tagIds);
    return this.guardConflict(() =>
      this.repository.updateSnippet({
        id: input.snippetId,
        expectedRevision: input.expectedRevision,
        name: input.name,
        nameKey: promptSnippetNameKey(input.name),
        body: input.body,
        materials: input.materials,
        tagIds: dedupe(input.tagIds),
        now: this.now()
      })
    );
  }

  async deleteSnippet(id: string): Promise<void> {
    const current = await this.repository.getSnippet(id);
    if (!current) throw new CanvasStorageError("SNIPPET_NOT_FOUND", `片段 ${id} 不存在`);
    if (current.builtIn) throw new CanvasStorageError("SNIPPET_READ_ONLY", "内置片段只读");
    await this.repository.deleteSnippet(id);
  }

  async createTag(input: CreatePromptSnippetTagInput): Promise<PromptSnippetTag> {
    const payloadHash = tagPayloadHash(input.name);
    const existing = await this.repository.getOperation(input.operationId);
    if (existing) {
      if (existing.kind !== "create-tag" || existing.payloadHash !== payloadHash) {
        throw new CanvasStorageError("SNIPPET_OPERATION_CONFLICT", "operationId 已用于不同 payload");
      }
      const tag = await this.repository.getTag(existing.resultId);
      if (!tag) throw new CanvasStorageError("REPOSITORY_FAILURE", "幂等记录指向的标签不存在");
      return tag;
    }
    const now = this.now();
    const record = {
      id: this.generateId("pstag"),
      name: input.name,
      nameKey: promptSnippetNameKey(input.name),
      builtIn: false,
      now
    };
    return this.guardConflict(() =>
      this.repository.createTag(record, {
        operationId: input.operationId,
        kind: "create-tag",
        payloadHash,
        resultId: record.id,
        createdAt: now
      }),
      "TAG_NAME_CONFLICT"
    );
  }

  async renameTag(input: RenamePromptSnippetTagInput): Promise<PromptSnippetTag> {
    const current = await this.repository.getTag(input.tagId);
    if (!current) throw new CanvasStorageError("TAG_NOT_FOUND", `标签 ${input.tagId} 不存在`);
    if (current.builtIn) throw new CanvasStorageError("SNIPPET_READ_ONLY", "内置标签只读");
    if (current.revision !== input.expectedRevision) {
      throw new CanvasStorageError("SNIPPET_REVISION_CONFLICT", "标签 revision 已变化", {
        currentRevision: current.revision
      });
    }
    return this.guardConflict(
      () =>
        this.repository.renameTag({
          id: input.tagId,
          expectedRevision: input.expectedRevision,
          name: input.name,
          nameKey: promptSnippetNameKey(input.name),
          now: this.now()
        }),
      "TAG_NAME_CONFLICT"
    );
  }

  /** 删除标签：在单个目录事务内移除所有自定义片段关联，但不删除片段（design D7）。 */
  async deleteTag(id: string): Promise<void> {
    const current = await this.repository.getTag(id);
    if (!current) throw new CanvasStorageError("TAG_NOT_FOUND", `标签 ${id} 不存在`);
    if (current.builtIn || isBuiltInPromptSnippetTagId(id)) {
      throw new CanvasStorageError("SNIPPET_READ_ONLY", "内置标签只读");
    }
    await this.repository.deleteTag(id);
  }

  /** 幂等写入内置片段与受保护标签（任务 1.5）。 */
  async seedBuiltIns(): Promise<void> {
    const seed = buildBuiltInSeed();
    const now = this.now();
    await this.repository.seed({
      tags: seed.tags.map((tag) => ({ id: tag.id, name: tag.name, nameKey: promptSnippetNameKey(tag.name), builtIn: true, now })),
      snippets: seed.snippets.map((snippet) => ({
        id: snippet.id,
        name: snippet.name,
        nameKey: promptSnippetNameKey(snippet.name),
        body: snippet.body,
        materials: snippet.materials as PromptSnippetMaterial[],
        tagIds: [...snippet.tagIds],
        builtIn: true,
        now
      }))
    });
  }

  // --- internals ----------------------------------------------------------

  private assertValidBody(body: string, materials: readonly PromptSnippetMaterial[]): void {
    const validation = validateSnippetBodyMaterials(body, materials);
    if (!validation.ok) throw new CanvasStorageError("SNIPPET_INVALID", validation.message);
    // 逐个 material 结构再经 DTO 校验（拒绝任意 URL / 非法 storageKey）。
    for (const material of materials) {
      const decoded = decodePromptSnippet({
        id: "validation",
        formatVersion: BUILT_IN_PROMPT_SNIPPET_FORMAT_VERSION,
        builtIn: false,
        name: "validation",
        body: "validation",
        materials: [material],
        tagIds: [],
        revision: 0,
        createdAt: this.now(),
        updatedAt: this.now()
      });
      if (!decoded.ok) throw new CanvasStorageError("SNIPPET_INVALID", decoded.message);
    }
  }

  private async assertTagIds(tagIds: readonly string[]): Promise<void> {
    for (const tagId of dedupe(tagIds)) {
      const tag = await this.repository.getTag(tagId);
      if (!tag) throw new CanvasStorageError("TAG_NOT_FOUND", `标签 ${tagId} 不存在`);
    }
  }

  private async guardConflict<T>(run: () => Promise<T>, code: "SNIPPET_NAME_CONFLICT" | "TAG_NAME_CONFLICT" = "SNIPPET_NAME_CONFLICT"): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof CanvasStorageError && error.code === code) throw error;
      // repository 可能把唯一约束冲突翻译成 SNIPPET_NAME_CONFLICT。
      throw error;
    }
  }
}

function decodeQuery(query: unknown): PromptSnippetListQuery {
  // 复用 contracts 的查询解码，保证 limit 钳制与筛选回落一致。
  return decodePromptSnippetListQuery(query);
}

function snippetPayloadHash(name: string, body: string, materials: unknown, tagIds: readonly string[]): string {
  return stableHash(JSON.stringify({ name, body, materials, tagIds: dedupe(tagIds) }));
}

function tagPayloadHash(name: string): string {
  return stableHash(JSON.stringify({ name }));
}

/** 同步确定性轻量 hash（避免把 Web Crypto 异步性引入写路径）。 */
function stableHash(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 16777619) >>> 0;
    h2 = Math.imul(h2 + code, 2246822519) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function randomId(): string {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
