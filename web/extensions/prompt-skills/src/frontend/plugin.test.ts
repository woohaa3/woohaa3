import { describe, expect, it, vi } from "vitest";
import { promptSkillsExtension } from "./plugin.js";
import type { PromptSkillsSettingsRemote } from "./settings-remote.js";

function fakeContext() {
  const names: string[] = [];
  return {
    names,
    ctx: {
      slots: {
        register: (name: string) => {
          names.push(name);
          return () => undefined;
        }
      },
      applicationRemote: { transport: { request: vi.fn() } },
      effect: () => () => undefined
    }
  };
}

const settingsRemote: PromptSkillsSettingsRemote = {
  load: vi.fn(),
  save: vi.fn()
} as unknown as PromptSkillsSettingsRemote;

describe("promptSkillsExtension", () => {
  it("激活态同时注册改写入口与设置面板（宿主不会为 active 扩展加载设置工厂）", () => {
    const { ctx, names } = fakeContext();
    promptSkillsExtension({
      remote: { rewrite: vi.fn(async () => ({ ok: true as const, prompt: "x" })) },
      settingsRemote,
      newRequestId: () => "req"
    })(ctx as never);
    expect(names).toEqual(["execution.prompt-skill", "settings.plugin-config"]);
  });
});
