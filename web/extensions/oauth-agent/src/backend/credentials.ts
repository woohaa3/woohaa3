/**
 * per-user 加密 OAuth 凭据仓库
 * （change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 2.1 / design D2）。
 *
 * access/refresh/ID token 只在此按 owner 加密持久化：
 * - 目录 0700、文件 0600；原子写入（tmp + rename）；
 * - AES-256-GCM，AAD 绑定 owner 摘要，禁止跨 owner 解封；
 * - 主密钥由部署配置注入，与密文同盘只提供受控持久化与备份隔离，不宣称抵御整机失陷。
 *
 * token MUST NOT 进入浏览器存储、共享 Provider store、公开响应、日志或 Codex 会话目录。
 */
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** 已保存的账户/client/host 映射与经过验证的 token。 */
export type ChatGptAccountCredential = {
  clientId: string;
  /** 经过验证的 ChatGPT subject；用于核验续期身份，不用于选择本应用 owner。 */
  subject: string;
  email?: string;
  iss?: string;
  scopes: string[];
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  connectedAt: string;
};

export type ChatGptCredentialRecord = {
  account: ChatGptAccountCredential;
  host: { extAgentHostId: string };
};

export type ChatGptCredentialStore = {
  /** 读取 owner 的凭据；不存在/解密失败返回 null。 */
  read: (ownerId: string) => ChatGptCredentialRecord | null;
  /** 加密持久化 owner 的凭据（原子写入）。 */
  write: (ownerId: string, record: ChatGptCredentialRecord) => void;
  /** 清除 owner 的凭据文件（幂等）。 */
  clear: (ownerId: string) => void;
  /** 实际凭据目录（供部署证据记录）。 */
  directory: () => string;
};

const ENVELOPE_VERSION = 1;

function ownerFileFor(dir: string, ownerId: string): string {
  const digest = createHash("sha256").update(ownerId, "utf8").digest("hex");
  return path.join(dir, "owners", `${digest}.json`);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* 文件系统不支持时忽略；不影响加密边界。 */
  }
}

export function createChatGptCredentialStore(options: {
  directory: string;
  masterKey: Buffer;
}): ChatGptCredentialStore {
  const dir = options.directory;
  const key = options.masterKey;
  if (key.byteLength !== 32) throw new Error("ChatGPT 凭据主密钥必须是 32 字节");

  const encrypt = (ownerId: string, record: ChatGptCredentialRecord): string => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    // AAD 绑定 owner 摘要：不同 owner 不能用同一密文互换解封。
    cipher.setAAD(Buffer.from(ownerId, "utf8"));
    const plaintext = Buffer.from(JSON.stringify(record), "utf8");
    const sealed = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return JSON.stringify({
      v: ENVELOPE_VERSION,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: sealed.toString("base64")
    });
  };

  const decrypt = (ownerId: string, envelope: string): ChatGptCredentialRecord | null => {
    try {
      const parsed = JSON.parse(envelope) as { v?: number; iv?: string; tag?: string; data?: string };
      if (parsed.v !== ENVELOPE_VERSION || !parsed.iv || !parsed.tag || !parsed.data) return null;
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
      decipher.setAAD(Buffer.from(ownerId, "utf8"));
      decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(parsed.data, "base64")), decipher.final()]).toString("utf8");
      const record = JSON.parse(plaintext) as ChatGptCredentialRecord;
      if (!record?.account || typeof record.account.accessToken !== "string") return null;
      return record;
    } catch {
      return null;
    }
  };

  return {
    directory: () => dir,
    read(ownerId) {
      const file = ownerFileFor(dir, ownerId);
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        return null;
      }
      return decrypt(ownerId, raw);
    },
    write(ownerId, record) {
      ensureDir(path.join(dir, "owners"));
      const file = ownerFileFor(dir, ownerId);
      const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
      fs.writeFileSync(tmp, encrypt(ownerId, record), { mode: 0o600 });
      fs.renameSync(tmp, file);
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* ignore */
      }
    },
    clear(ownerId) {
      const file = ownerFileFor(dir, ownerId);
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
    }
  };
}
