/**
 * 通用宿主秘密配置解析测试
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 1.2 / design D4）。
 *
 * 覆盖：无 ChatGPT 配置可保存 SDK Key、独立主密钥与旧配置兼容、配置缺失拒绝、
 * 不同新旧密钥同时存在时拒绝（不静默换密钥/覆盖密文）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHATGPT_MASTER_KEY_ENV,
  PLUGIN_SECRET_DIR_ENV,
  PLUGIN_SECRET_MASTER_KEY_ENV,
  resolveChatGptSecretStore,
  resolveHostSecretStore
} from "./config.js";

const keyA = Buffer.alloc(32, 1).toString("base64");
const keyB = Buffer.alloc(32, 2).toString("base64");
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa-secret-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("resolveHostSecretStore", () => {
  it("无 ChatGPT 配置也能用独立插件主密钥保存 SDK Key", () => {
    const dir = tempDir();
    const resolved = resolveHostSecretStore({ [PLUGIN_SECRET_DIR_ENV]: dir, [PLUGIN_SECRET_MASTER_KEY_ENV]: keyA });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.store.masterKeySource).toBe("plugin");
    const store = resolved.store.forExtension("sdk-agent");
    const written = store.write("owner-1", "model-api-key", { apiKey: "sk-test" }, { version: 0 });
    expect(written).toEqual({ ok: true, version: 1 });
    expect(store.read<{ apiKey: string }>("owner-1", "model-api-key")?.value.apiKey).toBe("sk-test");
  });

  it("兼容旧 ChatGPT 配置作为唯一来源", () => {
    const dir = tempDir();
    const resolved = resolveHostSecretStore({ [PLUGIN_SECRET_DIR_ENV]: dir, [CHATGPT_MASTER_KEY_ENV]: keyA });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.store.masterKeySource).toBe("chatgpt-compat");
  });

  it("目录回退到 ChatGPT 凭据目录下的 plugin-secrets", () => {
    const dir = tempDir();
    const resolved = resolveHostSecretStore({ WOOHAA3_CHATGPT_CREDENTIAL_DIR: dir, [CHATGPT_MASTER_KEY_ENV]: keyA });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.store.directory).toBe(`${dir}/plugin-secrets`);
  });

  it("配置缺失时拒绝（不静默回退明文）", () => {
    const missingDir = resolveHostSecretStore({ [PLUGIN_SECRET_MASTER_KEY_ENV]: keyA });
    expect(missingDir.ok).toBe(false);
    if (!missingDir.ok) expect(missingDir.code).toBe("unconfigured");

    const missingKey = resolveHostSecretStore({ [PLUGIN_SECRET_DIR_ENV]: tempDir() });
    expect(missingKey.ok).toBe(false);
    if (!missingKey.ok) expect(missingKey.code).toBe("unconfigured");

    const shortKey = resolveHostSecretStore({ [PLUGIN_SECRET_DIR_ENV]: tempDir(), [PLUGIN_SECRET_MASTER_KEY_ENV]: "AAAA" });
    expect(shortKey.ok).toBe(false);
  });

  it("新旧主密钥不一致时拒绝并提示显式迁移", () => {
    const resolved = resolveHostSecretStore({
      [PLUGIN_SECRET_DIR_ENV]: tempDir(),
      [PLUGIN_SECRET_MASTER_KEY_ENV]: keyA,
      [CHATGPT_MASTER_KEY_ENV]: keyB
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.code).toBe("conflict");
      expect(resolved.message).toContain("迁移");
    }
    // 兼容入口同样拒绝（不静默选用其中一个密钥覆盖既有密文）。
    expect(resolveChatGptSecretStore({ [PLUGIN_SECRET_DIR_ENV]: tempDir(), [PLUGIN_SECRET_MASTER_KEY_ENV]: keyA, [CHATGPT_MASTER_KEY_ENV]: keyB })).toBeNull();
  });

  it("新旧主密钥一致时按独立来源接受", () => {
    const resolved = resolveHostSecretStore({
      [PLUGIN_SECRET_DIR_ENV]: tempDir(),
      [PLUGIN_SECRET_MASTER_KEY_ENV]: keyA,
      [CHATGPT_MASTER_KEY_ENV]: keyA
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.store.masterKeySource).toBe("plugin");
  });
});
