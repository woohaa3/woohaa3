import { describe, expect, it, vi } from "vitest";
import type { ApplicationRemoteTransport } from "@woohaa3/frontend/extension-api";
import { createPromptSkillsRemote } from "./remote.js";

const input = {
  requestId: "req-1",
  skillId: "polish",
  label: "画面细节润色",
  prompt: "雨夜街道",
  canvasId: "c1",
  nodeId: "n1",
  taskKind: "image-generation"
};

function transportReturning(result: Awaited<ReturnType<ApplicationRemoteTransport["request"]>>) {
  const request = vi.fn(async () => result);
  return { transport: { request } as unknown as ApplicationRemoteTransport, request };
}

describe("createPromptSkillsRemote", () => {
  it("经同源 transport 调用公开路由并返回改写文本", async () => {
    const { transport, request } = transportReturning({ ok: true, status: 200, data: { ok: true, prompt: "改写结果" } });
    const remote = createPromptSkillsRemote({ transport });
    await expect(remote.rewrite(input)).resolves.toEqual({ ok: true, prompt: "改写结果" });
    expect(request).toHaveBeenCalledWith({ path: "/api/prompt-skills/rewrite", method: "POST", body: input });
  });

  it("后端错误原样交给面板", async () => {
    const { transport } = transportReturning({ ok: true, status: 400, data: { ok: false, error: "当前模型不支持文本改写" } });
    await expect(createPromptSkillsRemote({ transport }).rewrite(input)).resolves.toEqual({
      ok: false,
      error: "当前模型不支持文本改写"
    });
  });

  it("传输层失败与畸形响应都转成可读错误", async () => {
    const offline = transportReturning({ ok: false, code: "unavailable", error: "无法连接应用服务", status: 0 });
    await expect(createPromptSkillsRemote({ transport: offline.transport }).rewrite(input)).resolves.toEqual({
      ok: false,
      error: "无法连接应用服务"
    });
    const malformed = transportReturning({ ok: true, status: 200, data: { ok: true } });
    await expect(createPromptSkillsRemote({ transport: malformed.transport }).rewrite(input)).resolves.toEqual({
      ok: false,
      error: "改写响应无法识别"
    });
  });
});
