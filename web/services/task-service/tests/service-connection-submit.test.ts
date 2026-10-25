import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import type { GenerationProvider, TaskSubmitRequest } from "@woohaa3/contracts";
import { createTaskService } from "../src/composition.js";

it("freezes a trusted source once, replays admission without refreezing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa-source-submit-"));
  const reference = { serviceConnectionId: "source", configRevision: 4, credentialEpoch: 2, bindingId: "provider:demo", purpose: "text" as const, protocol: "chat-completions", modelId: "model", endpoint: "https://relay.example/v1", owner: "alice" };
  const freeze = vi.fn(async () => reference);
  const provider: GenerationProvider = { extensionId: "demo", providerId: "demo", available: true, provider: {} as never, models: [{ providerId: "demo", providerModelId: "model", modelType: "language", inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] }, defaultInput: {} }] };
  const service = createTaskService({ env: {}, modelsConfig: { version: 1, models: [] }, storePath: path.join(dir, "task.sqlite"), generationProviders: () => [provider], serviceConnections: { freeze, resolve: async () => provider.provider } });
  const request: TaskSubmitRequest = { workerTaskKey: "request", canvasId: "canvas", nodeId: "node", runId: "run", jobId: "job", nodeType: "text", modelType: "language", modelKey: "demo:model", prompt: "draft", parameters: { serviceConnectionId: "source" }, serviceConnection: { serviceConnectionId: "source", owner: "alice" }, inputs: [] };
  try {
    const first = await service.port().submit(request);
    expect(first.state).toBe("queued");
    expect(freeze).toHaveBeenCalledWith("demo", "model", "language", { serviceConnectionId: "source", owner: "alice" });
    expect(await service.port().submit(request)).toMatchObject({ reused: true });
    expect(freeze).toHaveBeenCalledTimes(1);
    await expect(service.port().submit({ ...request, serviceConnection: { serviceConnectionId: "source", owner: "bob" } })).rejects.toThrow("不同 payload");
    await expect(service.port().submit({ ...request, workerTaskKey: "forged", serviceConnection: undefined })).rejects.toThrow("可信 owner");
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }); }
});
