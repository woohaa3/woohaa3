/**
 * 构建期配置画像（build profile）的加载与解析。
 *
 * 设计见父仓 docs/design/build-profile.md。三条不变量：
 * 1. 值只有一份：私有仓 build-profile.json（或本机 build-profile.local.json）。
 * 2. env 只在**本模块**作为「已解析值的覆盖」进入，下游不再各自读 env、不再持有私有默认值。
 * 3. 严格校验：未知字段、密钥形态、非法 URL、公钥与 keyId 不匹配一律失败。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUILD_PROFILE_SCHEMA_VERSION = 1;

const PROFILE_FILE = "build-profile.json";
const LOCAL_PROFILE_FILE = "build-profile.local.json";
const ALLOWED_ROOT_FIELDS = new Set([
  "$schema", "schemaVersion", "profileId", "cdn", "desktop", "dev", "extensionTrust", "extensions", "frontendBuild", "settings"
]);
const SECRET_KEY = /secret|token|password|private_?key|api_?key/i;
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const HTTPS_URL = /^https:\/\/[^/@\s]+(\/[^\s]*)?$/;
const DEV_URL = /^https?:\/\/[^/@\s]+(\/[^\s]*)?$/;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 拼接基址与相对路径，保证恰好一个斜杠。 */
export function joinUrl(base, relative) {
  return String(base).replace(/\/+$/, "") + "/" + String(relative).replace(/^\/+/, "");
}

/** Tauri updater 的平台键；未知平台返回 null。 */
export function updaterPlatformKey({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === "darwin") return arch === "arm64" ? "darwin-aarch64" : "darwin-x86_64";
  if (platform === "win32") return "windows-x86_64";
  if (platform === "linux") return "linux-x86_64";
  return null;
}

function pushSecretErrors(value, pointer, push) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => pushSecretErrors(entry, pointer + "[" + index + "]", push));
    return;
  }
  if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const at = pointer + "." + key;
      if (SECRET_KEY.test(key)) push(at, "profile 不得承载密钥（命中密钥字段名）");
      pushSecretErrors(entry, at, push);
    }
    return;
  }
  if (typeof value === "string" && PEM_PRIVATE_KEY.test(value)) {
    push(pointer, "profile 不得承载私钥（出现 PEM 私钥头）");
  }
}

/** 校验并归一化一份 profile；返回 { ok, profile } 或 { ok:false, errors }。 */
export function decodeBuildProfile(raw) {
  const errors = [];
  const push = (pointer, message) => errors.push({ path: pointer, message });

  if (!isObject(raw)) {
    push("$", "必须是 JSON 对象");
    return { ok: false, errors };
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_ROOT_FIELDS.has(key)) push("$." + key, "未知字段（严格模式，防止拼写错误被静默忽略）");
  }
  if (raw.schemaVersion !== BUILD_PROFILE_SCHEMA_VERSION) {
    push("$.schemaVersion", "schemaVersion 必须是 " + BUILD_PROFILE_SCHEMA_VERSION);
  }
  if (typeof raw.profileId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(raw.profileId)) {
    push("$.profileId", "必须匹配 ^[a-z0-9][a-z0-9._-]{0,63}$");
  }
  pushSecretErrors(raw, "$", push);

  const cdn = raw.cdn;
  if (cdn !== undefined) {
    if (!isObject(cdn)) push("$.cdn", "必须是对象");
    else {
      for (const key of Object.keys(cdn)) {
        if (!["baseUrl", "runtimePath", "updatePath"].includes(key)) push("$.cdn." + key, "未知字段");
      }
      if (typeof cdn.baseUrl !== "string" || !/^https:\/\/[^/@\s]+\/([^\s]*\/)?$/.test(cdn.baseUrl)) {
        push("$.cdn.baseUrl", "必须是 https URL 且以 / 结尾");
      }
      if (typeof cdn.runtimePath !== "string" || !/^[^/][^\s]*\/$/.test(cdn.runtimePath)) {
        push("$.cdn.runtimePath", "必须是相对路径且以 / 结尾");
      }
      if (typeof cdn.updatePath !== "string" || !/^[^/][^\s]*\{platformKey\}[^\s]*$/.test(cdn.updatePath)) {
        push("$.cdn.updatePath", "必须是相对路径且包含 {platformKey}");
      }
    }
  }

  const desktop = raw.desktop;
  if (desktop !== undefined) {
    if (!isObject(desktop)) push("$.desktop", "必须是对象");
    else {
      for (const key of Object.keys(desktop)) {
        if (!["update", "allowUnconfiguredUpdate"].includes(key)) push("$.desktop." + key, "未知字段");
      }
      if (desktop.allowUnconfiguredUpdate !== undefined && typeof desktop.allowUnconfiguredUpdate !== "boolean") {
        push("$.desktop.allowUnconfiguredUpdate", "必须是布尔值");
      }
      const update = desktop.update;
      if (update !== undefined) {
        if (!isObject(update)) push("$.desktop.update", "必须是对象");
        else {
          for (const key of Object.keys(update)) {
            if (key !== "publicKeys") push("$.desktop.update." + key, "未知字段");
          }
          const keys = update.publicKeys;
          if (!Array.isArray(keys) || keys.length === 0) push("$.desktop.update.publicKeys", "至少需要一个公钥");
          else keys.forEach((key, index) => {
            if (typeof key !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(key) || key.length < 16) {
              push("$.desktop.update.publicKeys[" + index + "]", "必须是 base64 字符串");
            }
          });
        }
      }
    }
  }

  const dev = raw.dev;
  if (dev !== undefined) {
    if (!isObject(dev)) push("$.dev", "必须是对象");
    else {
      for (const key of Object.keys(dev)) {
        if (key !== "remoteServerUrl") push("$.dev." + key, "未知字段");
      }
      if (dev.remoteServerUrl !== undefined && (typeof dev.remoteServerUrl !== "string" || !DEV_URL.test(dev.remoteServerUrl))) {
        push("$.dev.remoteServerUrl", "必须是 http(s) URL");
      }
    }
  }

  const trust = raw.extensionTrust;
  if (trust !== undefined) {
    if (!isObject(trust)) push("$.extensionTrust", "必须是对象");
    else {
      for (const key of Object.keys(trust)) {
        if (key !== "officialKeys") push("$.extensionTrust." + key, "未知字段");
      }
      const keys = trust.officialKeys;
      if (!Array.isArray(keys) || keys.length === 0) push("$.extensionTrust.officialKeys", "至少需要一个公钥");
      else keys.forEach((entry, index) => {
        const at = "$.extensionTrust.officialKeys[" + index + "]";
        if (!isObject(entry)) { push(at, "必须是对象"); return; }
        for (const key of Object.keys(entry)) {
          if (!["keyId", "publicKey"].includes(key)) push(at + "." + key, "未知字段");
        }
        if (typeof entry.keyId !== "string" || !/^[0-9a-f]{16}$/.test(entry.keyId)) push(at + ".keyId", "必须是 16 位小写 hex");
        if (typeof entry.publicKey !== "string" || !/^MCowBQYDK2Vw[A-Za-z0-9+/]*={0,2}$/.test(entry.publicKey)) {
          push(at + ".publicKey", "必须是 Ed25519 SPKI DER 的 base64");
          return;
        }
        const derived = createHash("sha256").update(Buffer.from(entry.publicKey, "base64")).digest("hex").slice(0, 16);
        if (entry.keyId !== derived) push(at + ".keyId", "keyId 必须等于 sha256(SPKI DER) 前 16 位（实际 " + derived + "）");
      });
    }
  }

  const extensions = raw.extensions;
  if (extensions !== undefined) {
    if (!isObject(extensions)) push("$.extensions", "必须是对象");
    else {
      for (const key of Object.keys(extensions)) {
        if (!["defaultEnabled", "siteDefaultEnabled"].includes(key)) push("$.extensions." + key, "未知字段");
      }
      for (const field of ["defaultEnabled", "siteDefaultEnabled"]) {
        const defaults = extensions[field];
        if (defaults === undefined) continue;
        if (!isObject(defaults)) {
          push("$.extensions." + field, "必须是对象");
          continue;
        }
        for (const [extensionId, enabled] of Object.entries(defaults)) {
          const at = "$.extensions." + field + "." + extensionId;
          if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(extensionId)) push(at, "extensionId 必须匹配 ^[a-z0-9][a-z0-9._-]{0,63}$");
          if (typeof enabled !== "boolean") push(at, "必须是布尔值");
        }
      }
    }
  }

  const frontendBuild = raw.frontendBuild;
  if (frontendBuild !== undefined) {
    if (!isObject(frontendBuild)) push("$.frontendBuild", "必须是对象");
    else {
      for (const key of Object.keys(frontendBuild)) {
        if (!["version", "commit"].includes(key)) push("$.frontendBuild." + key, "未知字段");
      }
      for (const key of ["version", "commit"]) {
        const value = frontendBuild[key];
        if (value !== undefined && (typeof value !== "string" || !/^[A-Za-z0-9._+/-]*$/.test(value))) {
          push("$.frontendBuild." + key, "只允许版本字符集");
        }
      }
    }
  }

  // 设置项默认值：只放「部署想改的默认」，真正的值仍以用户配置文件为准。
  const settings = raw.settings;
  if (settings !== undefined) {
    if (!isObject(settings)) push("$.settings", "必须是对象");
    else {
      for (const [key, value] of Object.entries(settings)) {
        const at = "$.settings." + key;
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) push(at, "键名只允许字母数字与 ._-");
        if (SECRET_KEY.test(key)) push(at, "profile 不得承载密钥（命中密钥字段名）");
        if (!["string", "number", "boolean"].includes(typeof value)) push(at, "只允许 string / number / boolean");
      }
    }
  }

  return errors.length === 0 ? { ok: true, profile: raw } : { ok: false, errors };
}

/** 解析根目录：repoRoot 是私有仓根（client 的父目录），clientRoot 是公开仓根。 */
export function resolveProfileRoots({ repoRoot, clientRoot } = {}) {
  const resolvedClient = clientRoot ? path.resolve(clientRoot) : path.resolve(SCRIPT_DIR, "../..");
  return { clientRoot: resolvedClient, repoRoot: repoRoot ? path.resolve(repoRoot) : path.dirname(resolvedClient) };
}

/** 解析 profile 文件路径；env 指定的路径必须存在。 */
export function resolveProfilePath({ repoRoot, clientRoot, env = {} } = {}) {
  const roots = resolveProfileRoots({ repoRoot, clientRoot });
  const explicit = (env.WOOHAA3_BUILD_PROFILE ?? "").trim();
  if (explicit) {
    const candidate = path.isAbsolute(explicit) ? explicit : path.resolve(roots.repoRoot, explicit);
    return { path: candidate, source: "env", explicit: true, exists: existsSync(candidate), roots };
  }
  const candidates = [
    { file: path.join(roots.repoRoot, LOCAL_PROFILE_FILE), source: "local" },
    { file: path.join(roots.repoRoot, PROFILE_FILE), source: "committed" },
    { file: path.join(roots.clientRoot, PROFILE_FILE), source: "client" }
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate.file)) return { path: candidate.file, file: candidate.file, source: candidate.source, explicit: false, exists: true, roots };
  }
  return { path: null, source: null, explicit: false, exists: false, roots };
}

/**
 * 加载 profile 并解析出下游要用的值。
 *
 * env 只在这里作为**覆盖**进入（见 docs 第 6 节），下游不得再读这些变量。
 */
export function loadBuildProfile({ repoRoot, clientRoot, env = {} } = {}) {
  const located = resolveProfilePath({ repoRoot, clientRoot, env });
  const overrides = [];

  let profile;
  if (!located.path) {
    profile = { schemaVersion: BUILD_PROFILE_SCHEMA_VERSION, profileId: "empty" };
  } else {
    if (!located.exists) {
      return { ok: false, source: located.source, overrides, errors: [{ path: "$", message: "profile 文件不存在：" + located.path }] };
    }
    let raw;
    try {
      raw = JSON.parse(readFileSync(located.path, "utf8"));
    } catch (error) {
      return { ok: false, source: located.source, overrides, errors: [{ path: "$", message: "profile 不是合法 JSON：" + error.message }] };
    }
    const decoded = decodeBuildProfile(raw);
    if (!decoded.ok) return { ok: false, source: located.source, overrides, errors: decoded.errors };
    profile = decoded.profile;
  }

  const resolved = {
    runtimeCdnUrl: profile.cdn ? joinUrl(profile.cdn.baseUrl, profile.cdn.runtimePath) : "",
    updateEndpointTemplate: profile.cdn ? joinUrl(profile.cdn.baseUrl, profile.cdn.updatePath) : "",
    updatePublicKeys: profile.desktop?.update?.publicKeys ? [...profile.desktop.update.publicKeys] : [],
    allowUnconfiguredUpdate: profile.desktop?.allowUnconfiguredUpdate === true,
    officialKeys: profile.extensionTrust?.officialKeys ? profile.extensionTrust.officialKeys.map(entry => ({ ...entry })) : [],
    cdnBaseUrl: profile.cdn?.baseUrl ?? "",
    extensionDefaults: profile.extensions?.defaultEnabled ? { ...profile.extensions.defaultEnabled } : {},
    siteExtensionDefaults: profile.extensions?.siteDefaultEnabled ? { ...profile.extensions.siteDefaultEnabled } : {},
    devRemoteServerUrl: profile.dev?.remoteServerUrl ?? "",
    frontendBuild: profile.frontendBuild ? { ...profile.frontendBuild } : null,
    settingDefaults: profile.settings ? { ...profile.settings } : {}
  };

  const applyEnv = (name, field, assign) => {
    const value = (env[name] ?? "").trim();
    if (!value) return;
    assign(value);
    overrides.push({ field, env: name });
  };
  applyEnv("WOOHAA_RUNTIME_CDN_BASE_URL", "runtimeCdnUrl", value => { resolved.runtimeCdnUrl = value; });
  applyEnv("WOOHAA_DESKTOP_UPDATE_ENDPOINT", "updateEndpointTemplate", value => { resolved.updateEndpointTemplate = value; });
  applyEnv("WOOHAA3_REMOTE_SERVER_URL", "devRemoteServerUrl", value => { resolved.devRemoteServerUrl = value; });
  applyEnv("WOOHAA_DESKTOP_UPDATE_PUBLIC_KEY", "updatePublicKeys", value => { resolved.updatePublicKeys = [value]; });

  return { ok: true, profile, source: located.source, path: located.path, roots: located.roots, resolved, overrides };
}

/** 把 {platformKey} 模板展开成具体 feed 地址；没有模板时返回空串。 */
export function updateEndpointFor(resolved, platformKey) {
  const template = resolved.updateEndpointTemplate ?? "";
  if (!template) return "";
  if (!platformKey) throw new Error("无法确定 updater 平台键（模板：" + template + "）");
  return template.replaceAll("{platformKey}", platformKey);
}

/**
 * 官方扩展信任根常量。
 *
 * 有 profile 值时以 define 注入 backend；没有时源码里的内置常量仍是缺省，行为不变。
 */
export function officialTrustDefines(resolved) {
  if (!resolved.officialKeys || resolved.officialKeys.length === 0) return null;
  return { __WOOHAA3_OFFICIAL_TRUST_KEYS__: resolved.officialKeys.map(({ keyId, publicKey }) => ({ keyId, publicKey })) };
}

/** 所有构建期常量合并成一个对象，交给 build-package 的 esbuild define。 */
export function settingDefaultDefines(resolved) {
  const values = resolved.settingDefaults ?? {};
  return Object.keys(values).length > 0 ? { __WOOHAA3_SETTING_DEFAULTS__: { ...values } } : null;
}

export function buildDefines(resolved) {
  const merged = {
    ...(officialTrustDefines(resolved) ?? {}),
    ...(settingDefaultDefines(resolved) ?? {})
  };
  return Object.keys(merged).length > 0 ? merged : null;
}

/** 构建日志用的一行摘要（只打印来源与覆盖项，不打印值）。 */
export function describeBuildProfile(loaded) {
  if (!loaded.ok) return "[build-profile] 校验失败（" + loaded.errors.length + " 处）";
  const parts = ["id=" + loaded.profile.profileId, "source=" + (loaded.source ?? "none")];
  if (loaded.overrides.length > 0) parts.push("env-overrides=" + loaded.overrides.map(entry => entry.field).join(","));
  return "[build-profile] " + parts.join(" ");
}
