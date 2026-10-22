import { mkdtempSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { legacyLocalDataOwner } from "@woohaa3/application-service";
import { createChatGptCredentialStore } from "@woohaa3/extension-oauth-agent/backend";
import { openBackendInstanceScope } from "./instance-scope.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "host-instance-migration-"));
  directories.push(directory);
  const storePath = path.join(directory, "application.sqlite");
  const key = Buffer.alloc(32, 17);
  const env = { WOOHAA3_APPLICATION_STORE_PATH: storePath, WOOHAA3_CHATGPT_CREDENTIAL_DIR: path.join(directory, "credentials"), WOOHAA3_CHATGPT_MASTER_KEY: key.toString("base64") };
  const credentials = createChatGptCredentialStore({ directory: env.WOOHAA3_CHATGPT_CREDENTIAL_DIR, masterKey: key });
  const owner = `principal:${legacyLocalDataOwner(storePath)}`;
  credentials.write(owner, { account: { clientId: "fixture", subject: "model-account", scopes: [], accessToken: "fixture-token", refreshToken: "fixture-refresh", idToken: "fixture-id", expiresAt: Date.now() + 60000, connectedAt: new Date().toISOString() }, host: { extAgentHostId: "fixture-host" } });
  return { directory, storePath, env, owner, credentials };
}
it("宿主核验真实 ChatGPT 密文并保存兼容归属，移动后仍能恢复", () => {
  const { directory, storePath, env, owner, credentials } = fixture();
  const first = openBackendInstanceScope(env);
  expect(first.credentialOwnerId).toBe(owner);
  expect(credentials.read(first.credentialOwnerId)?.account.accessToken).toBe("fixture-token");
  const moved = path.join(directory, "moved.sqlite");
  renameSync(storePath, moved);
  expect(openBackendInstanceScope({ ...env, WOOHAA3_APPLICATION_STORE_PATH: moved })).toEqual(first);
  expect(credentials.read("principal:first-enterprise-user")).toBeNull();
});
it("旧凭据存在但密钥错误时不静默建立新空间，恢复密钥可重试", () => {
  const { env, owner } = fixture();
  expect(() => openBackendInstanceScope({ ...env, WOOHAA3_CHATGPT_MASTER_KEY: Buffer.alloc(32, 18).toString("base64") })).toThrow("无法解密");
  expect(openBackendInstanceScope(env).credentialOwnerId).toBe(owner);
});
