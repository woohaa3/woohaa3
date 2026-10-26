/**
 * 统一配置：配置项定义与分层解析（纯函数，前后端共用）。
 *
 * 优先级：定义里的默认值 < 配置文件 / 密钥文件 < 旧环境变量。
 *
 * 旧环境变量（`legacyEnv`）**只为过渡期兼容保留**：配置文件才是事实来源，新配置项不要再
 * 声明 `legacyEnv`，迁移完成后整层删除。被环境变量覆盖的项在设置面上显示为锁定，并在启动
 * 时告警提示迁移。
 *
 * 敏感项（`secret`）只能来自密钥文件或旧环境变量，出现在普通配置文件里视为错误。
 *
 * 下面的 `SETTING_DEFINITIONS` 只是宿主自己的配置项；插件的配置项由插件声明 Config schema，
 * 宿主合并成一张定义表后再解析（见 `resolveSettings` 的 `definitions`）。
 */
import { isJsonObject } from "../validation.js";
import type { PluginIcon } from "../plugin-icon.js";
import type { CanvasTaskModelType } from "../task/dto.js";
import { EXTENSION_HOST_SETTING_DEFINITIONS } from "../backend/extension-host.js";
import type { ExtensionInstallationsView, HostSafeModeView, InstalledExtensionView, SettingsExtensionPoints } from "./extension-views.js";

export type {
  ExtensionInstallationsView,
  HostSafeModeView,
  InstalledExtensionView,
  SettingExtensionPointProvider,
  SettingsExtensionPoints
} from "./extension-views.js";

export type SettingReload = "hot" | "restart";

type SettingBase = {
  /** 设置页上的名称。 */
  label: string;
  description: string;
  /** hot：运行中生效；restart：写入后需要重启进程。 */
  reload: SettingReload;
  secret?: boolean;
  /** 过渡期兼容的旧环境变量名；新配置项不要再声明。 */
  legacyEnv?: string;
  /** 设置页上的分组（插件配置项按插件分组）。 */
  group?: string;
  /**
   * 声明这段配置的扩展 id（宿主装载器按插件名填入）。设置面据此把「这个配置段的启停」
   * 放到配置旁边，而不是留在插件清单里。
   */
  ownerExtensionId?: string;
};

export type StringSettingDefinition = SettingBase & { kind: "string"; default?: string };
export type UrlSettingDefinition = SettingBase & { kind: "url"; protocols: readonly string[]; default?: string };
export type IntegerSettingDefinition = SettingBase & { kind: "integer"; default?: number; min?: number; max?: number };
export type BooleanSettingDefinition = SettingBase & { kind: "boolean"; default?: boolean };

export type SettingDefinition =
  | StringSettingDefinition
  | UrlSettingDefinition
  | IntegerSettingDefinition
  | BooleanSettingDefinition;

export type SettingDefinitionTable = Readonly<Record<string, SettingDefinition>>;

export type SettingPrimitive = string | number | boolean;

export const SETTING_DEFINITIONS = {
  "storage.primary": {
    kind: "string",
    default: "local",
    reload: "hot",
    label: "主存储后端",
    description: "媒体与任务读写字节的后端 id（缺省 local）；后端由扩展层插件注册"
  },
  "storage.expose": {
    kind: "string",
    default: "",
    reload: "hot",
    label: "对外存储后端",
    description: "需要外部地址时使用的后端 id；留空表示只用主存储的签名能力"
  },
  "telemetry.local.enabled": {
    kind: "boolean",
    default: true,
    reload: "hot",
    label: "本机遥测记录",
    description: "在本机记录可复盘的客户端事实；关闭后无法事后复盘，数据不出本机"
  },
  "telemetry.local.retentionDays": {
    kind: "integer",
    default: 7,
    min: 1,
    max: 365,
    reload: "hot",
    label: "遥测保留天数",
    description: "超过该天数的本机遥测记录会被清理"
  },
  "telemetry.local.maxRows": {
    kind: "integer",
    default: 200000,
    min: 10000,
    max: 5000000,
    reload: "hot",
    label: "遥测最多保留条数",
    description: "超过该条数的最旧记录会被清理；与保留天数同时生效"
  },
  /**
   * 遥测**总开关**：core 只管"发不发"。
   *
   * 「发到哪、用什么凭据」是出口插件自己的配置（例如服务端接入扩展的部署地址与登录），
   * core 不枚举出口、也不给它配置目的地——否则 core 要知道具体扩展的身份，
   * 那既违反 `extension-purity` 的取向，也会造出一个"配了却没人读"的控件。
   * 当前没有安装任何上报扩展时，开关打开也没有出口可投递（页面的状态面会如实说明）。
   */
  "telemetry.export.enabled": {
    kind: "boolean",
    default: false,
    reload: "hot",
    label: "外部上报遥测",
    description: "总开关：把本机遥测交给已注册的上报出口。目的地与凭据由对应扩展自己配置（如服务端接入）；没有安装这类扩展时此项不产生任何外发"
  },
  /**
   * 扩展激活 / 释放时限（change: 2026-10-21-harden-extension-fault-isolation，D4）。
   * 超时按失败处理（`activation-timeout`），不自动重试；取值有界，防止设成 0 或无穷。
   */
  "extensions.activationTimeoutMs": {
    kind: "integer",
    default: 30000,
    min: 1000,
    max: 600000,
    reload: "hot",
    label: "扩展激活时限（毫秒）",
    description: "单个扩展启动或配置更新后重启的最长等待；超时视为激活失败，不拖住宿主就绪"
  },
  "extensions.disposeTimeoutMs": {
    kind: "integer",
    default: 10000,
    min: 1000,
    max: 600000,
    reload: "hot",
    label: "扩展释放时限（毫秒）",
    description: "停用扩展时等待其释放的最长时间；超时后放弃等待并完成停用，残留资源由下次重启回收"
  },
  /**
   * 受管扩展的签名信任根（change: 2026-10-21-add-extension-marketplace-point，D2）。
   * 只在本机配置文件里维护；来源返回的任何「已验证」标志都不被信任。
   */
  "extensions.marketplace.trustedKeys": {
    kind: "string",
    default: "",
    reload: "hot",
    label: "扩展签名信任根",
    description: "Ed25519 公钥列表，逗号分隔，每项为 <keyId>=<base64 公钥> 或 base64 公钥；签名不在此列表中的扩展包拒绝安装"
  },
  /** D5：只允许 local-file 来源，且仅本机显式开启（开发用）。也可用 WOOHAA3_EXTENSION_ALLOW_UNSIGNED=1。 */
  "extensions.marketplace.allowUnsigned": {
    kind: "boolean",
    default: false,
    reload: "hot",
    label: "允许未签名的本地扩展包",
    description: "仅用于开发：允许从本地文件安装未签名的 .wxt；市场来源的包始终要求签名。未签名扩展与宿主同进程运行，没有隔离"
  },
  ...EXTENSION_HOST_SETTING_DEFINITIONS
} as const satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;

type ValueOfDefinition<D> = D extends { kind: "integer" } ? number : D extends { kind: "boolean" } ? boolean : string;
export type SettingValue<K extends SettingKey> = ValueOfDefinition<(typeof SETTING_DEFINITIONS)[K]>;
/** 宿主自己的键有精确类型；插件声明的键按字符串索引读取。 */
export type SettingsValues = { [K in SettingKey]?: SettingValue<K> } & { [key: string]: SettingPrimitive | undefined };

export type SettingSource = "default" | "file" | "secrets" | "env";
export type SettingsLayer = "file" | "secrets" | "env";

export type SettingsIssue = { key: string; layer: SettingsLayer; message: string };

export type ResolvedSettings = {
  values: SettingsValues;
  sources: Partial<Record<string, SettingSource>>;
  issues: SettingsIssue[];
  /** `unknownKeys: "collect"` 时，定义表里没有的键（插件尚未装载或已移除）。 */
  unknown: string[];
};

export type SettingsLayers = {
  /** 解析后的配置文件内容（嵌套对象，键按 `.` 分段）。 */
  file?: unknown;
  secrets?: unknown;
  env?: Record<string, string | undefined>;
};

export type ResolveSettingsOptions = {
  /** 参与解析的定义表；缺省只有宿主自己的配置项。 */
  definitions?: SettingDefinitionTable;
  /** issue：未知键报错（缺省）；collect：记入 `unknown`，留给之后装载的插件。 */
  unknownKeys?: "issue" | "collect";
};

export const SETTING_KEYS = Object.keys(SETTING_DEFINITIONS) as SettingKey[];

export function settingDefinition(key: SettingKey): SettingDefinition {
  return SETTING_DEFINITIONS[key];
}

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTING_DEFINITIONS, key);
}

export function resolveSettings(layers: SettingsLayers, options: ResolveSettingsOptions = {}): ResolvedSettings {
  const definitions: SettingDefinitionTable = options.definitions ?? SETTING_DEFINITIONS;
  const keys = Object.keys(definitions);
  const known = (key: string) => Object.prototype.hasOwnProperty.call(definitions, key);
  const values: Record<string, SettingPrimitive> = {};
  const sources: Partial<Record<string, SettingSource>> = {};
  const issues: SettingsIssue[] = [];
  const unknown = new Set<string>();

  for (const key of keys) {
    const fallback = definitions[key]!.default;
    if (fallback !== undefined) {
      values[key] = fallback;
      sources[key] = "default";
    }
  }

  const applyFileLayer = (layer: "file" | "secrets", raw: unknown) => {
    if (raw === undefined || raw === null) return;
    if (!isJsonObject(raw)) {
      issues.push({ key: "", layer, message: "顶层必须是映射" });
      return;
    }
    for (const [key, value] of flattenSettings(raw)) {
      if (!known(key)) {
        if (options.unknownKeys === "collect") unknown.add(key);
        else issues.push({ key, layer, message: "未知配置项" });
        continue;
      }
      const definition = definitions[key]!;
      if (layer === "file" && definition.secret) {
        issues.push({ key, layer, message: "敏感项只能写在密钥文件里" });
        continue;
      }
      if (layer === "secrets" && !definition.secret) {
        issues.push({ key, layer, message: "密钥文件只接受敏感项" });
        continue;
      }
      if (value === null || value === "") continue;
      const parsed = parseSettingValue(definition, value);
      if (!parsed.ok) {
        issues.push({ key, layer, message: parsed.message });
        continue;
      }
      values[key] = parsed.value;
      sources[key] = layer;
    }
  };
  applyFileLayer("file", layers.file);
  applyFileLayer("secrets", layers.secrets);

  for (const key of keys) {
    const definition = definitions[key]!;
    if (!definition.legacyEnv) continue;
    const raw = layers.env?.[definition.legacyEnv]?.trim();
    if (raw === undefined || raw === "") continue;
    const parsed = parseSettingValue(definition, raw);
    if (!parsed.ok) {
      issues.push({ key, layer: "env", message: `${definition.legacyEnv}：${parsed.message}` });
      continue;
    }
    values[key] = parsed.value;
    sources[key] = "env";
  }

  return { values: values as SettingsValues, sources, issues, unknown: [...unknown] };
}

/** 当前生效值来自旧环境变量的配置项（启动时据此告警迁移）。 */
export function legacyEnvInUse(
  resolved: ResolvedSettings,
  definitions: SettingDefinitionTable = SETTING_DEFINITIONS
): Array<{ key: string; env: string }> {
  return Object.keys(definitions).flatMap((key) => {
    const env = definitions[key]!.legacyEnv;
    return resolved.sources[key] === "env" && env ? [{ key, env }] : [];
  });
}

/** 两份解析结果之间生效值不同的配置项。 */
export function diffSettings(before: SettingsValues, after: SettingsValues): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => before[key] !== after[key]);
}

/** 返回 Promise 时，写入方（`update`）会等它结束再返回，订阅者据此按新值完成重启。 */
export type SettingsListener = (changed: readonly string[]) => void | Promise<void>;

/** 服务只依赖这个读口；后端实现会在热重载时通知订阅者。 */
export interface SettingsReader {
  get<K extends SettingKey>(key: K): SettingValue<K> | undefined;
  /** `keys` 中任一项的生效值变化时回调；只通知 `reload: "hot"` 的项。 */
  subscribe(keys: readonly string[], listener: SettingsListener): () => void;
}

/** 不会变化的读口（测试、独立入口或尚未接入热重载的宿主）。 */
export function createStaticSettingsReader(values: SettingsValues): SettingsReader {
  return {
    get: (key) => values[key] as never,
    subscribe: () => () => undefined
  };
}

export type SettingDescription = {
  key: string;
  kind: SettingDefinition["kind"];
  label: string;
  description: string;
  /** 设置页上的分组；宿主自己的配置项没有分组。 */
  group?: string;
  /** 声明这段配置的扩展 id；宿主自己的配置项没有归属扩展。 */
  ownerExtensionId?: string;
  /** 仅 url 类：允许的协议。 */
  protocols?: readonly string[];
  reload: SettingReload;
  secret: boolean;
  source: SettingSource | null;
  /** 生效值来自旧环境变量时，设置面不能修改。 */
  lockedBy: string | null;
  /** 敏感项不回显，只给出是否已配置。 */
  value: string | number | boolean | null;
  configured: boolean;
};

export function describeSettings(
  resolved: ResolvedSettings,
  definitions: SettingDefinitionTable = SETTING_DEFINITIONS
): SettingDescription[] {
  return Object.keys(definitions).map((key) => {
    const definition = definitions[key]!;
    const value = resolved.values[key];
    const source = resolved.sources[key] ?? null;
    return {
      key,
      kind: definition.kind,
      label: definition.label,
      description: definition.description,
      ...(definition.group ? { group: definition.group } : {}),
      ...(definition.ownerExtensionId ? { ownerExtensionId: definition.ownerExtensionId } : {}),
      ...(definition.kind === "url" ? { protocols: definition.protocols } : {}),
      reload: definition.reload,
      secret: definition.secret ?? false,
      source,
      lockedBy: source === "env" ? definition.legacyEnv ?? null : null,
      value: definition.secret ? null : value ?? null,
      configured: value !== undefined
    };
  });
}

export function parseSettingValue(
  definition: SettingDefinition,
  raw: unknown
): { ok: true; value: string | number | boolean } | { ok: false; message: string } {
  switch (definition.kind) {
    case "string":
      return typeof raw === "string" ? { ok: true, value: raw } : { ok: false, message: "应为字符串" };
    case "url": {
      if (typeof raw !== "string") return { ok: false, message: "应为 URL 字符串" };
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        return { ok: false, message: `不是合法 URL：${raw}` };
      }
      if (!definition.protocols.includes(parsed.protocol)) {
        return { ok: false, message: `协议必须是 ${definition.protocols.join(" / ")}` };
      }
      return { ok: true, value: raw.replace(/\/+$/, "") };
    }
    case "integer": {
      const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
      if (typeof value !== "number" || !Number.isInteger(value)) return { ok: false, message: "应为整数" };
      if (definition.min !== undefined && value < definition.min) return { ok: false, message: `不能小于 ${definition.min}` };
      if (definition.max !== undefined && value > definition.max) return { ok: false, message: `不能大于 ${definition.max}` };
      return { ok: true, value };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (raw === "true" || raw === "1") return { ok: true, value: true };
      if (raw === "false" || raw === "0") return { ok: true, value: false };
      return { ok: false, message: "应为布尔值" };
    }
  }
}

/**
 * 设置面 HTTP 契约。
 *
 * ```
 * GET /api/settings   读取每项的值、来源与锁定状态（敏感项不回显）
 * PUT /api/settings   写入 `{ values: { key: value | null } }`，`null` 表示删除
 * ```
 *
 * 本地单实例（无身份提供者）访问控制关闭，直接可用；站点部署由认证适配器与站点 action 决定管理员。
 */
export const DEFAULT_SETTINGS_BASE_PATH = "/api/settings";

export type SettingsEntryView = SettingDescription & { pendingRestart: boolean };

/** Provider 类插件的配置段前缀：`providers.<providerId>.…`。 */
export const PROVIDER_SETTING_PREFIX = "providers.";

/** 从配置段前缀取出 Provider id；不是 Provider 段时为 null。 */
export function providerIdFromConfigPrefix(configPrefix: string | undefined): string | null {
  if (!configPrefix?.startsWith(PROVIDER_SETTING_PREFIX)) return null;
  const providerId = configPrefix.slice(PROVIDER_SETTING_PREFIX.length).split(".")[0];
  return providerId ? providerId : null;
}

/**
 * 插件所属层：宿主基础层（base/）/ 宿主核心层（core/）/ 扩展层（web/extensions 与三方插件）。
 *
 * 宿主内部按此分层登记；前端插件面板只显示磁盘扩展目录。
 */
export type SettingPluginLayer = "base" | "core" | "extension";

/**
 * 设置面上的插件条目（宿主随 `GET /api/settings` 返回）。
 *
 * 插件的**配置项**仍以 `settings` 里每项的 `ownerExtensionId` 归属；这里提供插件本身的身份、
 * 分层与启停范围，让设置页不需要从键名前缀猜插件是谁。
 */
export type SettingPluginView = {
  /** 扩展声明的 Provider 输出类型，不等同于当前账号可用模型或已验证权限。 */
  modelTypes?: readonly CanvasTaskModelType[];
  /** 宿主扫描到的插件绝对目录，仅用于展示。 */
  directory?: string;
  id: string;
  label: string;
  description: string;
  layer: SettingPluginLayer;
  /** 插件声明的图标：语义图形名或 `/plugin-icons/` 下的品牌图形；未声明时设置页用通用插件图标兜底。 */
  icon?: PluginIcon;
  /** 声明配置段的键前缀（`providers.ark`、`storage.local`）；没有可配置项的插件缺省。 */
  configPrefix?: string;
  /** 该插件声明的配置项数。 */
  settingCount: number;
  /** 站点插件：可由站点插件服务启停（其余插件随宿主装载）。 */
  siteManaged: boolean;
  /** Provider 类插件：配置段在 `providers.<providerId>` 下。 */
  provider: boolean;
  /**
   * 插件声明的模型目录刷新入口（`HostExtensionPlugin.modelRefresh`）；缺省表示该插件没有这一节。
   * 宿主只透传，不在管理面硬编码具体 Provider。
   */
  modelRefresh?: { path: string; hint: string };
};



export type SettingsSnapshot = {
  /** 安全模式；缺省或 null 表示正常启动。 */
  safeMode?: HostSafeModeView | null;
  installedExtensions?: InstalledExtensionView[];
  /** 受管安装概览；宿主未装配 Extension Manager 时缺省。 */
  extensionInstallations?: ExtensionInstallationsView;
  settings: SettingsEntryView[];
  /** 宿主插件树（基础层 / 核心层 / 扩展层）；「插件配置」按它列出每个插件。 */
  plugins: SettingPluginView[];
  /** 宿主扩展点当前可用的提供者（例如已注册的存储后端）；缺省表示宿主没有暴露注册表。 */
  extensionPoints?: SettingsExtensionPoints;
  files: { config: string; secrets: string };
};

export type SettingsWriteValue = string | number | boolean | null;
export type SettingsWrite = { values: Record<string, SettingsWriteValue> };

export type SettingsWriteError = { code: "config-invalid"; message: string; issues: SettingsIssue[] };

export function decodeSettingsWrite(body: unknown): { ok: true; value: SettingsWrite } | { ok: false; message: string } {
  if (!isJsonObject(body) || !isJsonObject(body.values)) return { ok: false, message: "请求体必须是 { values: {...} }" };
  const values: Record<string, SettingsWriteValue> = {};
  for (const [key, value] of Object.entries(body.values)) {
    if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return { ok: false, message: `${key} 的值类型不受支持` };
    }
    values[key] = value;
  }
  return { ok: true, value: { values } };
}

/** 嵌套映射 → `[a.b.c, leaf]`；数组视为叶子值（由类型校验拒绝）。 */
function flattenSettings(raw: Record<string, unknown>, prefix = ""): Array<[string, unknown]> {
  return Object.entries(raw).flatMap(([segment, value]) => {
    const key = prefix ? `${prefix}.${segment}` : segment;
    return isJsonObject(value) ? flattenSettings(value, key) : [[key, value] as [string, unknown]];
  });
}