import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openInstanceDataScope, verifiedLegacyInstanceMigration } from "@woohaa3/application-service";
import { createChatGptCredentialStore } from "@woohaa3/extension-oauth-agent/backend";

/** 只用宿主部署配置与已解密记录选择兼容归属。凭据文件保持原 AAD。 */
export function openBackendInstanceScope(env: Record<string, string | undefined>, sourceStorePath?: string) {
  const storePath = env.WOOHAA3_APPLICATION_STORE_PATH;
  if (!storePath) throw new Error("缺少 WOOHAA3_APPLICATION_STORE_PATH");
  fs.mkdirSync(path.dirname(path.resolve(storePath)), { recursive: true });
  const directory = env.WOOHAA3_CHATGPT_CREDENTIAL_DIR;
  const key = Buffer.from(env.WOOHAA3_CHATGPT_MASTER_KEY ?? "", "base64");
  const credentialStore = directory && key.byteLength === 32 ? createChatGptCredentialStore({ directory, masterKey: key }) : null;
  const migration = verifiedLegacyInstanceMigration(storePath, {
    sourceStorePath,
    hasCredential: owner => {
      if (!directory) return false;
      const file = path.join(directory, "owners", `${createHash("sha256").update(owner).digest("hex")}.json`);
      if (!fs.existsSync(file)) return false;
      if (!credentialStore?.read(owner)) throw new Error("旧实例凭据无法解密，请恢复原主密钥后重试迁移");
      return true;
    }
  });
  return openInstanceDataScope(storePath, migration);
}
