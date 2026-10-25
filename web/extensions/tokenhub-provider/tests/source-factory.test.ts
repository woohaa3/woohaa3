import { expect, it, vi } from "vitest";
import type { PptaskProvider } from "@sdppp/pptask";
import { createTokenHubRegistration } from "../src/backend.js";

it("uses per-source execution material without mutating the site singleton and rechecks before new calls", async () => {
  const calls: Array<{ url: string; key: string | null }> = [];
  const fetchImpl = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(url), key: new Headers(init?.headers).get("authorization") });
    return Response.json({ choices: [{ message: { content: "reply" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
  const { registration } = createTokenHubRegistration({ apiKey: "site-key", baseUrl: "https://site.example/v1", fetchImpl: fetchImpl as typeof fetch });
  let active = true;
  const validate = async () => { if (!active) throw Object.assign(new Error("revoked"), { sourceStale: true }); };
  const personal = registration.serviceConnectionFactory!.create({ secret: "alice-key", endpoint: "https://alice.example/v1", validate }) as PptaskProvider;
  const other = registration.serviceConnectionFactory!.create({ secret: "bob-key", endpoint: "https://bob.example/v1", validate }) as PptaskProvider;
  const input = { prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] } as never;
  await personal.languageModel("hy3").doGenerate!(input);
  await other.languageModel("hy3").doGenerate!(input);
  await (registration.provider as PptaskProvider).languageModel("hy3").doGenerate!(input);
  expect(calls.map(call => call.key)).toEqual(["Bearer alice-key", "Bearer bob-key", "Bearer site-key"]);
  expect(calls.map(call => new URL(call.url).hostname)).toEqual(["alice.example", "bob.example", "site.example"]);
  active = false;
  await expect(personal.languageModel("hy3").doGenerate!(input)).rejects.toMatchObject({ sourceStale: true });
  expect(calls).toHaveLength(3);
});
