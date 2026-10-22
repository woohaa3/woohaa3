/** Projects the existing owner-bound OAuth account without copying credentials. */
import { createHash } from "node:crypto";
import type { AgentConnectionProvider, AgentConnectionView, AgentConversationAdapter } from "@woohaa3/contracts";
import type { ChatGptService } from "./service.js";

export function createOAuthConnectionProvider(options: {
  service: ChatGptService; adapter: AgentConversationAdapter; ownerIdFor: (owner: string) => string;
}): AgentConnectionProvider {
  const project = async (owner: string): Promise<AgentConnectionView | null> => {
    if (!options.service.enabled || !options.service.authorization) return null;
    const ownerId = options.ownerIdFor(owner);
    const snapshot = options.service.authorization.snapshot(ownerId, ownerId.startsWith("local:") ? "local-session" : "principal");
    // No account means no configured connection. Opening the tool never starts OAuth.
    const account = options.service.authorization.account(ownerId);
    if (!account) return null;
    const authorized = snapshot.state === "ready";
    const unknown = { state: "unknown" as const };
    const credential = authorized ? { state: "ready" as const } : { state: "unavailable" as const, reason: snapshot.message ?? "请重新连接 ChatGPT" };
    return {
      connectionId: `oauth-${createHash("sha256").update(ownerId).digest("hex")}`,
      adapterId: options.adapter.id, extensionId: "oauth-agent", name: account.email ? `ChatGPT · ${account.email}` : "ChatGPT · 我的账号",
      runCategory: "agent-sdk", authMode: "oauth", configRevision: 1,
      credentialEpoch: Number.parseInt(createHash("sha256").update(`${account.subject}:${account.connectedAt}`).digest("hex").slice(0, 12), 16),
      status: { transport: unknown, credential, modelAccess: unknown, tools: unknown },
      ready: false, credentialConfigured: true,
      capabilities: { discussion: authorized, imageInput: false, tools: authorized, structuredResult: false, cancel: true, resume: true },
      models: [], ...(!authorized ? { reason: credential.reason } : {})
    };
  };
  return { id: "oauth-agent", listConnections: async ({ owner }) => { const view = await project(owner); return view ? [view] : []; },
    getConnection: async ({ owner, connectionId }) => { const view = await project(owner); return view?.connectionId === connectionId ? view : null; } };
}
