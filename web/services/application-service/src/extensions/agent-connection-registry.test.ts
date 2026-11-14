/**
 * 受控 Agent 连接发现注册表测试
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 2.1 / design D3）。
 *
 * 覆盖：owner 绑定与每次调用复查（停用立即不可见）、恢复模式不可用、形状/身份校验、
 * 跨提供方聚合/去重/按 adapter 过滤，以及核心只依赖 capability 契约（无厂商实现 import）。
 */
import { describe, expect, it } from "vitest";
import type { AgentConnectionStatus, AgentConnectionView, AgentConnectionProvider } from "@woohaa3/contracts";
import { createApplicationExtensionHost } from "./host.js";
import { createAgentConnectionRegistry } from "./agent-connection-registry.js";

const ready: AgentConnectionStatus = {
  transport: { state: "ready", checkedAt: "2026-10-16T00:00:00.000Z" },
  credential: { state: "ready", checkedAt: "2026-10-16T00:00:00.000Z" },
  modelAccess: { state: "ready", checkedAt: "2026-10-16T00:00:00.000Z" },
  tools: { state: "ready", checkedAt: "2026-10-16T00:00:00.000Z" }
};

function view(overrides: Partial<AgentConnectionView> & { connectionId: string; adapterId: string; extensionId: string }): AgentConnectionView {
  return {
    name: overrides.connectionId,
    runCategory: "http-sdk",
    authMode: "api-key",
    configRevision: 1,
    credentialEpoch: 0,
    status: ready,
    ready: true,
    capabilities: { discussion: true, imageInput: true, tools: true, structuredResult: true, cancel: true, resume: false },
    models: [],
    credentialConfigured: true,
    ...overrides
  };
}

function provider(id: string, connections: readonly AgentConnectionView[], overrides: Partial<AgentConnectionProvider> = {}): AgentConnectionProvider {
  return {
    id,
    listConnections: async () => connections,
    ...overrides
  };
}

const CAP = (id: string) => `agent-connection-provider:${id}`;

async function hostWith(definitions: Array<{ extensionId: string; register: (h: import("./contract.js").ApplicationBackendHost) => void }>) {
  const host = createApplicationExtensionHost();
  for (const definition of definitions) {
    const result = await host.activate({ extensionId: definition.extensionId, activate: (h) => definition.register(h) });
    if (!result.ok) throw new Error(`activation failed: ${definition.extensionId}`);
  }
  return host;
}

describe("连接注册表 · owner 绑定与版本（任务 2.1）", () => {
  it("resolve 返回版本绑定 handle 并校验身份/形状", async () => {
    const connection = view({ connectionId: "c1", adapterId: "openai-responses", extensionId: "sdk-agent" });
    const host = await hostWith([{ extensionId: "sdk-agent", register: (h) => h.registerCapability({ id: CAP("sdk-agent"), version: 1, value: provider("sdk-agent", [connection]) }) }]);
    const registry = createAgentConnectionRegistry(host);
    const resolved = registry.resolve("sdk-agent");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.handle.owner).toMatchObject({ providerId: "sdk-agent", extensionId: "sdk-agent", mode: "public" });
    expect(resolved.handle.provider.id).toBe("sdk-agent");
  });

  it("未知 providerId 返回 adapter-unavailable", async () => {
    const host = await hostWith([]);
    const registry = createAgentConnectionRegistry(host);
    expect(registry.resolve("missing")).toEqual({ ok: false, code: "adapter-unavailable", message: expect.any(String) });
  });

  it("capability 身份不一致或形状非法时拒绝（不冒用其它 provider）", async () => {
    const host = await hostWith([
      { extensionId: "sdk-agent", register: (h) => h.registerCapability({ id: CAP("sdk-agent"), version: 1, value: { id: "other", listConnections: async () => [] } }) }
    ]);
    const registry = createAgentConnectionRegistry(host);
    expect(registry.resolve("sdk-agent")).toEqual({ ok: false, code: "adapter-unavailable", message: expect.any(String) });
  });

  it("扩展停用后立即不可见（不裸缓存 capability）", async () => {
    const connection = view({ connectionId: "c1", adapterId: "openai-responses", extensionId: "sdk-agent" });
    const host = createApplicationExtensionHost();
    const activation = await host.activate({ extensionId: "sdk-agent", activate: (h) => h.registerCapability({ id: CAP("sdk-agent"), version: 1, value: provider("sdk-agent", [connection]) }) });
    if (!activation.ok) throw new Error("activate");
    const registry = createAgentConnectionRegistry(host);
    expect(registry.resolve("sdk-agent").ok).toBe(true);
    await activation.handle.dispose();
    expect(registry.resolve("sdk-agent").ok).toBe(false);
    expect(await registry.listConnections({ owner: "user-a" })).toEqual([]);
  });

  it("恢复模式 provider 不提供公共连接", async () => {
    const connection = view({ connectionId: "c1", adapterId: "openai-responses", extensionId: "sdk-agent" });
    const host = createApplicationExtensionHost();
    await host.activateVersioned({ extensionId: "sdk-agent", activate: (h) => h.registerCapability({ id: CAP("sdk-agent"), version: 1, value: provider("sdk-agent", [connection]) }) }, 1, "recovery");
    const registry = createAgentConnectionRegistry(host);
    expect(registry.resolve("sdk-agent").ok).toBe(false);
    expect(registry.list()).toEqual([]);
  });
});

describe("连接注册表 · 聚合与隔离（任务 2.1）", () => {
  it("list 只枚举 public provider 并按 id 排序", async () => {
    const host = await hostWith([
      { extensionId: "sdk-agent", register: (h) => h.registerCapability({ id: CAP("zeta"), version: 1, value: provider("zeta", []) }) },
      { extensionId: "local-agent", register: (h) => h.registerCapability({ id: CAP("alpha"), version: 1, value: provider("alpha", []) }) }
    ]);
    const registry = createAgentConnectionRegistry(host);
    expect(registry.list().map((owner) => owner.providerId)).toEqual(["alpha", "zeta"]);
  });

  it("listConnections 按 owner 聚合、按 adapter 过滤、按 connectionId 去重并排序", async () => {
    const host = await hostWith([
      {
        extensionId: "sdk-agent",
        register: (h) => h.registerCapability({
          id: CAP("sdk-agent"),
          version: 1,
          value: provider("sdk-agent", [
            view({ connectionId: "c2", adapterId: "openai-responses", extensionId: "sdk-agent" }),
            view({ connectionId: "c1", adapterId: "openai-responses", extensionId: "sdk-agent" })
          ])
        })
      },
      {
        extensionId: "local-agent",
        register: (h) => h.registerCapability({
          id: CAP("local-agent"),
          version: 1,
          value: provider("local-agent", [view({ connectionId: "c1", adapterId: "codex-appserver", extensionId: "local-agent", runCategory: "local-appserver", authMode: "local-login" })])
        })
      }
    ]);
    const registry = createAgentConnectionRegistry(host);
    const all = await registry.listConnections({ owner: "user-a" });
    expect(all.map((entry) => entry.connectionId)).toEqual(["c1", "c2"]);
    const responses = await registry.listConnections({ owner: "user-a", adapterId: "openai-responses" });
    expect(responses.map((entry) => entry.extensionId)).toEqual(["sdk-agent", "sdk-agent"]);
  });

  it("getConnection 只返回匹配 id，且跨 owner 由提供方返回 null 时不泄露", async () => {
    const seen: string[] = [];
    const host = await hostWith([
      {
        extensionId: "sdk-agent",
        register: (h) => h.registerCapability({
          id: CAP("sdk-agent"),
          version: 1,
          value: provider("sdk-agent", [], {
            getConnection: async ({ owner, connectionId }) => {
              seen.push(owner);
              if (owner !== "user-a") return null;
              return view({ connectionId, adapterId: "openai-responses", extensionId: "sdk-agent" });
            }
          })
        })
      }
    ]);
    const registry = createAgentConnectionRegistry(host);
    expect((await registry.getConnection({ owner: "user-a", connectionId: "c1" }))?.connectionId).toBe("c1");
    expect(await registry.getConnection({ owner: "user-b", connectionId: "c1" })).toBeNull();
    expect(seen).toEqual(["user-a", "user-b"]);
  });

  it("抛出异常的 provider 被跳过（fail closed，不影响其它来源）", async () => {
    const host = await hostWith([
      {
        extensionId: "sdk-agent",
        register: (h) => h.registerCapability({ id: CAP("sdk-agent"), version: 1, value: provider("sdk-agent", [], { listConnections: async () => { throw new Error("boom"); } }) })
      },
      {
        extensionId: "local-agent",
        register: (h) => h.registerCapability({ id: CAP("local-agent"), version: 1, value: provider("local-agent", [view({ connectionId: "ok", adapterId: "codex-appserver", extensionId: "local-agent" })]) })
      }
    ]);
    const registry = createAgentConnectionRegistry(host);
    expect((await registry.listConnections({ owner: "user-a" })).map((entry) => entry.connectionId)).toEqual(["ok"]);
  });
});
