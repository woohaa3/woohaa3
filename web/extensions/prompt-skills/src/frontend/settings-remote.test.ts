import { describe, expect, it, vi } from "vitest";
import type { ApplicationRemoteTransport } from "@woohaa3/frontend/extension-api";
import { createPromptSkillsSettingsRemote } from "./settings-remote.js";

const catalog = {
  available: true,
  models: [
    { modelKey: "litellm:b", modelType: "language", title: "模型 B" },
    { modelKey: "litellm:image", modelType: "image", title: "图像模型" },
    { modelKey: "litellm:a", modelType: "language", title: "模型 A" }
  ]
};

function fakeTransport(options: {
  config?: unknown;
  saveResult?: unknown;
} = {}) {
  const request = vi.fn(async ({ path, method }: { path: string; method?: string }) => {
    if (path === "/api/pptask/catalog") return { ok: true as const, status: 200, data: catalog };
    if (path === "/api/prompt-skills/config" && method === "GET") {
      return { ok: true as const, status: 200, data: options.config ?? { ok: true, model: "litellm:a", revision: 3 } };
    }
    if (path === "/api/prompt-skills/config" && method === "POST") {
      return options.saveResult ?? { ok: true as const, status: 200, data: { ok: true, model: "litellm:b", revision: 4 } };
    }
    return { ok: false as const, code: "not-found" as const, error: "not found", status: 404 };
  });
  return { transport: { request } as unknown as ApplicationRemoteTransport, request };
}

describe("createPromptSkillsSettingsRemote", () => {
  it("列出目录里可执行的语言模型，并读回当前模型与 revision", async () => {
    const { transport } = fakeTransport();
    const remote = createPromptSkillsSettingsRemote({ transport });
    await expect(remote.load()).resolves.toEqual({
      ok: true,
      snapshot: {
        models: [
          { id: "litellm:a", label: "模型 A" },
          { id: "litellm:b", label: "模型 B" }
        ],
        model: "litellm:a",
        revision: 3
      }
    });
  });

  it("保存时把模型与读取到的 revision 交给 CAS 接口", async () => {
    const { transport, request } = fakeTransport();
    const remote = createPromptSkillsSettingsRemote({ transport });
    await expect(remote.save({ model: "litellm:b", expectedRevision: 3 })).resolves.toEqual({ ok: true, revision: 4 });
    expect(request).toHaveBeenCalledWith({
      path: "/api/prompt-skills/config",
      method: "POST",
      body: { model: "litellm:b", expectedRevision: 3 }
    });
  });

  it("冲突时透出服务端的可操作提示", async () => {
    const { transport } = fakeTransport({
      saveResult: {
        ok: false,
        code: "conflict",
        error: "conflict",
        status: 409,
        body: { ok: false, error: "配置已被其它窗口修改，请刷新后重试" }
      }
    });
    const remote = createPromptSkillsSettingsRemote({ transport });
    await expect(remote.save({ model: "litellm:b", expectedRevision: 0 })).resolves.toEqual({
      ok: false,
      error: "配置已被其它窗口修改，请刷新后重试"
    });
  });

  it("配置响应畸形时不返回半份数据", async () => {
    const { transport } = fakeTransport({ config: { ok: true, model: 1, revision: 2 } });
    const remote = createPromptSkillsSettingsRemote({ transport });
    await expect(remote.load()).resolves.toEqual({ ok: false, error: "插件配置响应无法识别" });
  });
});
