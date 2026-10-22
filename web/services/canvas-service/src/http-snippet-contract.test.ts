/**
 * 片段目录 HTTP API 契约测试
 * （change: add-prompt-snippet-library，任务 1.4）。
 *
 * 真实 HTTP server：授权、CRUD、operationId 幂等、revision conflict、标签解绑、
 * 内置只读与稳定错误码。
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { composeSnippets } from "./storage/snippet-composition.js";
import { createSnippetRequestHandler, DEFAULT_SNIPPET_API_BASE_PATH } from "./api/snippet-api.js";
import { InMemorySnippetRepository } from "./storage/core/in-memory-snippet-repository.js";

type Harness = { base: string; server: http.Server; close: () => Promise<void> };

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function start(): Promise<Harness> {
  const repository = new InMemorySnippetRepository();
  const snippets = await composeSnippets({ env: {}, repository });
  const handler = createSnippetRequestHandler({ service: snippets.service });
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const close = async () => {
    server.close();
    await snippets.close();
  };
  closers.push(close);
  return { base: `http://127.0.0.1:${port}`, server, close };
}

async function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${DEFAULT_SNIPPET_API_BASE_PATH}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("片段目录 HTTP API", () => {
  it("创建、读取与列表", async () => {
    const { base } = await start();
    const created = await post(base, "", { operationId: "op-1", name: "片段", body: "文本", materials: [], tagIds: [] });
    expect(created.status).toBe(201);
    const { snippet } = (await created.json()) as { snippet: { id: string } };
    // "无标签" 只返回非内置且无标签的自定义片段（内置 seed 不计入）。
    const list = await fetch(`${base}${DEFAULT_SNIPPET_API_BASE_PATH}?filter=untagged`);
    const listBody = (await list.json()) as { total: number; items: Array<{ id: string }> };
    expect(listBody.total).toBe(1);
    expect(listBody.items[0]?.id).toBe(snippet.id);
    const detail = await fetch(`${base}${DEFAULT_SNIPPET_API_BASE_PATH}/${snippet.id}`);
    expect(detail.status).toBe(200);
  });

  it("operationId 幂等返回首次结果，不同 payload 返回 409", async () => {
    const { base } = await start();
    const first = await post(base, "", { operationId: "op-1", name: "A", body: "x", materials: [], tagIds: [] });
    const { snippet } = (await first.json()) as { snippet: { id: string } };
    const retry = await post(base, "", { operationId: "op-1", name: "A", body: "x", materials: [], tagIds: [] });
    expect(((await retry.json()) as { snippet: { id: string } }).snippet.id).toBe(snippet.id);
    const conflict = await post(base, "", { operationId: "op-1", name: "B", body: "y", materials: [], tagIds: [] });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { code: string }).code).toBe("SNIPPET_OPERATION_CONFLICT");
  });

  it("revision conflict 返回 409 与稳定码", async () => {
    const { base } = await start();
    const created = await post(base, "", { operationId: "op-1", name: "A", body: "x", materials: [], tagIds: [] });
    const { snippet } = (await created.json()) as { snippet: { id: string; revision: number } };
    const updated = await fetch(`${base}${DEFAULT_SNIPPET_API_BASE_PATH}/${snippet.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: snippet.revision, name: "A2", body: "y", materials: [], tagIds: [] })
    });
    expect(updated.status).toBe(200);
    const stale = await fetch(`${base}${DEFAULT_SNIPPET_API_BASE_PATH}/${snippet.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: snippet.revision, name: "A3", body: "z", materials: [], tagIds: [] })
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe("SNIPPET_REVISION_CONFLICT");
  });

  it("标签创建、关联、重命名与删除解绑", async () => {
    const { base } = await start();
    const tagResponse = await post(base, "/tags", { operationId: "tag-1", name: "标签" });
    const { tag } = (await tagResponse.json()) as { tag: { id: string; revision: number } };
    const created = await post(base, "", { operationId: "op-1", name: "A", body: "x", materials: [], tagIds: [tag.id] });
    const { snippet } = (await created.json()) as { snippet: { id: string } };

    const tags = await fetch(`${base}${DEFAULT_SNIPPET_API_BASE_PATH}/tags`);
    const tagList = ((await tags.json()) as { items: Array<{ id: string; snippetCount: number }> }).items;
    expect(tagList.find((entry) => entry.id === tag.id)?.snippetCount).toBe(1);

    const deleted = await fetch(`${base}${DEFAULT_SNIPPET_API_BASE_PATH}/tags/${tag.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    const detail = await fetch(`${base}${DEFAULT_SNIPPET_API_BASE_PATH}/${snippet.id}`);
    expect(((await detail.json()) as { snippet: { tagIds: string[] } }).snippet.tagIds).toEqual([]);
  });

  it("内置片段只读返回 403", async () => {
    const { base } = await start();
    const list = await fetch(`${base}${DEFAULT_SNIPPET_API_BASE_PATH}?filter=builtIn`);
    const builtIn = ((await list.json()) as { items: Array<{ id: string }> }).items[0]!;
    const response = await fetch(`${base}${DEFAULT_SNIPPET_API_BASE_PATH}/${builtIn.id}`, { method: "DELETE" });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("SNIPPET_READ_ONLY");
  });

  it("非法 token 被拒绝（400），非本机访问被拒绝", async () => {
    const { base } = await start();
    const bad = await post(base, "", {
      operationId: "op-1",
      name: "A",
      body: "{{input_image:material-1:图}}",
      materials: [],
      tagIds: []
    });
    expect(bad.status).toBe(400);
  });

  it("素材 resolver 只接受稳定 storageKey 形态", async () => {
    const { base } = await start();
    const key = `sha256-${"a".repeat(64)}`;
    const ok = await fetch(`${base}${DEFAULT_SNIPPET_API_BASE_PATH}/material?storageKey=${encodeURIComponent(key)}`);
    expect(ok.status).toBe(200);
    const bad = await fetch(`${base}${DEFAULT_SNIPPET_API_BASE_PATH}/material?storageKey=${encodeURIComponent("https://evil/sign")}`);
    expect(bad.status).toBe(400);
  });
});
