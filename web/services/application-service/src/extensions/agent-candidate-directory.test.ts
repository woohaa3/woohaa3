import { describe, expect, it, vi } from "vitest";
import { agentConnectionProviderCapabilityId, type AgentConnectionProvider, type FilmSetConversionProvider } from "@woohaa3/contracts";
import { candidateAssistantDirectory } from "./agent-candidate-directory.js";

describe("candidate provider directory projection", () => {
  it("reads without inference, invalidates replaced providers and removes disabled connections", async () => {
    const generate = vi.fn();
    const make = (): FilmSetConversionProvider => ({ providerId: "site", assistantAdapterId: "candidate", createGenerator: () => generate,
      resolveCapabilities: () => null, listModels: () => [{ modelKey: "site:vision", label: "Vision", assistant: { adapterId: "candidate", model: "vision" }, supports: ["image"],
        capabilities: { structuredCandidateOutput: true, input: { imageInput: true, maxImages: 1, videoInput: false, maxFrames: 0, maxDurationSeconds: 0 } } }] });
    let providers = [make()];
    const host = candidateAssistantDirectory({ hasCapability: () => false, resolveCapability: () => undefined, snapshot: () => [] }, () => providers);
    const id = agentConnectionProviderCapabilityId("candidate-site");
    const connections = () => host.resolveCapability(id) as AgentConnectionProvider;
    expect(await connections().listConnections({ owner: "" })).toEqual([]);
    const first = (await connections().listConnections({ owner: "a" }))[0]!;
    expect(first.capabilities.textDelivery).toBeUndefined();
    expect(first.capabilities.tools).toBe(false);
    expect((await connections().listConnections({ owner: "a" }))[0]!.configRevision).toBe(first.configRevision);
    providers = [make()];
    expect((await connections().listConnections({ owner: "a" }))[0]!.configRevision).toBeGreaterThan(first.configRevision);
    providers = [];
    expect(host.hasCapability(id)).toBe(false);
    expect(host.snapshot?.()).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
  });
});
