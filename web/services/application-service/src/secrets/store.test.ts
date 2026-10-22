/**
 * 隔离加密秘密仓库测试
 * （change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 1.4/3.3）。
 *
 * 验证：作用域隔离、版本 CAS、授权 epoch 使旧刷新失效、刷新协调与重启恢复。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createApplicationSecretStoreForExtension } from "./store.js";

function store(extensionId = "chatgpt") {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-secrets-"));
  return { dir, store: createApplicationSecretStoreForExtension({ directory: dir, masterKey: randomBytes(32), extensionId }) };
}

describe("应用插件隔离秘密仓库", () => {
  it("按 owner/purpose 加密往返，不泄漏明文且版本自增", () => {
    const { dir, store: s } = store();
    expect(s.read("owner-a", "oauth")).toBeNull();
    const written = s.write("owner-a", "oauth", { accessToken: "at-secret", refreshToken: "rt-secret" }, { version: 0 });
    expect(written).toEqual({ ok: true, version: 1 });
    const read = s.read<{ accessToken: string }>("owner-a", "oauth");
    expect(read?.value.accessToken).toBe("at-secret");
    expect(read?.version).toBe(1);
    // 磁盘上不出现明文。
    const fs = require("node:fs") as typeof import("node:fs");
    const files = fs.readdirSync(path.join(dir, "chatgpt")).filter((name) => name.endsWith(".json"));
    const raw = files.map((name) => fs.readFileSync(path.join(dir, "chatgpt", name), "utf8")).join("\n");
    expect(raw).not.toContain("at-secret");
  });

  it("跨 owner / purpose 不能解封，且版本 CAS 拒绝陈旧写入", () => {
    const { store: s } = store();
    s.write("owner-a", "oauth", { token: "a" }, { version: 0 });
    expect(s.read("owner-b", "oauth")).toBeNull();
    expect(s.read("owner-a", "other")).toBeNull();
    const stale = s.write("owner-a", "oauth", { token: "b" }, { version: 0 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("version-conflict");
    expect(s.write("owner-a", "oauth", { token: "b" }, { version: 1 })).toEqual({ ok: true, version: 2 });
  });

  it("授权 epoch 使断开后的旧刷新写入失效", () => {
    const { store: s } = store();
    const v0 = s.write("owner-a", "oauth", { token: "a" }, { version: 0, epoch: s.epoch("owner-a") });
    expect(v0.ok).toBe(true);
    const epochBefore = s.epoch("owner-a");
    s.bumpEpoch("owner-a");
    expect(s.epoch("owner-a")).toBe(epochBefore + 1);
    // 使用旧 epoch 的写入被拒绝（防止断开后授权复活）。
    const stale = s.write("owner-a", "oauth", { token: "b" }, { version: 1, epoch: epochBefore });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("epoch-invalid");
  });

  it("刷新协调合并并发任务；清除幂等", async () => {
    const { store: s } = store();
    let calls = 0;
    const task = () => new Promise<number>((resolve) => { calls += 1; setTimeout(() => resolve(42), 5); });
    const [a, b] = await Promise.all([s.refresh.run("o", "p", task), s.refresh.run("o", "p", task)]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(calls).toBe(1);
    s.clear("o", "p");
    s.clear("o", "p");
  });

  it("重启后可从磁盘恢复同一记录", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-secrets-"));
    const key = randomBytes(32);
    const s1 = createApplicationSecretStoreForExtension({ directory: dir, masterKey: key, extensionId: "chatgpt" });
    s1.write("owner-a", "oauth", { token: "persisted" }, { version: 0 });
    const s2 = createApplicationSecretStoreForExtension({ directory: dir, masterKey: key, extensionId: "chatgpt" });
    expect(s2.read<{ token: string }>("owner-a", "oauth")?.value.token).toBe("persisted");
  });
});
