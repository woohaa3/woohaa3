/**
 * 生成编排测试
 * （change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 3.3/3.6/4.2–4.4）。
 *
 * 使用 fake SDK 与 fake Canvas 端口，覆盖：结构化候选、token 隔离、幂等重试、输入不一致拒绝、
 * 镜头整批非法拒绝、工具执行拒绝与取消。
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelCamera } from "@woohaa3/contracts";
import { CHATGPT_REASONING_EFFORTS, decodeChatGptGenerateRequest, PREFERRED_MODEL_SCRIPT_VERSION } from "@woohaa3/contracts";
import { createChatGptGenerationService, parseCandidateText, modelSchema, cameraSchema, normalizeCameraMutations, overwriteGuard, buildPrompt, buildToolsPrompt } from "../src/backend/generation.js";
import { createChatGptWorkJournal } from "../src/backend/work-journal.js";
import type { ChatGptCanvasPorts } from "../src/backend/ports.js";
import { assertNoToolExecution, buildChatGptProviderConfig, CHATGPT_ACCESS_TOKEN_ENV, createCodexAdapter, type CodexFactoryOptions, type CodexLike } from "../src/backend/codex-adapter.js";

const journalDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "chatgpt-gen-"));
  journalDirs.push(dir);
  return dir;
}

const VALID_SCRIPT = `scene.box({ id: "box", size: [1,1,1] });`;

afterAll(() => {
  for (const dir of journalDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeCodex(response: unknown): CodexLike {
  return {
    startThread: () => ({
      runStreamed: async () => ({
        events: (async function* () {
          yield { type: "item.completed", item: { id: "1", type: "agent_message", text: JSON.stringify(response) } };
          yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
        })()
      })
    })
  };
}

function ports(overrides: Partial<ChatGptCanvasPorts> = {}): ChatGptCanvasPorts {
  const base: ChatGptCanvasPorts = {
    readNode: async () => ({ ok: true, nodeType: "model3d", title: "m", prompt: "", references: [], modelContentVersion: { revision: 1, sourceHash: "s", contentHash: "c" }, cameras: [] }),
    submitModel: async () => ({ ok: true, canvasId: "cv", nodeId: "n", commandId: "cmd", duplicate: false, noop: false }),
    mutateCamerasBatch: async () => ({ ok: true, canvasId: "cv", nodeId: "n", commandId: "cmd", duplicate: false, noop: false })
  };
  return { ...base, ...overrides };
}

function adapt(factory: (options: CodexFactoryOptions) => CodexLike, accessToken = () => Promise.resolve("tok")) {
  return createCodexAdapter({
    codexHomeDir: "/tmp/woohaa3-test-codex",
    workspaceDir: "/tmp/woohaa3-test-ws",
    accessTokenFor: accessToken,
    createCodex: factory
  });
}

describe("ChatGPT 生成编排", () => {
  it.each(CHATGPT_REASONING_EFFORTS)("结构化生成把 %s 思考强度传给 SDK，变更强度的同 requestId 被拒绝", async (reasoningEffort) => {
    const threads: Parameters<CodexLike["startThread"]>[0][] = [];
    const service = createChatGptGenerationService({
      ports: ports(),
      codex: adapt(() => ({ startThread: (options) => {
        threads.push(options);
        return fakeCodex({ modelScript: VALID_SCRIPT, modelScriptVersion: PREFERRED_MODEL_SCRIPT_VERSION }).startThread(options);
      } }))
    });
    const input = { ownerId: "o", requestId: `effort-${reasoningEffort}`, canvasId: "cv", nodeId: "n", mode: "model3d" as const, model: "gpt-6.1-sol", prompt: "box", reasoningEffort };
    expect((await service.generate(input)).ok).toBe(true);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ modelReasoningEffort: reasoningEffort });
    expect((await service.generate(input)).ok).toBe(true);
    const conflict = await service.generate({ ...input, reasoningEffort: reasoningEffort === "high" ? "low" : "high" });
    expect(!conflict.ok && conflict.code).toBe("request-id-conflict");
    expect(threads).toHaveLength(1);
  });

  it("生成请求接受模型默认，拒绝非法思考强度", () => {
    const input = { requestId: "r", canvasId: "cv", nodeId: "n", mode: "model3d", model: "gpt-6.1-sol", prompt: "box" };
    expect(decodeChatGptGenerateRequest(input)).toEqual({ ok: true, value: input });
    for (const reasoningEffort of [null, "default", "unknown", "", 1, {}, []]) {
      expect(decodeChatGptGenerateRequest({ ...input, reasoningEffort })).toMatchObject({ ok: false, code: "malformed-request" });
    }
  });

  it("model3d 结构化候选经受控校验并经端口提交", async () => {
    const submitted: string[] = [];
    const service = createChatGptGenerationService({
      ports: ports({
        submitModel: async (input) => {
          submitted.push(input.source);
          return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "cmd-1", duplicate: false, noop: false };
        }
      }),
      codex: adapt(() => fakeCodex({ modelScript: VALID_SCRIPT, modelScriptVersion: PREFERRED_MODEL_SCRIPT_VERSION }))
    });
    const outcome = await service.generate({
      ownerId: "o1", requestId: "r1", canvasId: "cv", nodeId: "n", mode: "model3d", model: "gpt-5", prompt: "make a box"
    });
    expect(outcome.ok).toBe(true);
    expect(submitted).toEqual([VALID_SCRIPT]);
    expect(service.receipt("r1")).toMatchObject({ status: "succeeded", commandId: "cmd-1" });
  });

  it("用户 token 只进入实例 env，不修改共享 process.env", async () => {
    const seen: CodexFactoryOptions[] = [];
    const previous = process.env[CHATGPT_ACCESS_TOKEN_ENV];
    const service = createChatGptGenerationService({
      ports: ports(),
      codex: adapt((options) => {
        seen.push(options);
        return fakeCodex({ modelScript: VALID_SCRIPT, modelScriptVersion: PREFERRED_MODEL_SCRIPT_VERSION });
      }, () => Promise.resolve("user-token-secret"))
    });
    await service.generate({ ownerId: "o1", requestId: "r-env", canvasId: "cv", nodeId: "n", mode: "model3d", model: "gpt-5", prompt: "x" });
    expect(seen[0]!.env[CHATGPT_ACCESS_TOKEN_ENV]).toBe("user-token-secret");
    expect(process.env[CHATGPT_ACCESS_TOKEN_ENV]).toBe(previous);
    // provider 配置指向 per-owner env_key，而非 apiKey。
    expect(seen[0]!.config[`model_providers.openai-chatgpt.env_key`]).toBe(CHATGPT_ACCESS_TOKEN_ENV);
    expect(buildChatGptProviderConfig().model_provider).toBe("openai-chatgpt");
    // 关闭 codex 内建 shell 工具，避免其走 shell/exec 探索（应直接调用受控 MCP 工具）。
    expect(seen[0]!.config["features.shell_tool"]).toBe(false);
  });

  it("同 requestId 的已完成请求不再推理计费；不一致输入被拒绝", async () => {
    let runs = 0;
    const service = createChatGptGenerationService({
      ports: ports(),
      codex: adapt(() => {
        runs += 1;
        return fakeCodex({ modelScript: VALID_SCRIPT, modelScriptVersion: PREFERRED_MODEL_SCRIPT_VERSION });
      })
    });
    const base = { ownerId: "o1", requestId: "rr", canvasId: "cv", nodeId: "n", mode: "model3d" as const, model: "gpt-5", prompt: "x" };
    await service.generate(base);
    await service.generate(base);
    expect(runs).toBe(1);
    const conflict = await service.generate({ ...base, prompt: "different" });
    expect(conflict.ok).toBe(false);
    expect(!conflict.ok && conflict.code).toBe("request-id-conflict");
  });

  it("rejects a candidate that changes a different camera from the captured task", async () => {
    let writes = 0;
    const cameras: ModelCamera[] = ["selected", "other"].map((id, order) => ({ id, order, name: id, azimuth: 0, elevation: 0, distance: 5, aspect: "16:9" }));
    const service = createChatGptGenerationService({ ports: ports({
      readNode: async () => ({ ok: true, nodeType: "model3d", title: "m", prompt: "", references: [], cameras }),
      mutateCamerasBatch: async () => { writes++; return { ok: true, canvasId: "cv", nodeId: "n", commandId: "cmd", duplicate: false, noop: false }; }
    }), codex: adapt(() => fakeCodex({ mutations: [{ kind: "update", id: "other", distance: 20 }] })) });
    const outcome = await service.generate({ ownerId: "owner", requestId: "restricted-camera", canvasId: "cv", nodeId: "n", mode: "camera", selectedCameraId: "selected", model: "gpt-5", prompt: "adjust this camera" });
    expect(outcome).toMatchObject({ ok: false, code: "invalid-target" });
    expect(writes).toBe(0);
  });
  it("camera 批量含非法条目不部分写入", async () => {
    let called = false;
    const cameras: ModelCamera[] = [{ id: "cam-1", name: "镜头 1", order: 0, azimuth: 0, elevation: 0, distance: 5, aspect: "16:9" }];
    const service = createChatGptGenerationService({
      ports: ports({
        readNode: async () => ({ ok: true, nodeType: "model3d", title: "m", prompt: "", references: [], cameras }),
        mutateCamerasBatch: async () => { called = true; return { ok: true, canvasId: "cv", nodeId: "n", commandId: "c", duplicate: false, noop: false }; }
      }),
      codex: adapt(() => fakeCodex({ mutations: [{ kind: "update", id: "cam-1", distance: 10 }, { kind: "remove", id: "missing" }] }))
    });
    const outcome = await service.generate({ ownerId: "o1", requestId: "cam", canvasId: "cv", nodeId: "n", mode: "camera", model: "gpt-5", prompt: "x" });
    expect(outcome.ok).toBe(false);
    expect(called).toBe(false);
  });

  it("合法批量镜头提交", async () => {
    const cameras: ModelCamera[] = [{ id: "cam-1", name: "镜头 1", order: 0, azimuth: 0, elevation: 0, distance: 5, aspect: "16:9" }];
    let mutations: unknown;
    const service = createChatGptGenerationService({
      ports: ports({
        readNode: async () => ({ ok: true, nodeType: "model3d", title: "m", prompt: "", references: [], cameras }),
        mutateCamerasBatch: async (input) => { mutations = input.mutations; return { ok: true, canvasId: "cv", nodeId: "n", commandId: "c", duplicate: false, noop: false }; }
      }),
      codex: adapt(() => fakeCodex({ mutations: [{ kind: "update", id: "cam-1", distance: 10 }] }))
    });
    const outcome = await service.generate({ ownerId: "o1", requestId: "cam-ok", canvasId: "cv", nodeId: "n", mode: "camera", model: "gpt-5", prompt: "x" });
    expect(outcome.ok).toBe(true);
    expect(mutations).toEqual([{ kind: "update", id: "cam-1", distance: 10 }]);
  });

  it("命令执行事件中止回合；MCP 工具调用被允许（受控工具面）", async () => {
    const codex = {
      startThread: () => ({
        runStreamed: async () => ({
          events: (async function* () {
            yield { type: "item.completed", item: { id: "c", type: "command_execution", command: "echo hi", aggregated_output: "", status: "completed" } };
          })()
        })
      })
    } as CodexLike;
    const service = createChatGptGenerationService({ ports: ports(), codex: adapt(() => codex) });
    const outcome = await service.generate({ ownerId: "o1", requestId: "tool", canvasId: "cv", nodeId: "n", mode: "model3d", model: "gpt-5", prompt: "x" });
    expect(outcome.ok).toBe(false);
    // command_execution 仍被拒绝；mcp_tool_call 不再被 assertNoToolExecution 拒绝。
    expect(assertNoToolExecution({ type: "item.completed", item: { id: "1", type: "command_execution", command: "x", aggregated_output: "", status: "completed" } } as never, "o")).toContain("命令");
    expect(assertNoToolExecution({ type: "item.completed", item: { id: "1", type: "mcp_tool_call", server: "s", tool: "t", arguments: {}, status: "completed" } } as never, "o")).toBeNull();
  });

  it("受控 MCP 工具面：实例 config 注入 mcp_servers，bearer 只进实例 env", async () => {
    const seen: CodexFactoryOptions[] = [];
    const adapter = createCodexAdapter({
      codexHomeDir: "/tmp/woohaa3-test-codex2",
      workspaceDir: "/tmp/woohaa3-test-ws2",
      accessTokenFor: () => Promise.resolve("tok"),
      mcpTools: { name: "woohaa3_model_canvas", url: "http://127.0.0.1:5180/mcp/model-canvas", bearerToken: "bearer-secret" },
      createCodex: (options) => { seen.push(options); return fakeCodex({ modelScript: VALID_SCRIPT, modelScriptVersion: PREFERRED_MODEL_SCRIPT_VERSION }); }
    });
    await adapter.run({ ownerId: "o1", model: "m", prompt: "x", outputSchema: { type: "object" } });
    expect(seen[0]!.config["mcp_servers.woohaa3_model_canvas.url"]).toBe("http://127.0.0.1:5180/mcp/model-canvas");
    expect(seen[0]!.config["mcp_servers.woohaa3_model_canvas.bearer_token_env_var"]).toBe("WOOHAA3_CHATGPT_MCP_BEARER");
    expect(seen[0]!.config["mcp_servers.woohaa3_model_canvas.default_tools_approval_mode"]).toBe("approve");
    expect(seen[0]!.env["WOOHAA3_CHATGPT_MCP_BEARER"]).toBe("bearer-secret");
    // 不修改共享 process.env。
    expect(process.env["WOOHAA3_CHATGPT_MCP_BEARER"]).toBeUndefined();
  });

  it("candidate JSON 解析支持代码块包裹", () => {
    expect(parseCandidateText('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseCandidateText("not json").ok).toBe(false);
  });

  it("overwriteGuard：默认拒绝大幅缩水，明确重建时放行", () => {
    const big = "scene.box({ id: 'a', size: [1,1,1] });".repeat(40); // > 800 chars
    const tiny = `scene.box({ id: "b", size: [1,1,1] });`;
    // 普通提示词 + 大幅缩水 → 拒绝
    expect(overwriteGuard("加一个电视", big, tiny)).toContain("远小于现有模型");
    // 明确重建 → 放行
    expect(overwriteGuard("重建整个模型", big, tiny)).toBeNull();
    expect(overwriteGuard("rebuild from scratch", big, tiny)).toBeNull();
    // 非缩水（保留大部分）→ 放行
    expect(overwriteGuard("改一下", big, big.slice(0, Math.ceil(big.length * 0.6)))).toBeNull();
    // 现有脚本很小 → 不做护栏
    expect(overwriteGuard("改一下", "scene.box({});", tiny)).toBeNull();
  });

  it("model3d 提示词包含现有脚本作为保留基线", () => {
    const base = "scene.box({ id: 'keep', size: [1,1,1] });";
    const prompt = buildPrompt(
      { ownerId: "o", requestId: "r", canvasId: "cv", nodeId: "n", mode: "model3d", model: "m", prompt: "加一个电视" },
      { ok: true, nodeType: "model3d", title: "t", prompt: "", source: base, references: [], cameras: [] }
    );
    expect(prompt).toContain(base);
    expect(prompt).toContain("KEEP");
  });

  it("模型生成提示词（结构化与工具模式）都带现实尺度基准", () => {
    const read = { ok: true as const, nodeType: "model3d" as const, title: "t", prompt: "", source: "scene.box({ id: 'keep' });", references: [], cameras: [] };
    for (const prompt of [
      buildPrompt({ ownerId: "o", requestId: "r", canvasId: "cv", nodeId: "n", mode: "model3d", model: "m", prompt: "椅子" }, read),
      buildToolsPrompt({ ownerId: "o", requestId: "r", canvasId: "cv", nodeId: "n", mode: "model3d", model: "m", prompt: "椅子" }, read)
    ]) {
      expect(prompt).toContain("1 unit ≈ 1 meter");
      expect(prompt).toContain("standing person ≈ 1.7 units");
      expect(prompt).toMatch(/ground contact/);
    }
  });

  it("结构化输出 schema 严格合规（每个 properties 键都在 required）", () => {
    // OpenAI response_format 要求；缺失会被服务端以 invalid_json_schema 拒绝。
    const assertStrict = (schema: Record<string, unknown>): void => {
      const props = Object.keys(schema.properties as Record<string, unknown>).sort();
      const required = [...(schema.required as string[])].sort();
      expect(required).toEqual(props);
      expect(schema.additionalProperties).toBe(false);
    };
    assertStrict(modelSchema());
    assertStrict(cameraSchema());
    // 嵌套：cameraMutations.items 与 cameraSchema.mutations.items 都必须严格合规。
    const modelCamera = ((modelSchema().properties as Record<string, unknown>).cameraMutations as { items: Record<string, unknown> }).items;
    assertStrict(modelCamera);
    const item = ((cameraSchema().properties as Record<string, unknown>).mutations as { items: Record<string, unknown> }).items;
    assertStrict(item);
  });

  it("model3d 同回合附带镜头：模型与镜头都提交（非原子、顺序）", async () => {
    const calls: string[] = [];
    const service = createChatGptGenerationService({
      ports: ports({
        submitModel: async () => { calls.push("model"); return { ok: true, canvasId: "cv", nodeId: "n", commandId: "m", duplicate: false, noop: false }; },
        mutateCamerasBatch: async () => { calls.push("camera"); return { ok: true, canvasId: "cv", nodeId: "n", commandId: "c", duplicate: false, noop: false }; }
      }),
      codex: adapt(() => fakeCodex({
        modelScript: VALID_SCRIPT,
        modelScriptVersion: PREFERRED_MODEL_SCRIPT_VERSION,
        cameraMutations: [{ kind: "create", azimuth: 0, distance: 5, id: null, name: null, elevation: null, aspect: null, focusOffset: null }]
      }))
    });
    const outcome = await service.generate({ ownerId: "o1", requestId: "both", canvasId: "cv", nodeId: "n", mode: "model3d", model: "gpt-5", prompt: "x" });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.receipt.status).toBe("succeeded");
    expect(calls).toEqual(["model", "camera"]);
  });

  it("只调镜头（model3d 模式下 modelScript=null + cameraMutations）也能提交", async () => {
    let modelCalls = 0;
    let cameraCalls = 0;
    const service = createChatGptGenerationService({
      ports: ports({
        submitModel: async () => { modelCalls += 1; return { ok: true, canvasId: "cv", nodeId: "n", commandId: "m", duplicate: false, noop: false }; },
        mutateCamerasBatch: async () => { cameraCalls += 1; return { ok: true, canvasId: "cv", nodeId: "n", commandId: "c", duplicate: false, noop: false }; }
      }),
      codex: adapt(() => fakeCodex({
        modelScript: null,
        modelScriptVersion: null,
        cameraMutations: [{ kind: "create", azimuth: 0, distance: 5, id: null, name: null, elevation: null, aspect: null, focusOffset: null }]
      }))
    });
    const outcome = await service.generate({ ownerId: "o1", requestId: "camonly", canvasId: "cv", nodeId: "n", mode: "model3d", model: "gpt-5", prompt: "调整镜头" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.receipt.status).toBe("succeeded");
    expect(modelCalls).toBe(0);
    expect(cameraCalls).toBe(1);
  });

  it("主模型成功但镜头失败 → partial（模型保留，镜头在回执说明）", async () => {
    const service = createChatGptGenerationService({
      ports: ports({
        submitModel: async () => ({ ok: true, canvasId: "cv", nodeId: "n", commandId: "m", duplicate: false, noop: false }),
        mutateCamerasBatch: async () => ({ ok: false, code: "unknown-camera", message: "镜头 cam-x 不存在" })
      }),
      codex: adapt(() => fakeCodex({
        modelScript: VALID_SCRIPT,
        modelScriptVersion: PREFERRED_MODEL_SCRIPT_VERSION,
        cameraMutations: [{ kind: "remove", id: "cam-x", name: null, azimuth: null, elevation: null, distance: null, aspect: null, focusOffset: null }]
      }))
    });
    const outcome = await service.generate({ ownerId: "o1", requestId: "part", canvasId: "cv", nodeId: "n", mode: "model3d", model: "gpt-5", prompt: "x" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.receipt.status).toBe("partial");
    if (outcome.receipt.status !== "partial") return;
    expect(outcome.receipt.applied).toEqual(["模型"]);
    expect(outcome.receipt.failed[0]!.part).toBe("镜头");
    // 主模型未被回滚（端口只记录成功）。
  });

  it("归一结构化输出的 null 可选字段（保留有值字段，丢弃 null/无效条目）", () => {
    const mutations = normalizeCameraMutations([
      { kind: "update", id: "cam-1", distance: 10, azimuth: null, elevation: null, aspect: null, name: null, focusOffset: null },
      { kind: "create", azimuth: 0, distance: 5, id: null, name: null, elevation: null, aspect: null, focusOffset: null },
      { kind: "remove", id: "cam-2", name: null, azimuth: null, elevation: null, distance: null, aspect: null, focusOffset: null },
      { kind: "remove", id: null },
      { kind: "rename", id: "cam-3", name: null }
    ]);
    expect(mutations).toEqual([
      { kind: "update", id: "cam-1", distance: 10 },
      { kind: "create", azimuth: 0, distance: 5 },
      { kind: "remove", id: "cam-2" }
    ]);
  });
});

describe("ChatGPT durable 工作生命周期（任务 4.1/4.4/4.6）", () => {
  it("推理前持久化受理意图，成功后落 committed 回执", async () => {
    const journal = createChatGptWorkJournal({ directory: tempDir() });
    const service = createChatGptGenerationService({
      ports: ports(),
      codex: adapt(() => fakeCodex({ modelScript: VALID_SCRIPT, modelScriptVersion: PREFERRED_MODEL_SCRIPT_VERSION, cameraMutations: [] })),
      workJournal: journal
    });
    const outcome = await service.generate({ ownerId: "o1", requestId: "j1", canvasId: "cv", nodeId: "n", mode: "model3d", model: "gpt-5", prompt: "make" });
    expect(outcome.ok).toBe(true);
    expect(journal.find("j1", "o1")?.state).toBe("committed");
  });

  it("生成把可信 owner 透传给每个 Canvas 端口（本地会话 owner 也能写入）", async () => {
    const seen: Array<{ op: string; ownerId: string }> = [];
    const capture = ports({
      readNode: async (input) => { seen.push({ op: "read", ownerId: input.ownerId }); return { ok: true, nodeType: "model3d", title: "m", prompt: "", references: [], modelContentVersion: { revision: 1, sourceHash: "s", contentHash: "c" }, cameras: [] }; },
      submitModel: async (input) => { seen.push({ op: "submit", ownerId: input.ownerId }); return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "cmd", duplicate: false, noop: false }; },
      mutateCamerasBatch: async (input) => { seen.push({ op: "cameras", ownerId: input.ownerId }); return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "cmd", duplicate: false, noop: false }; }
    });
    const service = createChatGptGenerationService({
      ports: capture,
      codex: adapt(() => fakeCodex({ modelScript: VALID_SCRIPT, modelScriptVersion: PREFERRED_MODEL_SCRIPT_VERSION, cameraMutations: [] }))
    });
    const outcome = await service.generate({ ownerId: "local:abc123", requestId: "owner-1", canvasId: "cv", nodeId: "n", mode: "model3d", model: "gpt-5", prompt: "make" });
    expect(outcome.ok).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    for (const entry of seen) expect(entry.ownerId).toBe("local:abc123");
  });

  it("重启恢复：中断的 in-flight 请求进入 outcome-unknown 且不自动重推理", async () => {
    const dir = tempDir();
    const first = createChatGptWorkJournal({ directory: dir });
    const serviceA = createChatGptGenerationService({
      ports: ports(),
      codex: adapt(() => fakeCodex({ modelScript: VALID_SCRIPT, modelScriptVersion: PREFERRED_MODEL_SCRIPT_VERSION, cameraMutations: [] })),
      workJournal: first
    });
    // 手工制造一条 running 记录（模拟进程在推理中崩溃）。
    const rec = first.admit({ requestId: "j2", ownerId: "o1", authEpoch: 0, inputIdentity: "x", canvasId: "cv", nodeId: "n", mode: "model3d" });
    first.update(rec.workId, { state: "running" });
    void serviceA;

    // 新进程：读同一目录并恢复。
    const second = createChatGptWorkJournal({ directory: dir });
    const codexCalls: number[] = [];
    let calls = 0;
    const serviceB = createChatGptGenerationService({
      ports: ports(),
      codex: adapt(() => ({
        startThread: () => ({
          runStreamed: async () => {
            calls += 1;
            codexCalls.push(calls);
            return {
              events: (async function* () {
                yield { type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } };
              })()
            };
          }
        })
      })),
      workJournal: second
    });
    serviceB.recoverInterrupted();
    const outcome = await serviceB.generate({ ownerId: "o1", requestId: "j2", canvasId: "cv", nodeId: "n", mode: "model3d", model: "gpt-5", prompt: "make" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.receipt.status).toBe("unknown");
    // 未触发任何推理。
    expect(codexCalls).toEqual([]);
  });

});
