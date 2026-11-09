/** Finalize disk images before hashes/copies are produced. Tauri notarizes the app only. */
import { spawnSync } from "node:child_process";
import { notarizationCredentials } from "./macos-signing.mjs";

export function notarizeMacDiskImages({ artifacts, signing, env = process.env, spawn = spawnSync, log = console.log }) {
  if (!signing || signing.adhoc || !signing.notarization) return;
  const images = artifacts.filter(artifact => artifact.path.endsWith(".dmg"));
  if (images.length === 0) return;
  const credentials = notarizationCredentials(env);
  if (!credentials) throw new Error("DMG 公证缺少 Apple 公证凭据");
  const auth = credentials.mode === "api-key"
    ? ["--key", env.APPLE_API_KEY_PATH, "--key-id", credentials.keyId, "--issuer", credentials.issuer]
    : ["--apple-id", credentials.appleId, "--password", env.APPLE_PASSWORD, "--team-id", credentials.teamId];
  const redact = value => String(value ?? "").split(env.APPLE_PASSWORD || "\0").join("[REDACTED]");
  // Never print argv: it contains the app-specific password.
  const invoke = args => spawn("/usr/bin/xcrun", args, { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const checked = (args, label) => {
    const result = invoke(args);
    if (result.error || result.status !== 0) {
      throw new Error(`${label}失败：${redact(result.error?.message ?? `${result.stdout ?? ""}\n${result.stderr ?? ""}`)}`);
    }
    return result;
  };
  for (const image of images) {
    if (invoke(["stapler", "validate", image.path]).status === 0) {
      log(`[desktop] DMG 票据已装订：${image.name}`);
      continue;
    }
    log(`[desktop] 提交 DMG 公证并等待 Apple：${image.name}`);
    const result = invoke(["notarytool", "submit", image.path, ...auth, "--wait", "--output-format", "json"]);
    let submission;
    try { submission = JSON.parse(result.stdout); } catch { /* Include tool diagnostics below. */ }
    if (result.error || result.status !== 0 || submission?.status !== "Accepted") {
      const details = submission?.id
        ? invoke(["notarytool", "log", submission.id, ...auth])
        : null;
      throw new Error(
        `DMG 公证失败：${image.name}（${submission?.status ?? "未知状态"}，id=${submission?.id ?? "无"}）\n` +
        redact([result.error?.message, result.stdout, result.stderr, details?.stdout, details?.stderr].filter(Boolean).join("\n"))
      );
    }
    log(`[desktop] DMG 公证 Accepted：${image.name}（${submission.id}），装订票据`);
    checked(["stapler", "staple", image.path], `DMG 装订 ${image.name}`);
    checked(["stapler", "validate", image.path], `DMG 票据核对 ${image.name}`);
  }
}
