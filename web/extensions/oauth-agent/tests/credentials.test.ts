/**
 * per-user 加密凭据仓库测试
 * （change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 2.1）。
 */
import { mkdtempSync, rmSync, statSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChatGptCredentialStore, type ChatGptCredentialRecord } from "../src/backend/credentials.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-chatgpt-"));
  dirs.push(dir);
  return dir;
}

function record(accessToken = "access-secret"): ChatGptCredentialRecord {
  return {
    account: {
      clientId: "client-1",
      subject: "chatgpt-sub",
      scopes: ["chatgpt.tokens.use.direct"],
      accessToken,
      refreshToken: "refresh-secret",
      idToken: "id-secret",
      expiresAt: Date.now() + 3600_000,
      connectedAt: new Date().toISOString()
    },
    host: { extAgentHostId: "urn:uuid:host-1" }
  };
}

describe("ChatGPT 凭据仓库", () => {
  it("按 owner 加密持久化并重启后解密恢复", () => {
    const dir = tempDir();
    const store = createChatGptCredentialStore({ directory: dir, masterKey: Buffer.alloc(32, 7) });
    store.write("principal:user-a", record());
    // 新建实例模拟重启（同一密钥）。
    const reopened = createChatGptCredentialStore({ directory: dir, masterKey: Buffer.alloc(32, 7) });
    const read = reopened.read("principal:user-a");
    expect(read?.account.accessToken).toBe("access-secret");
    expect(reopened.read("principal:user-b")).toBeNull();
  });

  it("密文不含明文 token，且目录/文件权限受限", () => {
    const dir = tempDir();
    const store = createChatGptCredentialStore({ directory: dir, masterKey: Buffer.alloc(32, 9) });
    store.write("principal:user-a", record("plaintext-access-token"));
    const ownersDir = path.join(dir, "owners");
    const file = path.join(ownersDir, readdirSync(ownersDir)[0]!);
    const envelope = readFileSync(file, "utf8");
    expect(envelope).not.toContain("plaintext-access-token");
    expect(envelope).not.toContain("refresh-secret");
    // Windows 的 NTFS 没有 POSIX 权限位，chmod 不生效。
    if (process.platform !== "win32") {
      expect((statSync(file).mode & 0o777)).toBe(0o600);
    }
  });

  it("不同 owner 不能用彼此密文解封（AAD 绑定）", () => {
    const dir = tempDir();
    const store = createChatGptCredentialStore({ directory: dir, masterKey: Buffer.alloc(32, 3) });
    store.write("principal:user-a", record());
    // 把 user-a 的密文复制到 user-b 的文件路径：AAD 不匹配应解封失败。
    const ownersDir = path.join(dir, "owners");
    const fileA = path.join(ownersDir, readdirSync(ownersDir)[0]!);
    const envelope = readFileSync(fileA, "utf8");
    store.write("principal:user-b", record("b-token"));
    const files = readdirSync(ownersDir).map((name) => path.join(ownersDir, name));
    const fileB = files.find((candidate) => candidate !== fileA)!;
    // 覆盖 b 的密文为 a 的密文。
    require("node:fs").writeFileSync(fileB, envelope, { mode: 0o600 });
    expect(store.read("principal:user-b")).toBeNull();
  });

  it("clear 幂等删除", () => {
    const dir = tempDir();
    const store = createChatGptCredentialStore({ directory: dir, masterKey: Buffer.alloc(32, 1) });
    store.write("principal:user-a", record());
    store.clear("principal:user-a");
    expect(store.read("principal:user-a")).toBeNull();
    expect(() => store.clear("principal:user-a")).not.toThrow();
  });
});
