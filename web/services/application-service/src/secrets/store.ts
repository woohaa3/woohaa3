/**
 * 应用插件隔离加密秘密仓库
 * （change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 1.4/3.2/3.3 / design D5）。
 *
 * 宿主按 `extensionId/owner/purpose` 隔离加密持久化插件秘密（如个人 OAuth token）：
 * - 目录 0700、文件 0600；原子写入（tmp + rename）；
 * - AES-256-GCM，AAD 绑定 `extensionId:owner:purpose`，禁止跨作用域解封；
 * - 版本号做 compare-and-swap；授权 epoch 使断开后的旧刷新写入失效；
 * - owner + purpose 内刷新协调合并并发写入。
 *
 * 插件拿不到仓库数据库或主密钥；它只通过 `ApplicationExtensionSecretStore` 交互。每个插件获得一个
 * 绑定自身 extensionId 的实例。
 */
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type {
  ApplicationExtensionSecretStore,
  ApplicationSecretReadResult,
  ApplicationSecretWritePrecondition,
  ApplicationSecretWriteResult
} from "@woohaa3/contracts";

const ENVELOPE_VERSION = 1;
const DEFAULT_EPOCH = 0;

type StoredRecord = { version: number; epoch: number; envelope: string };

export type ApplicationSecretStoreOptions = {
  directory: string;
  masterKey: Buffer;
};

function scopeFileFor(dir: string, extensionId: string, owner: string, purpose: string): string {
  const digest = createHash("sha256").update(`${owner}\u0000${purpose}`, "utf8").digest("hex");
  return path.join(dir, extensionId, `${digest}.json`);
}

function epochFileFor(dir: string, extensionId: string, owner: string): string {
  const digest = createHash("sha256").update(`${owner}`, "utf8").digest("hex");
  return path.join(dir, extensionId, "epochs", `${digest}.json`);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
}

/**
 * 创建某插件的绑定秘密仓库实例。parent 目录由宿主部署配置指定；实例只访问 `<dir>/<extensionId>/`。
 */
export function createApplicationSecretStoreForExtension(
  options: ApplicationSecretStoreOptions & { extensionId: string }
): ApplicationExtensionSecretStore {
  const dir = options.directory;
  const key = options.masterKey;
  const extensionId = options.extensionId;
  if (key.byteLength !== 32) throw new Error("秘密仓库主密钥必须是 32 字节");
  const refreshing = new Map<string, Promise<unknown>>();

  const aad = (owner: string, purpose: string): Buffer => Buffer.from(`${owner}\u0000${purpose}`, "utf8");

  const encrypt = (owner: string, purpose: string, value: unknown): string => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(owner, purpose));
    const sealed = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), "utf8")), cipher.final()]);
    return JSON.stringify({
      v: ENVELOPE_VERSION,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: sealed.toString("base64")
    });
  };

  const decrypt = <T>(owner: string, purpose: string, envelope: string): T | null => {
    try {
      const parsed = JSON.parse(envelope) as { v?: number; iv?: string; tag?: string; data?: string };
      if (parsed.v !== ENVELOPE_VERSION || !parsed.iv || !parsed.tag || !parsed.data) return null;
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
      decipher.setAAD(aad(owner, purpose));
      decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(parsed.data, "base64")), decipher.final()]).toString("utf8");
      return JSON.parse(plaintext) as T;
    } catch {
      return null;
    }
  };

  const readEpoch = (owner: string): number => {
    try {
      const raw = fs.readFileSync(epochFileFor(dir, extensionId, owner), "utf8");
      const parsed = JSON.parse(raw) as { epoch?: number };
      return typeof parsed.epoch === "number" ? parsed.epoch : DEFAULT_EPOCH;
    } catch {
      return DEFAULT_EPOCH;
    }
  };

  const readStored = (owner: string, purpose: string): StoredRecord | null => {
    try {
      const raw = fs.readFileSync(scopeFileFor(dir, extensionId, owner, purpose), "utf8");
      const parsed = JSON.parse(raw) as StoredRecord;
      if (typeof parsed.version !== "number" || typeof parsed.envelope !== "string") return null;
      return parsed;
    } catch {
      return null;
    }
  };

  return {
    read<T>(owner: string, purpose: string): ApplicationSecretReadResult<T> {
      const stored = readStored(owner, purpose);
      if (!stored) return null;
      const value = decrypt<T>(owner, purpose, stored.envelope);
      if (value === null) return null;
      return { value, version: stored.version };
    },
    write<T>(owner: string, purpose: string, record: T, precondition: ApplicationSecretWritePrecondition): ApplicationSecretWriteResult {
      const current = readStored(owner, purpose);
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== precondition.version) {
        return { ok: false, code: "version-conflict", message: "秘密记录已被更新" };
      }
      if (precondition.epoch !== undefined && precondition.epoch !== readEpoch(owner)) {
        return { ok: false, code: "epoch-invalid", message: "授权已失效，写入被拒绝" };
      }
      ensureDir(path.join(dir, extensionId));
      const file = scopeFileFor(dir, extensionId, owner, purpose);
      const next: StoredRecord = { version: currentVersion + 1, epoch: readEpoch(owner), envelope: encrypt(owner, purpose, record) };
      const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
        fs.renameSync(tmp, file);
        try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
      } catch (error) {
        return { ok: false, code: "storage-failed", message: error instanceof Error ? error.message : "写入失败" };
      }
      return { ok: true, version: next.version };
    },
    clear(owner: string, purpose: string): void {
      try { fs.rmSync(scopeFileFor(dir, extensionId, owner, purpose), { force: true }); } catch { /* ignore */ }
    },
    epoch: (owner: string) => readEpoch(owner),
    bumpEpoch(owner: string): number {
      const next = readEpoch(owner) + 1;
      ensureDir(path.join(dir, extensionId, "epochs"));
      const file = epochFileFor(dir, extensionId, owner);
      const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ epoch: next }), { mode: 0o600 });
      fs.renameSync(tmp, file);
      return next;
    },
    refresh: {
      run<T>(owner: string, purpose: string, task: () => Promise<T>): Promise<T> {
        const key = `${owner}\u0000${purpose}`;
        const pending = refreshing.get(key) as Promise<T> | undefined;
        if (pending) return pending;
        const next = task().finally(() => refreshing.delete(key));
        refreshing.set(key, next);
        return next;
      }
    }
  };
}
