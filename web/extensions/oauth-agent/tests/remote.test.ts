/**
 * ChatGPT remote 业务协议测试
 * （change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 3.1/3.5；
 *  change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 6.1：改为经通用
 *  Application Remote 传输，本测试用假传输验证业务协议解释）。
 */
import { describe, expect, it } from "vitest";
import { createChatGptRemote, type ChatGptGenerationSink } from "../src/frontend/remote.js";
import type {
  ApplicationRemoteTransport,
  ApplicationTransportJsonResult,
  ApplicationTransportStreamCallbacks
} from "@woohaa3/frontend/extension-api";

/** 记录调用并返回固定 JSON 的假传输。 */
function jsonTransport(dataByPath: Record<string, unknown>, seen: Array<{ path: string; method?: string; body?: unknown }> = []): ApplicationRemoteTransport {
  return {
    async request(input): Promise<ApplicationTransportJsonResult> {
      seen.push({ path: input.path, ...(input.method ? { method: input.method } : {}), ...(input.body !== undefined ? { body: input.body } : {}) });
      return { ok: true, status: 200, data: dataByPath[input.path] };
    },
    stream(input: { path: string; body?: unknown; callbacks: ApplicationTransportStreamCallbacks }) {
      seen.push({ path: input.path, ...(input.body !== undefined ? { body: input.body } : {}) });
      return { cancel: () => undefined };
    }
  };
}

describe("createChatGptRemote（经 Application 通用传输）", () => {
  it("fetchStatus 走 /api/oauth-agent/status 且不回显 token", async () => {
    const seen: Array<{ path: string; method?: string }> = [];
    const remote = createChatGptRemote({
      transport: jsonTransport({ "/api/oauth-agent/status": { state: "disconnected", planEnabled: false, localSession: true, ownerKind: "local-session" } }, seen)
    });
    const status = await remote.fetchStatus();
    expect(status.ok).toBe(true);
    expect(seen[0]!.path).toBe("/api/oauth-agent/status");
    expect(JSON.stringify(status)).not.toContain("token");
  });

  it("startAuthorize 返回授权 URL", async () => {
    const remote = createChatGptRemote({
      transport: jsonTransport({ "/api/oauth-agent/authorize/start": { url: "https://auth.example/x", expiresAt: 1 } })
    });
    const result = await remote.startAuthorize();
    expect(result).toEqual({ ok: true, url: "https://auth.example/x" });
  });

  it("fetchModels 规范化 id/label", async () => {
    const remote = createChatGptRemote({
      transport: jsonTransport({ "/api/oauth-agent/models": { models: [{ id: "gpt-5", label: "GPT-5" }, { id: "", label: "x" }] } })
    });
    const result = await remote.fetchModels();
    expect(result).toEqual({ ok: true, snapshot: { models: [{ id: "gpt-5", label: "GPT-5" }] } });
  });

  it("generate 经传输 stream 消费 SSE，progress/result 回调到 sink", async () => {
    let captured: ApplicationTransportStreamCallbacks | null = null;
    const transport: ApplicationRemoteTransport = {
      request: async () => ({ ok: true, status: 200, data: null }),
      stream(input) {
        captured = input.callbacks;
        return { cancel: () => undefined };
      }
    };
    const remote = createChatGptRemote({ transport });
    const events: string[] = [];
    const sink: ChatGptGenerationSink = {
      progress: (event) => events.push(`p:${event.stage}`),
      done: (receipt) => events.push(`d:${receipt.status}`)
    };
    remote.generate({ requestId: "r", canvasId: "c", nodeId: "n", mode: "model3d", model: "m", prompt: "x" }, sink);
    expect(captured).not.toBeNull();
    captured!.onEvent({ type: "progress", data: JSON.stringify({ requestId: "r", stage: "reasoning" }) });
    captured!.onEvent({ type: "result", data: JSON.stringify({ status: "succeeded", requestId: "r", mode: "model3d", canvasId: "c", nodeId: "n", commandId: "cmd" }) });
    expect(events).toEqual(["p:reasoning", "d:succeeded"]);
  });

  it("stream onError 映射为失败回执", async () => {
    let captured: ApplicationTransportStreamCallbacks | null = null;
    const transport: ApplicationRemoteTransport = {
      request: async () => ({ ok: true, status: 200, data: null }),
      stream(input) {
        captured = input.callbacks;
        return { cancel: () => undefined };
      }
    };
    const remote = createChatGptRemote({ transport });
    let failed: string | null = null;
    remote.generate({ requestId: "r", canvasId: "c", nodeId: "n", mode: "model3d", model: "m", prompt: "x" }, {
      done: (receipt) => { failed = receipt.status; }
    });
    captured!.onError("生成请求失败", "unavailable");
    expect(failed).toBe("failed");
  });
});
