/**
 * ChatGPT 扩展 identity port 与宿主会话 owner 映射测试
 * （change: 2026-10-12-add-agent-conversation-panel，任务 1.3 / design D2）。
 *
 * 覆盖：
 * - 插件注册显式宿主 identity port（`agent-conversation-identity`），把自身本地 HttpOnly 会话
 *   暴露为宿主可用 identity（本地开发返回 `local:<id>`，生产 principal 模式返回 null）；
 * - 缺省 owner 映射保留 `local:`/`principal:` 前缀，裸 subject 加 `principal:`，与凭据 owner 命名空间一致；
 * - provider adapter capability 仍以原 id 注册。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_CONVERSATION_IDENTITY_CAPABILITY_ID,
  agentConversationAdapterCapabilityId,
  isAgentConversationIdentityPort,
  type ApplicationBackendExtensionDefinition,
  type ApplicationBackendHost
} from "@woohaa3/contracts";
import { createOAuthAgentExtension, defaultConversationOwnerIdFor } from "../src/backend/index.js";
import { CHATGPT_CONVERSATION_ADAPTER_ID } from "../src/backend/conversation-adapter.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type CapabilityRegistration = { id: string; value: unknown };

/** 最小宿主桩：只记录 capability 注册，activation 不需要其它面。 */
function recordingHost(): { host: ApplicationBackendHost; capabilities: CapabilityRegistration[] } {
  const capabilities: CapabilityRegistration[] = [];
  const host = {
    extensionId: "chatgpt",
    services: {},
    registerCapability: (registration: CapabilityRegistration) => capabilities.push(registration)
  } as unknown as ApplicationBackendHost;
  return { host, capabilities };
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-identity-port-"));
  dirs.push(dir);
  return dir;
}

function activate(options: Parameters<typeof createOAuthAgentExtension>[0] = {}) {
  const { host, capabilities } = recordingHost();
  const definition: ApplicationBackendExtensionDefinition = createOAuthAgentExtension(options);
  const activation = definition.activate(host);
  if (!activation || typeof activation !== "object") throw new Error("activation 必须是同步对象");
  expect("then" in activation).toBe(false);
  return { capabilities, activation };
}

function localEnv(dir: string): Record<string, string> {
  return {
    WOOHAA3_CHATGPT_CREDENTIAL_DIR: path.join(dir, "chatgpt-creds"),
    WOOHAA3_CHATGPT_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    WOOHAA3_CHATGPT_ALLOW_LOCAL_CALLBACK: "1",
    WOOHAA3_CHATGPT_CALLBACK_ORIGIN: "http://127.0.0.1:1455"
  };
}

function identityPort(capabilities: CapabilityRegistration[]) {
  const value = capabilities.find((entry) => entry.id === AGENT_CONVERSATION_IDENTITY_CAPABILITY_ID)?.value;
  expect(isAgentConversationIdentityPort(value)).toBe(true);
  return value as { resolveLocalSession: (req: unknown) => { subject: string; sessionId: string; setCookie?: string } | null };
}

describe("ChatGPT 扩展 · 宿主 identity port（任务 1.3 / design D2）", () => {
  it("注册 agent-conversation-identity capability 且形状合法；provider adapter 仍在原 id 注册", () => {
    const { capabilities } = activate();
    expect(identityPort(capabilities)).toBeDefined();
    expect(capabilities.some((entry) => entry.id === agentConversationAdapterCapabilityId(CHATGPT_CONVERSATION_ADAPTER_ID))).toBe(true);
  });

  it("本地开发：无 cookie 时签发本地会话并暴露为 local:<id> 身份", () => {
    const dir = tempDir();
    const { capabilities } = activate({ serviceOptions: { env: localEnv(dir) } });
    const resolved = identityPort(capabilities).resolveLocalSession({ headers: {} });
    expect(resolved).not.toBeNull();
    expect(resolved!.subject).toMatch(/^local:/);
    expect(resolved!.sessionId).toBe(resolved!.subject);
    expect(resolved!.setCookie).toContain("woohaa3-chatgpt-session=");
  });

  it("本地开发：已有可信 cookie 时复用同一身份且不下发新 cookie", () => {
    const dir = tempDir();
    const { capabilities } = activate({ serviceOptions: { env: localEnv(dir) } });
    const port = identityPort(capabilities);
    const first = port.resolveLocalSession({ headers: {} })!;
    const cookie = first.setCookie!.split(";")[0]!;
    const second = port.resolveLocalSession({ headers: { cookie } });
    expect(second!.subject).toBe(first.subject);
    expect(second!.setCookie).toBeUndefined();
  });

  it("配置可信认证适配器时端口返回 null（生产不回退本地会话）", () => {
    const dir = tempDir();
    const { capabilities } = activate({ authConfigured: true, serviceOptions: { env: localEnv(dir) } });
    expect(identityPort(capabilities).resolveLocalSession({ headers: {} })).toBeNull();
  });

  it("服务未配置（缺 env）时端口返回 null，宿主不伪造身份", () => {
    const { capabilities } = activate({ serviceOptions: { env: {} } });
    expect(identityPort(capabilities).resolveLocalSession({ headers: {} })).toBeNull();
  });
});

describe("ChatGPT 扩展 · 缺省 owner 映射", () => {
  it("保留 local:/principal: 前缀，仅裸 subject 加 principal:", () => {
    expect(defaultConversationOwnerIdFor("local:abc")).toBe("local:abc");
    expect(defaultConversationOwnerIdFor("principal:alice")).toBe("principal:alice");
    expect(defaultConversationOwnerIdFor("alice")).toBe("principal:alice");
    // 不把 local 当裸 subject 二次加前缀（否则与凭据 owner 不一致）。
    expect(defaultConversationOwnerIdFor("local:abc")).not.toBe("principal:local:abc");
  });
});
