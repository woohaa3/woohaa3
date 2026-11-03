import { describe, expect, it, vi } from "vitest";
import type { PromptSkillsSettingsRemote } from "./settings-remote.js";
import { registerPromptSkillsSettingsPanel } from "./settings-plugin.js";

function fakeContext() {
  const registrations: Array<{ name: string; contribution: Record<string, unknown> }> = [];
  return {
    registrations,
    ctx: {
      slots: {
        register: (name: string, contribution: Record<string, unknown>) => {
          registrations.push({ name, contribution });
          return () => undefined;
        }
      },
      applicationRemote: { transport: { request: vi.fn() } }
    }
  };
}

const remote: PromptSkillsSettingsRemote = {
  load: vi.fn(),
  save: vi.fn()
} as unknown as PromptSkillsSettingsRemote;

describe("registerPromptSkillsSettingsPanel", () => {
  it("把面板挂到插件自己的 pluginId 上，而不是全局设置", () => {
    const { ctx, registrations } = fakeContext();
    registerPromptSkillsSettingsPanel(ctx as never, { remote });
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.name).toBe("settings.plugin-config");
    expect(registrations[0]!.contribution).toMatchObject({
      id: "prompt-skills-settings",
      owner: "prompt-skills",
      pluginId: "prompt-skills"
    });
  });

  it("返回的 dispose 能撤销注册（主 plugin 释放时一起清理）", () => {
    const dispose = vi.fn();
    const { ctx } = fakeContext();
    const unregister = registerPromptSkillsSettingsPanel(
      {
        ...ctx,
        slots: { register: () => dispose }
      } as never,
      { remote }
    );
    unregister();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
