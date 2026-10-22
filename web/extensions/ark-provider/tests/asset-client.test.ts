import assert from "node:assert/strict";
import { it as test } from "vitest";
import { createVolcengineAssetClient } from "../src/asset-client.js";

test("uses the OpenAPI signed header set for CreateAsset", async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const client = createVolcengineAssetClient({
    accessKeyId: "AKLTaccess",
    secretAccessKey: "secret",
    groupId: "group-1",
    projectName: "default",
    region: "cn-beijing",
    service: "ark",
    endpoint: "https://ark.cn-beijing.volcengineapi.com/",
    now: () => new Date("2024-07-10T04:29:25.000Z"),
    fetch: async (input, init) => {
      request = { url: String(input), init: init as RequestInit };
      return new Response(JSON.stringify({ Result: { Id: "asset-1" } }), { status: 200 });
    },
  });

  assert.equal(await client.createImageAsset({ url: "https://bucket.example/image.png", name: "image.png" }), "asset-1");
  assert.equal(request?.url, "https://ark.cn-beijing.volcengineapi.com/?Action=CreateAsset&Version=2024-01-01");
  const headers = request?.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "HMAC-SHA256 Credential=AKLTaccess/20240710/cn-beijing/ark/request, SignedHeaders=host;x-content-sha256;x-date, Signature=b6d8d5f2fb5669c653ae729e00454bbbe69fe45ba39155a4ce62796e10ad8491");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["X-Date"], "20240710T042925Z");
});

test("uses Id when querying an asset", async () => {
  let body = "";
  const client = createVolcengineAssetClient({
    accessKeyId: "access",
    secretAccessKey: "secret",
    groupId: "group-1",
    projectName: "project-1",
    region: "cn-beijing",
    service: "ark",
    endpoint: "https://ark.cn-beijing.volcengineapi.com/",
    now: () => new Date("2024-07-10T04:29:25.000Z"),
    fetch: async (_input, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ Result: { Id: "asset-1", Status: "Active" } }), { status: 200 });
    },
  });

  assert.deepEqual(await client.getAsset("asset-1"), { assetId: "asset-1", status: "Active" });
  assert.deepEqual(JSON.parse(body), { Id: "asset-1", ProjectName: "project-1" });
});

test("limits CreateAsset names to 64 characters while preserving the extension", async () => {
  let body = "";
  const client = createVolcengineAssetClient({
    accessKeyId: "access",
    secretAccessKey: "secret",
    groupId: "group-1",
    projectName: "default",
    region: "cn-beijing",
    service: "ark",
    endpoint: "https://ark.cn-beijing.volcengineapi.com/",
    fetch: async (_input, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ Result: { Id: "asset-1" } }), { status: 200 });
    },
  });

  await client.createImageAsset({ url: "https://bucket.example/image.png", name: `${"a".repeat(64)}.png` });

  const name = JSON.parse(body).Name as string;
  assert.equal(name, `${"a".repeat(60)}.png`);
  assert.equal(Array.from(name).length, 64);
});

test("surfaces Volcengine HTTP errors with the action and status", async () => {
  const client = createVolcengineAssetClient({
    accessKeyId: "access",
    secretAccessKey: "secret",
    groupId: "group-1",
    projectName: "default",
    region: "cn-beijing",
    service: "ark",
    endpoint: "https://ark.cn-beijing.volcengineapi.com/",
    fetch: async () => new Response(JSON.stringify({ ResponseMetadata: { Error: { Message: "signature mismatch" } } }), { status: 401 }),
  });
  await assert.rejects(
    client.createImageAsset({ url: "https://bucket.example/image.png", name: "image.png" }),
    /CreateAsset 失败（HTTP 401）：signature mismatch/,
  );
});

test("rejects a successful CreateAsset response without an asset id", async () => {
  const client = createVolcengineAssetClient({
    accessKeyId: "access",
    secretAccessKey: "secret",
    groupId: "group-1",
    projectName: "default",
    region: "cn-beijing",
    service: "ark",
    endpoint: "https://ark.cn-beijing.volcengineapi.com/",
    fetch: async () => new Response(JSON.stringify({ Result: { Status: "Processing" } }), { status: 200 }),
  });
  await assert.rejects(
    client.createImageAsset({ url: "https://bucket.example/image.png", name: "image.png" }),
    /CreateAsset 未返回素材 Id/,
  );
});
