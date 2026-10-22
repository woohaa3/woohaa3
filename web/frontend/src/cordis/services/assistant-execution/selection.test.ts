/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { readAssistantPreference, rememberAssistantPreference } from "./selection.js";
import { creationDraft } from "../../plugins/canvas-menu/canvas-creation-drafts.js";
import type { ApplicationRemoteTransport } from "../../contract/remote.js";

afterEach(() => { localStorage.clear(); });

it("persists assistant/model/Variant across module reloads and new canvas panels, with owner isolation", async () => {
  const selected = { sourceId: "codex-appserver", connectionId: "local-codex", model: "gpt-6.1-sol", reasoningEffort: "medium" as const };
  rememberAssistantPreference("owner", selected);
  vi.resetModules();
  const reloaded = await import("./selection.js");
  expect(reloaded.readAssistantPreference("owner")).toEqual(selected);
  expect(reloaded.readAssistantPreference("other-owner")).toBeUndefined();
  const draft = creationDraft({} as ApplicationRemoteTransport, "owner", "new-canvas");
  expect(draft).toMatchObject({ connectionId: selected.connectionId, model: selected.model, effort: "medium" });
  rememberAssistantPreference("owner", { sourceId: "other", connectionId: "second" });
  expect(creationDraft({} as ApplicationRemoteTransport, "owner", "another-canvas").connectionId).toBe("second");
  expect(draft.connectionId).toBe("local-codex");
});

it("ignores malformed persisted identities", () => {
  localStorage.setItem("woohaa3.assistant-selection.v1:broken", "{broken");
  expect(readAssistantPreference("broken")).toBeUndefined();
  localStorage.setItem("woohaa3.assistant-selection.v1:broken", JSON.stringify({ sourceId: "codex", connectionId: 123 }));
  expect(readAssistantPreference("broken")).toBeUndefined();
});
