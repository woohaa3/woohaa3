/**
 * macOS 代码签名与公证的构建期辅助。
 *
 * 边界：
 * - 只管「哪些文件要签、身份是否可用、公证凭据是否齐备、构建后怎么验」，不持有任何凭据。
 * - 凭据只从 env 读，且**不**回显；本模块不做日志脱敏之外的持久化。
 * - 纯函数部分（Mach-O 识别、凭据解析、身份去重检查）可单测，不触碰钥匙串。
 */
import fs from "node:fs";
import path from "node:path";

/** Mach-O 文件头魔数：32/64 位、大小端，以及 universal（fat）两种字节序。 */
const MACHO_MAGICS = new Set([0xcffaedfe, 0xfeedfacf, 0xfeedface, 0xcefaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

/** ad-hoc 签名的伪身份；与 Tauri 的 `signingIdentity` 语义一致。 */
export const ADHOC_IDENTITY = "-";

/** 40 位十六进制 SHA-1 指纹形式；用它可以绕开同名证书的歧义。 */
const FINGERPRINT = /^[0-9a-f]{40}$/i;

/** 只读文件头 4 字节；资源树里有几万个文件，整文件读会白白搬 GB 级数据。 */
function readHeader(file) {
  const fd = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(4);
    const read = fs.readSync(fd, header, 0, 4, 0);
    return read === 4 ? header : null;
  } finally {
    fs.closeSync(fd);
  }
}

/** 读前 4 字节判断是否是 Mach-O。读不到（目录、权限、空文件）一律视为否。 */
export function isMachO(file, header = readHeader) {
  let buffer;
  try {
    buffer = header(file);
  } catch {
    return false;
  }
  if (!buffer || buffer.length < 4) return false;
  return MACHO_MAGICS.has(buffer.readUInt32BE(0));
}

/**
 * 递归列出 root 下所有 Mach-O 普通文件。
 *
 * 资源树里有大量指向树内的相对符号链接（pnpm 的依赖图），所以既要跟进去，又要按 realpath
 * 去重避免环。`assertPortableTree` 已保证链接不指向树外，这里仍按树内判断一次。
 */
export function findMachOFiles(root, { header = readHeader, realpath = fs.realpathSync } = {}) {
  const resolvedRoot = realpath(root);
  const visited = new Set();
  const found = [];

  const walk = directory => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      const full = path.join(directory, entry.name);
      let real;
      try {
        real = realpath(full);
      } catch {
        continue; // 悬空链接：不是可签文件
      }
      if (real !== resolvedRoot && !real.startsWith(resolvedRoot + path.sep)) continue;
      let stat;
      try {
        stat = fs.statSync(real);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (visited.has(real)) continue;
        visited.add(real);
        walk(real);
      } else if (stat.isFile() && isMachO(real, header)) {
        found.push(full);
      }
    }
  };

  walk(resolvedRoot);
  return found;
}

/**
 * 从 `security find-identity` 的输出里取 (指纹, 名字) 对。
 *
 * 形如：`  1) ABCDEF... "Developer ID Application: X (TEAM)"`
 */
export function parseCodeSigningIdentities(output) {
  const identities = [];
  for (const line of String(output ?? "").split("\n")) {
    const match = /^\s*\d+\)\s+([0-9a-f]{40})\s+"(.+)"\s*$/i.exec(line);
    if (match) identities.push({ fingerprint: match[1].toLowerCase(), name: match[2] });
  }
  return identities;
}

/**
 * 身份是否唯一可用。
 *
 * 同一账号重新签发会得到**同名**的多张 Developer ID 证书（本项目实际遇到过三张），
 * 此时 `codesign --sign "<名字>"` 直接报 ambiguous。用 40 位指纹签则始终无歧义。
 * 非指纹形式命中多张时提前失败，而不是等到 tauri 打包最后一步。
 */
export function assertUnambiguousIdentity(identity, identities) {
  const wanted = String(identity ?? "").trim();
  if (!wanted || wanted === ADHOC_IDENTITY) return { identity: null, adhoc: true };
  if (FINGERPRINT.test(wanted)) {
    const fingerprint = wanted.toLowerCase();
    const matched = identities.find(entry => entry.fingerprint === fingerprint);
    if (!matched) throw new Error(`找不到签名身份 ${wanted}；先运行 security find-identity -v -p codesigning 确认证书已装入登录钥匙串`);
    return { identity: wanted, adhoc: false, name: matched.name, fingerprint };
  }
  const matched = identities.filter(entry => entry.name === wanted);
  if (matched.length > 1) {
    throw new Error(
      `签名身份 "${wanted}" 匹配到 ${matched.length} 张证书（${matched.map(entry => entry.fingerprint).join(" / ")}）；` +
        "改用 40 位 SHA-1 指纹，或在钥匙串里删掉过期的那几张。"
    );
  }
  if (matched.length === 0) throw new Error(`找不到签名身份 "${wanted}"；先运行 security find-identity -v -p codesigning 确认`);
  return { identity: wanted, adhoc: false, name: wanted, fingerprint: matched[0].fingerprint };
}

const trimmed = value => String(value ?? "").trim();

/**
 * 解析公证凭据。
 *
 * Tauri 用这两组环境变量驱动 `notarytool submit --wait` + `stapler staple`：
 * - App Store Connect API Key：`APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_PATH`
 * - Apple ID + App 专用密码：`APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`
 *
 * 两组混用直接失败（notarytool 也拒绝）。都没给返回 null，表示本次不公证。
 * 返回值**不含**密码，可安全进日志。
 */
export function notarizationCredentials(env = process.env) {
  const apiKey = trimmed(env.APPLE_API_KEY);
  const apiIssuer = trimmed(env.APPLE_API_ISSUER);
  const apiKeyPath = trimmed(env.APPLE_API_KEY_PATH);
  const appleId = trimmed(env.APPLE_ID);
  const appPassword = trimmed(env.APPLE_PASSWORD);
  const teamId = trimmed(env.APPLE_TEAM_ID);

  const apiGiven = [apiKey, apiIssuer, apiKeyPath].filter(Boolean).length > 0;
  const idGiven = [appleId, appPassword, teamId].filter(Boolean).length > 0;

  if (apiGiven && idGiven) {
    throw new Error("公证凭据只能二选一：要么 APPLE_API_KEY/APPLE_API_ISSUER/APPLE_API_KEY_PATH，要么 APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID");
  }
  if (apiGiven) {
    const missing = [["APPLE_API_KEY", apiKey], ["APPLE_API_ISSUER", apiIssuer], ["APPLE_API_KEY_PATH", apiKeyPath]]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) throw new Error(`App Store Connect API Key 公证缺少：${missing.join(" / ")}`);
    if (!fs.existsSync(apiKeyPath)) throw new Error(`APPLE_API_KEY_PATH 指向的文件不存在：${apiKeyPath}`);
    return { mode: "api-key", keyId: apiKey, issuer: apiIssuer };
  }
  if (idGiven) {
    const missing = [["APPLE_ID", appleId], ["APPLE_PASSWORD", appPassword], ["APPLE_TEAM_ID", teamId]]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) throw new Error(`Apple ID 公证缺少：${missing.join(" / ")}；App 专用密码需要同时给 APPLE_TEAM_ID`);
    return { mode: "apple-id", appleId, teamId };
  }
  return null;
}

/**
 * 决定本次 macOS 构建的签名状态。
 *
 * `identity` 为 `-` 或缺省时是 ad-hoc：不公证（Developer ID 之外的身份也公证不了）。
 */
export function resolveMacSigning({ identity, notarization = null, identities = [] } = {}) {
  const resolved = assertUnambiguousIdentity(identity, identities);
  if (resolved.adhoc) {
    return { adhoc: true, identity: null, requestedIdentity: ADHOC_IDENTITY, notarization: null, nestedBinaries: 0 };
  }
  return { adhoc: false, identity: resolved.identity, name: resolved.name, fingerprint: resolved.fingerprint, notarization, nestedBinaries: 0 };
}

/** 构建日志用的一行摘要；不含任何凭据。 */
export function describeMacSigning(signing) {
  if (!signing) return "[desktop] macOS 签名：跳过（非 darwin）";
  if (signing.adhoc) return "[desktop] macOS 签名：ad-hoc（APPLE_SIGNING_IDENTITY 未设置或为 -），不做公证";
  const notary = signing.notarization ? `公证=${signing.notarization.mode}` : "公证=关闭";
  return `[desktop] macOS 签名：${signing.name} (${signing.fingerprint})，${notary}`;
}

/** 公证凭据的缺失说明；用于把「为什么没公证」写进 manifest。 */
export function notarizationGap({ adhoc, notarization }) {
  if (adhoc) return "ad-hoc 签名不做公证；需要 Developer ID 签名 + 公证才能让普通用户双击打开。";
  if (!notarization) return "缺少 App Store Connect API Key 或 Apple ID 凭据，Gatekeeper 仍会拦截首次打开。";
  return null;
}
