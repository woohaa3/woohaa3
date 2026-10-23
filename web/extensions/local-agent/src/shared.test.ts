import { expect, it } from "vitest";
import { localAgentConnectionName } from "./shared.js";

it.each([
  ["codex-appserver", "Codex App Server（本机）", "本地 ChatGPT"],
  ["opencode-server", "OpenCode Server（本机）", "本地 OpenCode"],
  ["codebuddy-server", "CodeBuddy Server（本机）", "本地 CodeBuddy"],
])("%s 的历史默认名称更新展示，自定义名称原样保留", (adapterId, previous, current) => {
  expect(localAgentConnectionName(adapterId, previous)).toBe(current);
  expect(localAgentConnectionName(adapterId, current)).toBe(current);
  expect(localAgentConnectionName(adapterId, "我的创作助手")).toBe("我的创作助手");
  expect(localAgentConnectionName(adapterId, `我的 ${previous}`)).toBe(`我的 ${previous}`);
});
