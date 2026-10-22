/**
 * 可信应用插件元数据 codec（change: 2026-10-04-add-backend-plugin-extensions，任务 1.1 / design D1）。
 *
 * 应用插件由**构建时可信清单**声明：稳定 extensionId、版本、管理范围、配置 schema identity、
 * 宿主与依赖/能力摘要。管理数据只能引用这些 identity，**绝不**携带模块地址、源码或任意代码
 * 加载入口（spec「配置尝试加载任意代码」）。
 *
 * 本模块是纯数据、无副作用 codec；严格拒绝任何未声明字段，特别拒绝 `module`/`url`/`script`/
 * `source`/`entry` 等代码位置字段进入可信元数据。
 */
import {
  isBoundedId,
  isJsonObject,
  isNonEmptyString,
  isNonNegativeInteger
} from "../validation.js";

/** 管理范围：应用插件当前只由站点统一管理（design D1/D5）。 */
export const APPLICATION_EXTENSION_MANAGEMENT_SCOPES = ["site"] as const;
export type ApplicationExtensionManagementScope = (typeof APPLICATION_EXTENSION_MANAGEMENT_SCOPES)[number];

/**
 * 入口可见的宿主（服务边界；插件只能在声明宿主内扩展）。
 *
 * `backend` 是统一后端进程内的插件宿主 identity
 * （change: 2026-10-06-unify-backend-runtime-with-cordis）；`application`/`task` 为历史
 * identity，只允许由显式数据迁移处理，新插件 MUST NOT 使用。
 */
export const APPLICATION_EXTENSION_HOSTS = ["backend", "application", "task"] as const;
export type ApplicationExtensionHost = (typeof APPLICATION_EXTENSION_HOSTS)[number];

/** 后端宿主注入的 identity；站点插件生产宿主为 application。 */
export type ApplicationExtensionHostIdentity = ApplicationExtensionHost;

/**
 * 配置 schema identity：引用构建时可信 codec，不携带 schema 内容/脚本。
 * `schemaVersion` 让宿主拒绝降级运行不理解的配置版本（design「Migration Plan」第 4 步）。
 */
export type ApplicationExtensionConfigSchemaIdentity = {
  schemaId: string;
  schemaVersion: number;
};

/** 宿主服务依赖（activation 前校验；缺失时不得发布部分能力）。 */
export type ApplicationExtensionHostDependency = {
  id: string;
  required: boolean;
};

/**
 * handler/capability 认证等级下限（宿主不允许插件弱化；design D2）。
 *
 * change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 3.3：删除 `admin`
 * 等级。旧 `auth: admin` 迁为 `authenticated` + 具名 `requiredActions`；核心 MUST NOT
 * 依据角色/管理员等级放行（`roles.includes('admin')` 等一律移除）。
 */
export const APPLICATION_EXTENSION_AUTH_LEVELS = ["public", "authenticated"] as const;
export type ApplicationExtensionAuthLevel = (typeof APPLICATION_EXTENSION_AUTH_LEVELS)[number];

/** 能力/扩展点摘要（纯展示，不含 handler 实现或模块位置）。 */
export type ApplicationExtensionCapabilitySummary = {
  id: string;
  kind: "capability" | "handler" | "background-resource";
  description: string;
  /** handler 的认证等级下限（宿主不允许插件弱化；design D2）。 */
  auth?: ApplicationExtensionAuthLevel;
};

/**
 * 应用插件公开元数据（可信清单 + 状态响应共用）。
 *
 * directory 仅展示部署目录；可执行入口仍由宿主可信清单控制。
 */
export type ApplicationExtensionMetadata = {
  /** 部署侧提供的所在目录，仅用于展示。 */
  directory?: string;
  extensionId: string;
  name: string;
  description: string;
  version: string;
  managementScope: ApplicationExtensionManagementScope;
  host: ApplicationExtensionHost;
  configSchema: ApplicationExtensionConfigSchemaIdentity;
  dependencies: ApplicationExtensionHostDependency[];
  capabilities: ApplicationExtensionCapabilitySummary[];
  /** 可信清单的首次启动默认值；不覆盖已保存的管理员配置。 */
  defaultEnabled?: boolean;
};

/** 编码器禁止字段：可执行入口和秘密载体不允许进入公开元数据。 */
export const FORBIDDEN_PLUGIN_METADATA_KEYS = [
  "module",
  "moduleUrl",
  "url",
  "script",
  "source",
  "entry",
  "entrypoint",
  "file",
  "path",
  "import",
  "require",
  "code",
  "secret",
  "secretValue",
  "token",
  "apiKey"
] as const;

/** 递归检测对象中是否含代码位置/秘密字段（测试与状态脱敏复用）。 */
export function containsForbiddenExtensionKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenExtensionKey(entry));
  if (!isJsonObject(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if ((FORBIDDEN_PLUGIN_METADATA_KEYS as readonly string[]).includes(key)) return true;
    if (containsForbiddenExtensionKey(nested)) return true;
  }
  return false;
}

type DecodeResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

function fail(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}

function readDependencies(raw: unknown): DecodeResult<ApplicationExtensionHostDependency[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return fail("malformed-request", "dependencies 必须是数组");
  const out: ApplicationExtensionHostDependency[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    if (!isJsonObject(entry)) return fail("malformed-request", `dependencies[${index}] 必须是对象`);
    if (!isBoundedId(entry.id)) return fail("malformed-request", `dependencies[${index}].id 非法`);
    if (typeof entry.required !== "boolean") {
      return fail("malformed-request", `dependencies[${index}].required 必须是布尔值`);
    }
    if (seen.has(entry.id)) return fail("malformed-request", `dependencies 含重复 id：${entry.id}`);
    seen.add(entry.id);
    out.push({ id: entry.id, required: entry.required });
  }
  return { ok: true, value: out };
}

const CAPABILITY_KINDS: readonly ApplicationExtensionCapabilitySummary["kind"][] = [
  "capability",
  "handler",
  "background-resource"
];
const AUTH_LEVELS = APPLICATION_EXTENSION_AUTH_LEVELS;

function readCapabilities(raw: unknown): DecodeResult<ApplicationExtensionCapabilitySummary[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return fail("malformed-request", "capabilities 必须是数组");
  const out: ApplicationExtensionCapabilitySummary[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    if (!isJsonObject(entry)) return fail("malformed-request", `capabilities[${index}] 必须是对象`);
    if (!isBoundedId(entry.id)) return fail("malformed-request", `capabilities[${index}].id 非法`);
    if (!isNonEmptyString(entry.kind) || !CAPABILITY_KINDS.includes(entry.kind as never)) {
      return fail("malformed-request", `capabilities[${index}].kind 非法`);
    }
    if (!isNonEmptyString(entry.description)) {
      return fail("malformed-request", `capabilities[${index}].description 非法`);
    }
    if (entry.auth !== undefined && !AUTH_LEVELS.includes(entry.auth as never)) {
      return fail("malformed-request", `capabilities[${index}].auth 非法`);
    }
    if (seen.has(entry.id)) return fail("malformed-request", `capabilities 含重复 id：${entry.id}`);
    seen.add(entry.id);
    out.push({
      id: entry.id,
      kind: entry.kind as ApplicationExtensionCapabilitySummary["kind"],
      description: entry.description,
      ...(entry.auth !== undefined
        ? { auth: entry.auth as NonNullable<ApplicationExtensionCapabilitySummary["auth"]> }
        : {})
    });
  }
  return { ok: true, value: out };
}

/**
 * 严格解码可信插件元数据。
 *
 * 拒绝任何未知字段（它们是走私代码位置/秘密的入口）；schema identity、host、scope 均受限。
 */
export function decodeApplicationExtensionMetadata(body: unknown): DecodeResult<ApplicationExtensionMetadata> {
  if (!isJsonObject(body)) return fail("malformed-request", "插件元数据必须是 JSON 对象");
  if (containsForbiddenExtensionKey(body)) {
    return fail("malformed-request", "插件元数据不得包含代码位置或秘密字段");
  }
  if (!isBoundedId(body.extensionId)) return fail("malformed-request", "extensionId 非法");
  if (!isNonEmptyString(body.name)) return fail("malformed-request", "name 非法");
  if (!isNonEmptyString(body.description)) return fail("malformed-request", "description 非法");
  if (body.directory !== undefined && !isNonEmptyString(body.directory)) return fail("malformed-request", "directory 非法");
  if (!isNonEmptyString(body.version)) return fail("malformed-request", "version 非法");
  if (!APPLICATION_EXTENSION_MANAGEMENT_SCOPES.includes(body.managementScope as never)) {
    return fail("malformed-request", "managementScope 必须是 site");
  }
  if (!APPLICATION_EXTENSION_HOSTS.includes(body.host as never)) {
    return fail("malformed-request", "host 非法");
  }
  if (body.defaultEnabled !== undefined && typeof body.defaultEnabled !== "boolean") {
    return fail("malformed-request", "defaultEnabled 必须是布尔值");
  }
  if (!isJsonObject(body.configSchema)) return fail("malformed-request", "configSchema 非法");
  if (!isBoundedId(body.configSchema.schemaId)) return fail("malformed-request", "configSchema.schemaId 非法");
  if (!isNonNegativeInteger(body.configSchema.schemaVersion)) {
    return fail("malformed-request", "configSchema.schemaVersion 非法");
  }
  const dependencies = readDependencies(body.dependencies);
  if (!dependencies.ok) return dependencies;
  const capabilities = readCapabilities(body.capabilities);
  if (!capabilities.ok) return capabilities;

  return {
    ok: true,
    value: {
      extensionId: body.extensionId,
      name: body.name,
      description: body.description,
      ...(body.directory !== undefined ? { directory: body.directory as string } : {}),
      version: body.version,
      managementScope: "site",
      host: body.host as ApplicationExtensionHost,
      ...(body.defaultEnabled !== undefined ? { defaultEnabled: body.defaultEnabled } : {}),
      configSchema: {
        schemaId: body.configSchema.schemaId,
        schemaVersion: body.configSchema.schemaVersion
      },
      dependencies: dependencies.value,
      capabilities: capabilities.value
    }
  };
}

/** 判定一个值是否为合法可信元数据（不抛错）。 */
export function isApplicationExtensionMetadata(value: unknown): value is ApplicationExtensionMetadata {
  const decoded = decodeApplicationExtensionMetadata(value);
  return decoded.ok && decoded.value.extensionId === (value as ApplicationExtensionMetadata).extensionId;
}
