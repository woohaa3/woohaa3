/** Projects the existing owner-bound OAuth account without copying credentials. */
import { createHash } from "node:crypto";
import { reasoningCapabilityOf, type AgentConnectionModel, type AgentConnectionProvider, type AgentConnectionView, type AgentConversationAdapter, type AgentModelView } from "@woohaa3/contracts";
import type { ChatGptService } from "./service.js";

export function createOAuthConnectionProvider(options: {
  service: ChatGptService;
  adapter: AgentConversationAdapter;
  ownerIdFor: (owner: string) => string;
  /**
   * 本进程已为该 owner 读取成功的账号模型目录（带授权 epoch）。
   *
   * 连接视图必须和 adapter catalog 给出同一份模型级思考档位：只返回空模型会让受理回合
   * 把所有显式强度当成未开放。目录仍由 catalog 读取，这里只复用最近一次成功结果。
   */
  observedModelsFor?: (owner: string) => { epoch: number; models: readonly AgentModelView[] } | undefined;
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
    const credentialEpoch = Number.parseInt(createHash("sha256").update(`${account.subject}:${account.connectedAt}`).digest("hex").slice(0, 12), 16);
    // 只复用同一授权 epoch 的目录；重新授权后旧目录不再对外投影，未授权时不展示模型。
    const observed = options.observedModelsFor?.(owner);
    const models: AgentConnectionModel[] = authorized && observed?.epoch === credentialEpoch
      ? observed.models.map((model) => {
        const reasoning = model.reasoning ?? reasoningCapabilityOf(model);
        const efforts = reasoning.state === "supported" ? (reasoning.efforts ?? []).map((option) => option.id) : [];
        return {
          id: model.id,
          label: model.label,
          source: "remote-catalog" as const,
          accountAuthorized: true,
          reasoning,
          ...(efforts.length ? { reasoningEfforts: efforts } : {})
        };
      })
      : [];
    return {
      connectionId: `oauth-${createHash("sha256").update(ownerId).digest("hex")}`,
      adapterId: options.adapter.id, extensionId: "oauth-agent", name: account.email ? `ChatGPT · ${account.email}` : "ChatGPT · 我的账号",
      runCategory: "agent-sdk", authMode: "oauth", configRevision: 1,
      credentialEpoch,
      status: { transport: unknown, credential, modelAccess: unknown, tools: unknown },
      ready: false, credentialConfigured: true,
      capabilities: { textDelivery: { imageInput: true, maxImages: 12 }, discussion: authorized, imageInput: false, tools: authorized, structuredResult: false, cancel: true, resume: true, targets: ["model3d"] },
      models, ...(!authorized ? { reason: credential.reason } : {})
    };
  };
  return { id: "oauth-agent", listConnections: async ({ owner }) => { const view = await project(owner); return view ? [view] : []; },
    getConnection: async ({ owner, connectionId }) => { const view = await project(owner); return view?.connectionId === connectionId ? view : null; } };
}
