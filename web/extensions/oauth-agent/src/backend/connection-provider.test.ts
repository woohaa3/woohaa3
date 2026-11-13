import { describe, expect, it } from "vitest";
import { createOAuthConnectionProvider } from "./connection-provider.js";
import type { ChatGptService } from "./service.js";
import type { AgentConversationAdapter } from "@woohaa3/contracts";

describe("OAuth 同 owner 统一连接发现", () => {
  it("引用原账号，授权与订阅分开；不启动授权、不读取目录或复制 token", async () => {
    let state = "ready";
    const account = { subject: "account-subject", email: "me@example.com", connectedAt: "2026-10-17", accessToken: "secret-token", refreshToken: "refresh-secret" };
    const service = { enabled: true, authorization: { snapshot: (_owner: string) => ({ state, ...(state === "ready" ? {} : { message: "请继续使用授权" }) }), account: (owner: string) => owner === "principal:one" ? account : null } } as unknown as ChatGptService;
    const provider = createOAuthConnectionProvider({ service, adapter: { id: "chatgpt" } as AgentConversationAdapter, ownerIdFor: (owner) => `principal:${owner}` });
    expect(await provider.listConnections({ owner: "two" })).toEqual([]);
    const [first] = await provider.listConnections({ owner: "one" });
    expect(first).toMatchObject({ name: "ChatGPT · me@example.com", authMode: "oauth", capabilities: { discussion: true, tools: true, textDelivery: { imageInput: true, maxImages: 12 } }, models: [], ready: false });
    expect(JSON.stringify(first)).not.toContain("secret-token");
    expect(JSON.stringify(first)).not.toContain("refresh-secret");
    account.accessToken = "refreshed-token";
    const [refreshed] = await provider.listConnections({ owner: "one" });
    expect(refreshed?.credentialEpoch).toBe(first?.credentialEpoch);
    state = "expired";
    expect((await provider.listConnections({ owner: "one" }))[0]?.status.credential.state).toBe("unavailable");
    account.connectedAt = "2026-10-18";
    state = "ready";
    const [reconnected] = await provider.listConnections({ owner: "one" });
    expect(reconnected?.connectionId).toBe(first?.connectionId);
    expect(reconnected?.credentialEpoch).not.toBe(first?.credentialEpoch);
    state = "connected-without-plan";
    const [restricted] = await provider.listConnections({ owner: "one" });
    expect(restricted?.connectionId).toBe(first?.connectionId);
    expect(restricted?.capabilities.discussion).toBe(false);
    expect(restricted?.status.credential.state).toBe("unavailable");
    expect(await provider.getConnection!({ owner: "two", connectionId: first!.connectionId })).toBeNull();
  });

  it("把本进程读取成功的账号目录投影为同一份模型级思考档位", async () => {
    const account = { subject: "account-subject", email: "me@example.com", connectedAt: "2026-10-17" };
    const service = { enabled: true, authorization: { snapshot: () => ({ state: "ready" }), account: () => account } } as unknown as ChatGptService;
    let observed: { epoch: number; models: Array<{ id: string; label: string; reasoningEfforts: Array<"low" | "high"> }> } | undefined;
    const provider = createOAuthConnectionProvider({ service, adapter: { id: "chatgpt" } as AgentConversationAdapter, ownerIdFor: (owner) => `principal:${owner}`, observedModelsFor: () => observed });
    const [accountView] = await provider.listConnections({ owner: "one" });
    expect(accountView?.models).toEqual([]);
    observed = { epoch: accountView!.credentialEpoch, models: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol", reasoningEfforts: ["low", "high"] }] };
    const [first] = await provider.listConnections({ owner: "one" });
    expect(first?.models).toMatchObject([{ id: "gpt-6.1-sol", source: "remote-catalog", accountAuthorized: true, reasoningEfforts: ["low", "high"] }]);

    // 重新授权后 epoch 变化：旧目录不再投影，避免把上一账号的档位当成当前账号事实。
    observed = { epoch: accountView!.credentialEpoch + 1, models: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol", reasoningEfforts: ["low"] }] };
    const [stale] = await provider.listConnections({ owner: "one" });
    expect(stale?.models).toEqual([]);
  });
});
