/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { agentDirectoryModels, agentModelSelection, readAssistantPreference, rememberAssistantPreference } from "./selection.js";

afterEach(() => { localStorage.clear(); });

it("persists assistant/model/Variant across module reloads and new canvas panels, with owner isolation", async () => {
  const selected = { sourceId: "codex-appserver", connectionId: "local-codex", model: "gpt-6.1-sol", reasoningEffort: "medium" as const };
  rememberAssistantPreference("owner", selected);
  vi.resetModules();
  const reloaded = await import("./selection.js");
  expect(reloaded.readAssistantPreference("owner")).toEqual(selected);
  expect(reloaded.readAssistantPreference("other-owner")).toBeUndefined();
  rememberAssistantPreference("owner", { sourceId: "other", connectionId: "second" });
  expect(reloaded.readAssistantPreference("owner")).toMatchObject({ sourceId: "other", connectionId: "second" });
});

it("ignores malformed persisted identities", () => {
  localStorage.setItem("woohaa3.assistant-selection.v1:broken", "{broken");
  expect(readAssistantPreference("broken")).toBeUndefined();
  localStorage.setItem("woohaa3.assistant-selection.v1:broken", JSON.stringify({ sourceId: "codex", connectionId: 123 }));
  expect(readAssistantPreference("broken")).toBeUndefined();
});

it("只从能力事实产生思考强度：unknown / supported 无档位不制造选项", () => {
  const models = [
    { id: "a", label: "A", reasoning: { state: "supported" as const, source: "provider" as const, revision: "r", efforts: [{ id: "low" as const }, { id: "high" as const }] } },
    { id: "b", label: "B", reasoning: { state: "supported" as const, source: "provider" as const, revision: "r" } },
    { id: "c", label: "C", reasoning: { state: "unknown" as const, source: "provider" as const, revision: "r" } },
    { id: "d", label: "D", reasoning: { state: "unsupported" as const, source: "provider" as const, revision: "r" } }
  ];
  expect(agentModelSelection(models, "a", "", true)).toMatchObject({ supportedEfforts: ["low", "high"], invalidEffort: false });
  expect(agentModelSelection(models, "a", "medium", true).invalidEffort).toBe(true);
  for (const id of ["b", "c", "d"]) expect(agentModelSelection(models, id, "", true).supportedEfforts).toEqual([]);
  expect(agentModelSelection(models, "missing", "", true)).toMatchObject({ invalidModel: true });
});

it("连接视图只有模型选择时，从同一 adapter 目录补齐能力", () => {
  const connectionModels = [{ id: "m", label: "M" }, { id: "kept", label: "Kept", reasoning: { state: "unsupported" as const, source: "provider" as const, revision: "r" } }];
  const catalog = [
    { id: "m", label: "M", reasoning: { state: "supported" as const, source: "provider" as const, revision: "r", efforts: [{ id: "high" as const }] } },
    { id: "kept", label: "Kept", reasoning: { state: "supported" as const, source: "provider" as const, revision: "r", efforts: [{ id: "low" as const }] } }
  ];
  const merged = agentDirectoryModels(connectionModels, catalog);
  expect(agentModelSelection(merged, "m", "", true).supportedEfforts).toEqual(["high"]);
  expect(agentModelSelection(merged, "kept", "", true).supportedEfforts).toEqual([]);
});
