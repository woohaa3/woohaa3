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
    expect(first).toMatchObject({ name: "ChatGPT · me@example.com", authMode: "oauth", capabilities: { discussion: true, tools: true }, models: [], ready: false });
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
});
