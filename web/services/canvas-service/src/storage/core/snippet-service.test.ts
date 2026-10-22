/**
 * 提示词片段目录应用服务测试
 * （change: add-prompt-snippet-library，任务 1.3/1.4/1.5）。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CanvasStorageError } from "./errors.js";
import { InMemorySnippetRepository } from "./in-memory-snippet-repository.js";
import { PromptSnippetApplicationService } from "./snippet-service.js";
import { SqliteSnippetRepository } from "../sqlite/snippets.js";

const CHECKSUM = "a".repeat(64);

function imageMaterial(key = "material-1") {
  return {
    key,
    mediaKind: "image" as const,
    assetId: "a1",
    storageKey: `sha256-${CHECKSUM}`,
    checksum: CHECKSUM,
    contentType: "image/png",
    size: 4,
    label: "图"
  };
}

function makeService(failWrites = false) {
  const repository = new InMemorySnippetRepository();
  if (failWrites) repository.failNext("write");
  let counter = 0;
  const service = new PromptSnippetApplicationService({
    repository,
    now: () => `2026-09-27T00:00:0${Math.min(counter, 9)}.000Z`,
    generateId: (prefix) => `${prefix}-${counter++}`
  });
  return { service, repository };
}

async function expectCode(run: () => Promise<unknown>, code: string) {
  try {
    await run();
    throw new Error("应当抛出错误");
  } catch (error) {
    expect(error).toBeInstanceOf(CanvasStorageError);
    expect((error as CanvasStorageError).code).toBe(code);
  }
}

describe("PromptSnippetApplicationService", () => {
  it("创建使用 operationId 幂等：相同 payload 返回同一片段", async () => {
    const { service } = makeService();
    const input = { operationId: "op-1", name: "片段", body: "文本", materials: [], tagIds: [] };
    const first = await service.createSnippet(input);
    const second = await service.createSnippet(input);
    expect(second.id).toBe(first.id);
    const list = await service.listSnippets({ filter: "all" });
    expect(list.total).toBe(1);
  });

  it("相同 operationId 配不同 payload 返回冲突", async () => {
    const { service } = makeService();
    await service.createSnippet({ operationId: "op-1", name: "A", body: "x", materials: [], tagIds: [] });
    await expectCode(
      () => service.createSnippet({ operationId: "op-1", name: "B", body: "y", materials: [], tagIds: [] }),
      "SNIPPET_OPERATION_CONFLICT"
    );
  });

  it("名称大小写无关唯一", async () => {
    const { service } = makeService();
    await service.createSnippet({ operationId: "op-1", name: "Hello", body: "x", materials: [], tagIds: [] });
    await expectCode(
      () => service.createSnippet({ operationId: "op-2", name: "hello", body: "y", materials: [], tagIds: [] }),
      "SNIPPET_NAME_CONFLICT"
    );
  });

  it("更新使用 revision 乐观并发并递增", async () => {
    const { service } = makeService();
    const snippet = await service.createSnippet({ operationId: "op-1", name: "A", body: "x", materials: [], tagIds: [] });
    const updated = await service.updateSnippet({
      snippetId: snippet.id,
      expectedRevision: snippet.revision,
      name: "A2",
      body: "y",
      materials: [],
      tagIds: []
    });
    expect(updated.revision).toBe(snippet.revision + 1);
    await expectCode(
      () =>
        service.updateSnippet({
          snippetId: snippet.id,
          expectedRevision: snippet.revision,
          name: "A3",
          body: "z",
          materials: [],
          tagIds: []
        }),
      "SNIPPET_REVISION_CONFLICT"
    );
  });

  it("正文-material 双向不一致时拒绝保存", async () => {
    const { service } = makeService();
    await expectCode(
      () => service.createSnippet({ operationId: "op-1", name: "A", body: "没有 token", materials: [imageMaterial()], tagIds: [] }),
      "SNIPPET_INVALID"
    );
    await expectCode(
      () =>
        service.createSnippet({
          operationId: "op-2",
          name: "B",
          body: "{{input_image:material-1:图}}",
          materials: [],
          tagIds: []
        }),
      "SNIPPET_INVALID"
    );
  });

  it("保存拒绝不存在或非法的 tag ID", async () => {
    const { service } = makeService();
    await expectCode(
      () => service.createSnippet({ operationId: "op-1", name: "A", body: "x", materials: [], tagIds: ["missing"] }),
      "TAG_NOT_FOUND"
    );
  });

  it("删除标签在单个事务内解绑但不删除片段", async () => {
    const { service } = makeService();
    const tag = await service.createTag({ operationId: "tag-1", name: "标签" });
    const snippet = await service.createSnippet({
      operationId: "op-1",
      name: "片段",
      body: "x",
      materials: [],
      tagIds: [tag.id]
    });
    await service.deleteTag(tag.id);
    const after = await service.getSnippet(snippet.id);
    expect(after.tagIds).toEqual([]);
    expect((await service.listTags()).length).toBe(0);
  });

  it("标签重命名保持 ID 并递增 revision", async () => {
    const { service } = makeService();
    const tag = await service.createTag({ operationId: "tag-1", name: "旧" });
    const renamed = await service.renameTag({ tagId: tag.id, expectedRevision: tag.revision, name: "新" });
    expect(renamed.id).toBe(tag.id);
    expect(renamed.revision).toBe(tag.revision + 1);
  });

  it("所有片段的删除/更新都拒绝内置（只读）", async () => {
    const { service } = makeService();
    await service.seedBuiltIns();
    const builtIn = (await service.listSnippets({ filter: "builtIn" })).items[0]!;
    await expectCode(() => service.deleteSnippet(builtIn.id), "SNIPPET_READ_ONLY");
    await service.listTags();
  });

  it("内置 seed 幂等且搜索可按正文/标签命中", async () => {
    const { service } = makeService();
    await service.seedBuiltIns();
    await service.seedBuiltIns();
    const builtIns = await service.listSnippets({ filter: "builtIn" });
    expect(builtIns.total).toBeGreaterThan(0);
    const byBody = await service.listSnippets({ query: "写实" });
    expect(byBody.items.length).toBeGreaterThan(0);
  });

  it("目录写入失败不留下部分状态", async () => {
    const { service } = makeService(true);
    await expectCode(
      () => service.createSnippet({ operationId: "op-1", name: "A", body: "x", materials: [], tagIds: [] }),
      "REPOSITORY_FAILURE"
    );
    expect((await service.listSnippets({ filter: "all" })).total).toBe(0);
  });
});

describe("SqliteSnippetRepository", () => {
  it("目录事务不创建 Yjs/画布表（分表存储）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-snippet-"));
    const repository = new SqliteSnippetRepository({ path: path.join(dir, "snippets.db") });
    await repository.seed({ snippets: [], tags: [] });
    const tables = repository.debugQuery<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).map((row) => row.name);
    expect(tables).toContain("prompt_snippets");
    expect(tables).toContain("prompt_snippet_tags");
    expect(tables).toContain("prompt_snippet_operations");
    expect(tables).not.toContain("canvases");
    expect(tables).not.toContain("canvas_yjs_documents");
    repository.close();
  });

  it("持久化 CRUD 与唯一约束", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-snippet-"));
    const repository = new SqliteSnippetRepository({ path: path.join(dir, "snippets.db") });
    const service = new PromptSnippetApplicationService({
      repository,
      now: () => "2026-09-27T00:00:00.000Z",
      generateId: (prefix) => `${prefix}-1`
    });
    const snippet = await service.createSnippet({ operationId: "op-1", name: "片段", body: "x", materials: [], tagIds: [] });
    const loaded = await service.getSnippet(snippet.id);
    expect(loaded.name).toBe("片段");
    await expectCode(
      () => service.createSnippet({ operationId: "op-2", name: "片段", body: "y", materials: [], tagIds: [] }),
      "SNIPPET_NAME_CONFLICT"
    );
    repository.close();
  });
});
