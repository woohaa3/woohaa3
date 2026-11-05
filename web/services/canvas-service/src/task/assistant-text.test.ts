import { describe, expect, it, vi } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  type AssistantTextRun,
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { CanvasRoom, InMemoryYjsDocumentRepository } from "../sync/index.js";
import { createCanvasAssistantTextPort } from "./assistant-text.js";
const NOW = "2026-10-27T00:00:00.000Z";
async function fixture() {
  const canvas = createEmptyWoohaa3ServerCanvas("cv", NOW);
  canvas.document.nodes.push(
    { id: "text", type: "text", position: { x: 0, y: 0 } },
    { id: "upstream", type: "text", position: { x: 300, y: 0 } },
  );
  canvas.nodeData.text = { prompt: "original" };
  canvas.nodeData.upstream = { outputAssetId: "upstream-text" };
  canvas.assets.push({
    id: "upstream-text",
    title: "Source",
    mediaKind: "text",
    source: "generated",
    status: "ready",
    text: "source body",
    createdAt: NOW,
  });
  const room = new CanvasRoom({
    canvasId: "cv",
    verifyAssets: false,
    repository: new InMemoryYjsDocumentRepository(),
  });
  await room.initialize({ canvas, roomEpoch: "epoch", createdAt: NOW });
  const authorize = vi.fn(async () => true);
  const registerTaskResult = vi.fn(async () => ({
    status: "inserted" as const,
    entryId: "history",
  }));
  const registerTaskFailure = vi.fn(async () => undefined);
  const port = createCanvasAssistantTextPort({
    resolveRoom: async () => room,
    authorize,
    media: {
      verify: async () => ({ exists: true, matches: true }),
      read: async () => ({
        bytes: new Uint8Array([1]),
        contentType: "image/png",
      }),
    },
    history: { registerTaskResult, registerTaskFailure } as never,
  });
  const read = () => {
    const result = room.exportCanvas();
    if (!result.ok) throw Error(result.message);
    return result.canvas;
  };
  const patch = async (
    commands: import("@woohaa3/contracts").CanvasCommand[],
  ) => {
    const result = await room.submit({
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      canvasId: "cv",
      commandId: crypto.randomUUID(),
      baseRevision: read().revision,
      actorId: "manual",
      commands,
    });
    if (!result.ok) throw Error(result.message);
    return result;
  };
  const prepare = (prompt = "generate") =>
    port.prepare({
      owner: "owner",
      entry: {
        action: "generate",
        mode: "text",
        canvasId: "cv",
        nodeId: "text",
        prompt,
      },
      capabilities: { imageInput: true, maxImages: 12 },
    });
  const run = (id: string): AssistantTextRun => ({
    canvasId: "cv",
    targetNodeId: "text",
    conversationId: "conversation",
    turnRequestId: id,
    runId: `run-${id}`,
    jobId: `job-${id}`,
    commandId: `commit-${id}`,
    beginCommandId: `begin-${id}`,
  });
  return {
    port,
    read,
    patch,
    prepare,
    run,
    authorize,
    registerTaskResult,
    registerTaskFailure,
    room,
  };
}
describe("Canvas assistant text authority", () => {
  it("durably begins once, preserves Markdown in a ready asset and downstream compiler, and commits idempotently", async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    const run = f.run("a");
    await f.port.begin({ owner: "owner", prepared, run });
    await f.port.begin({ owner: "owner", prepared, run });
    expect(f.read().jobs).toHaveLength(1);
    const text = "\n# Heading\n\n```ts\nconst n = 1;\n```\n";
    const first = await f.port.commit({ owner: "owner", prepared, run, text });
    expect(first).toMatchObject({
      kind: "text-generation",
      current: true,
      assetId: "assistant-text:run-a",
    });
    expect(
      await f.port.commit({ owner: "owner", prepared, run, text }),
    ).toEqual(first);
    expect(
      f.read().assets.find((asset) => asset.id === first.assetId)?.text,
    ).toBe(text);
    expect(f.read().nodeData.text.outputAssetId).toBe(first.assetId);
    expect(f.registerTaskResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.runId,
        output: { mediaKind: "text", text },
      }),
    );
    expect(await f.port.lookup({ owner: "owner", run })).toEqual(first);
  });
  it("archives all out-of-order completions without overwriting newer output", async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    const a = f.run("a"),
      b = f.run("b");
    await f.port.begin({ owner: "owner", prepared, run: a });
    await f.port.begin({ owner: "owner", prepared, run: b });
    await f.port.commit({ owner: "owner", prepared, run: b, text: "new" });
    expect(
      await f.port.commit({ owner: "owner", prepared, run: a, text: "old" }),
    ).toMatchObject({ current: false });
    expect(f.read().nodeData.text.result).toEqual({
      kind: "text",
      text: "new",
    });
    expect(f.read().jobs.every((job) => job.status === "success")).toBe(true);
    expect(f.registerTaskResult).toHaveBeenCalledTimes(2);
  });
  it("protects manual edits, rejects blank candidates and revoked permissions", async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    const run = f.run("a");
    await f.port.begin({ owner: "owner", prepared, run });
    await expect(
      f.port.commit({ owner: "owner", prepared, run, text: "\n " }),
    ).rejects.toMatchObject({ code: "candidate-invalid" });
    await f.patch([
      {
        type: "nodeData.patch",
        nodeId: "text",
        value: { result: { kind: "text", text: "human" } },
      },
    ]);
    await expect(
      f.port.commit({ owner: "owner", prepared, run, text: "candidate" }),
    ).rejects.toMatchObject({ code: "content-conflict" });
    expect(f.read().nodeData.text.result).toEqual({
      kind: "text",
      text: "human",
    });
    f.authorize.mockResolvedValue(false);
    await expect(
      f.port.commit({ owner: "owner", prepared, run, text: "candidate" }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
  it("compiles upstream text and mentions, and rejects invalid references before begin", async () => {
    const f = await fixture();
    await f.patch([
      {
        type: "edge.add",
        edge: { id: "edge", source: "upstream", target: "text" },
      },
    ]);
    expect((await f.prepare("")).prompt).toBe("source body");
    await expect(
      f.prepare("{{input_text:missing:文字}}"),
    ).rejects.toMatchObject({ code: "invalid-mention" });
  });
});

it("freezes upstream text and mapping versions, expands mentions in place, and rejects changed inputs before begin", async () => {
  const f = await fixture();
  await f.patch([
    { type: "edge.add", edge: { id: "e", source: "upstream", target: "text" } },
    {
      type: "nodeData.patch",
      nodeId: "text",
      value: {
        inputMapping: [
          { slotId: "words", sourceNodeId: "upstream", role: "text_prompt" },
        ],
      },
    },
  ]);
  const prepared = await f.prepare("Before {{input_text:words:文字}} after");
  expect(prepared.prompt).toBe("Before source body after");
  await f.patch([
    {
      type: "asset.upsert",
      asset: { ...f.read().assets[0]!, text: "changed source" },
    },
  ]);
  await expect(
    f.port.begin({ owner: "owner", prepared, run: f.run("a") }),
  ).rejects.toMatchObject({ code: "reference-stale" });
  expect(f.read().jobs).toHaveLength(0);
});

it.each(["video", "audio"] as const)(
  "rejects %s instead of silently ignoring an unsupported reference",
  async (kind) => {
    const f = await fixture();
    await f.patch([
      {
        type: "node.add",
        node: { id: "media", type: kind, position: { x: 0, y: 0 } },
      },
      {
        type: "asset.upsert",
        asset: {
          id: "media-asset",
          title: "media",
          mediaKind: kind,
          source: "uploaded",
          status: "ready",
          createdAt: NOW,
          metadata: {
            storageKey: "stable",
            contentType: kind === "video" ? "video/mp4" : "audio/mpeg",
          },
        },
      },
      {
        type: "nodeData.patch",
        nodeId: "media",
        value: { outputAssetId: "media-asset" },
      },
      {
        type: "edge.add",
        edge: { id: "e-media", source: "media", target: "text" },
      },
    ]);
    await expect(f.prepare()).rejects.toMatchObject({
      code: "unsupported-reference",
    });
    expect(f.read().jobs).toHaveLength(0);
  },
);

it("transports actual supported images and detects byte checksum changes", async () => {
  const f = await fixture();
  await f.patch([
    {
      type: "node.add",
      node: { id: "image", type: "image", position: { x: 0, y: 0 } },
    },
    {
      type: "asset.upsert",
      asset: {
        id: "image-asset",
        title: "image",
        mediaKind: "image",
        source: "uploaded",
        status: "ready",
        createdAt: NOW,
        metadata: { storageKey: "stable.png", contentType: "image/png" },
      },
    },
    {
      type: "nodeData.patch",
      nodeId: "image",
      value: { outputAssetId: "image-asset" },
    },
    {
      type: "edge.add",
      edge: { id: "e-image", source: "image", target: "text" },
    },
  ]);
  const prepared = await f.prepare();
  expect(prepared.inputs).toMatchObject([
    { assetId: "image-asset", mediaKind: "image" },
  ]);
  expect(await f.port.readImages({ owner: "owner", prepared })).toMatchObject([
    { bytes: new Uint8Array([1]), contentType: "image/png" },
  ]);
  prepared.assets[0]!.metadata = {
    ...prepared.assets[0]!.metadata,
    checksum: "bad-checksum",
  };
  await expect(
    f.port.readImages({ owner: "owner", prepared }),
  ).rejects.toMatchObject({ code: "reference-stale" });
});

it("keeps old Provider output in history and protects restored text against a late result", async () => {
  const { buildProjectionCommands } = await import("../sync/task-projector.js");
  const { buildRestoreCommands } =
    await import("../storage/core/node-history-service/restore-commands.js");
  const f = await fixture();
  await f.patch([
    {
      type: "nodeData.patch",
      nodeId: "text",
      value: { activeRunId: "old-provider", taskStatus: "processing" },
    },
  ]);
  const prepared = await f.prepare();
  const run = f.run("a");
  await f.port.begin({ owner: "owner", prepared, run });
  await f.port.commit({ owner: "owner", prepared, run, text: "assistant" });
  expect(
    buildProjectionCommands({
      currentCanvas: f.read(),
      record: {
        taskKey: "old-provider",
        canvasId: "cv",
        nodeId: "text",
        runId: "old-provider",
        jobId: "old-job",
        status: "succeeded",
        terminalAt: NOW,
        output: { mediaKind: "text", text: "late old text" },
      },
    }),
  ).toMatchObject({ ok: false, reason: "stale-run" });
  const next = await f.prepare();
  await f.port.begin({ owner: "owner", prepared: next, run: f.run("b") });
  const restored = buildRestoreCommands("text", {
    entryId: "old-version",
    nodeId: "text",
    source: {},
    kind: "text",
    payload: { kind: "text", text: "restored" },
  } as never);
  if (!restored.ok) throw Error(restored.message);
  await f.patch(restored.commands);
  await expect(
    f.port.commit({
      owner: "owner",
      prepared: next,
      run: f.run("b"),
      text: "late candidate",
    }),
  ).rejects.toMatchObject({ code: "content-conflict" });
  expect(f.read().nodeData.text.result).toEqual({
    kind: "text",
    text: "restored",
  });
  expect(f.read().assets.some((asset) => asset.text === "late candidate")).toBe(
    false,
  );
});

it("a queued durable commit wins a racing stop, and revoked users leave no stranded active job", async () => {
  const f = await fixture();
  const prepared = await f.prepare();
  const run = f.run("a");
  await f.port.begin({ owner: "owner", prepared, run });
  await Promise.all([
    f.port.commit({ owner: "owner", prepared, run, text: "saved" }),
    f.port.settle({
      owner: "owner",
      prepared,
      run,
      status: "cancelled",
      message: "stop",
    }),
  ]);
  expect(f.read().jobs[0]!.status).toBe("success");
  expect(f.read().nodeData.text.result).toEqual({
    kind: "text",
    text: "saved",
  });
  const next = await f.prepare();
  const b = f.run("b");
  await f.port.begin({ owner: "owner", prepared: next, run: b });
  f.authorize.mockResolvedValue(false);
  await f.port.settle({
    owner: "owner",
    prepared: next,
    run: b,
    status: "failed",
    message: "permission revoked",
  });
  expect(f.read().jobs.find((job) => job.id === b.jobId)?.status).toBe(
    "failed",
  );
  expect(f.read().nodeData.text).toMatchObject({
    taskStatus: "failed",
    result: { kind: "text", text: "saved" },
  });
  // 失败立即结束运行中并按失败登记历史，不把 job 留在 running。
  expect(f.registerTaskFailure).toHaveBeenCalledWith(
    expect.objectContaining({
      canvasId: "cv",
      nodeId: "text",
      runId: b.runId,
      outcome: "failed",
    }),
  );
});

it("deleting an accepted target rejects its candidate without recreating artwork or a node", async () => {
  const f = await fixture();
  const prepared = await f.prepare();
  const run = f.run("deleted");
  await f.port.begin({ owner: "owner", prepared, run });
  await f.port.settle({
    owner: "owner",
    prepared,
    run,
    status: "cancelled",
    message: "stop before deleting",
  });
  await f.patch([{ type: "node.remove", nodeIds: ["text"] }]);
  await expect(
    f.port.commit({ owner: "owner", prepared, run, text: "late" }),
  ).rejects.toMatchObject({ code: "target-invalid" });
  await f.port.settle({
    owner: "owner",
    prepared,
    run,
    status: "failed",
    message: "target removed",
  });
  expect(f.read().document.nodes.some((node) => node.id === "text")).toBe(
    false,
  );
  expect(f.read().assets.some((asset) => asset.text === "late")).toBe(false);
});
