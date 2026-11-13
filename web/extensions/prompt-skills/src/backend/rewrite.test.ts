import { describe, expect, it, vi } from "vitest";
import type { ApplicationExtensionTaskFacade } from "@woohaa3/contracts";
import { rewritePromptWithTask } from "./rewrite.js";
import { promptRewriterRole } from "./role.js";
import {
  agentRoleDescriptorDigest,
  agentRoleTurnDigests,
  composeAgentRoleMessages,
  makeAgentRoleRef,
  preparedTurnHash,
  type PreparedAgentRoleTurn
} from "@woohaa3/contracts";

/** 测试用宿主准备结果：直接调用角色实现，验证单次 Task 桥接只消费规范消息。 */
function prepared(skillId = "polish", prompt = "雨夜街道", taskKind = "image-generation"): PreparedAgentRoleTurn {
  const definition = promptRewriterRole.definition;
  const messages = promptRewriterRole.prepare({ input: { skillId, prompt, taskKind }, context: {}, target: {}, requestId: "req-1", nativeCapabilities: [] }).messages;
  const digests = agentRoleTurnDigests({ input: { skillId, prompt, taskKind }, context: {} });
  const base = {
    schemaVersion: 1 as const,
    roleRef: makeAgentRoleRef({ extensionId: "prompt-skills", roleId: definition.id, revision: definition.revision, descriptorDigest: agentRoleDescriptorDigest(definition), artifactId: "test@1" }),
    messages: composeAgentRoleMessages(definition.instructions, messages),
    tools: [],
    nativeCapabilities: [],
    output: definition.output,
    inputDigest: digests.inputDigest,
    contextDigest: digests.contextDigest,
    attachmentDigests: [],
    target: {}
  };
  return { ...base, preparedHash: preparedTurnHash(base) };
}

const request = {
  requestId: "req-1",
  skillId: "polish",
  label: "画面细节润色",
  prompt: "雨夜街道",
  modelKey: "litellm:gpt-4o",
  canvasId: "c1",
  nodeId: "n1",
  taskKind: "image-generation"
};

function fakeTasks(overrides: Partial<ApplicationExtensionTaskFacade> & {
  states?: string[];
  text?: string;
  submitError?: { code: string; message: string };
} = {}): ApplicationExtensionTaskFacade & { submitted: unknown[] } {
  const submitted: unknown[] = [];
  const states = overrides.states ?? ["running", "succeeded"];
  let index = 0;
  return {
    submitted,
    async submit(input) {
      submitted.push(input);
      if (overrides.submitError) return { ok: false, ...overrides.submitError } as never;
      return { ok: true, workerTaskKey: input.workerTaskKey, reused: false, state: "pending" };
    },
    async status() {
      const state = states[Math.min(index, states.length - 1)]!;
      index += 1;
      return { workerTaskKey: "prompt-skills-req-1", state };
    },
    async result() {
      return { workerTaskKey: "prompt-skills-req-1", state: "succeeded", result: { mediaKind: "text", text: overrides.text } };
    },
    async cancel() {
      return { workerTaskKey: "prompt-skills-req-1", state: "cancelled" };
    }
  };
}

describe("rewritePromptWithTask", () => {
  it("提交语言模型任务并返回清理后的改写文本", async () => {
    const fenced = "\u0060\u0060\u0060\n雨夜霓虹街道，湿漉漉的柏油路。\n\u0060\u0060\u0060";
    const tasks = fakeTasks({ text: fenced });
    const result = await rewritePromptWithTask(request, { tasks, prepared: prepared(), wait: async () => undefined });
    expect(result).toEqual({ ok: true, prompt: "雨夜霓虹街道，湿漉漉的柏油路。" });
    const submitted = tasks.submitted[0] as { modelType: string; modelKey: string; prompt: string; parameters: Record<string, unknown>; workerTaskKey: string };
    expect(submitted.modelType).toBe("language");
    expect(submitted.modelKey).toBe("litellm:gpt-4o");
    // 指令同时进用户消息，避免忽略 system 的 Provider 把草稿当创作题。
    expect(submitted.prompt).toContain("雨夜街道");
    expect(submitted.prompt).toContain("视觉细节");
    expect(submitted.workerTaskKey).toBe("prompt-skills-req-1-1");
    expect(String(submitted.parameters.system)).toContain("视觉细节");
    expect(submitted.parameters.maxTokens).toBe(1600);
  });

  it("任务失败时返回安全错误，不把空结果写回草稿", async () => {
    const tasks = fakeTasks({ states: ["failed"], text: "" });
    (tasks as { result: unknown }).result = async () => ({
      workerTaskKey: "prompt-skills-req-1",
      state: "failed",
      error: { message: "upstream 429" }
    });
    const result = await rewritePromptWithTask(request, { tasks, prepared: prepared(), wait: async () => undefined });
    expect(result).toEqual({ ok: false, status: 502, error: "upstream 429" });
  });

  it("超时后取消任务并返回可操作错误", async () => {
    let clock = 0;
    const tasks = fakeTasks({ states: ["running"] });
    const cancel = vi.spyOn(tasks, "cancel");
    const result = await rewritePromptWithTask(request, {
      tasks,
      prepared: prepared(),
      timeoutMs: 1000,
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      }
    });
    expect(result).toMatchObject({ ok: false, status: 504 });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("模型能力不支持时给出 400 与可读原因", async () => {
    const tasks = fakeTasks({ submitError: { code: "unsupported", message: "模型或输入能力不受支持" } });
    const result = await rewritePromptWithTask(request, { tasks, prepared: prepared() });
    expect(result).toEqual({ ok: false, status: 400, error: "当前模型不支持文本改写，请换一个语言模型" });
  });

  it("模型返回空文本时不静默成功", async () => {
    const tasks = fakeTasks({ text: "   " });
    const result = await rewritePromptWithTask(request, { tasks, prepared: prepared(), wait: async () => undefined });
    expect(result).toMatchObject({ ok: false, status: 502 });
  });
});
