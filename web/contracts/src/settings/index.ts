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
import { DEFAULT_GITHUB_MARKETPLACE_REPOS } from "../backend/marketplace.js";
import { isJsonObject } from "../validation.js";
import type { PluginIcon } from "../plugin-icon.js";
import type { CanvasTaskModelType } from "../task/dto.js";
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
  "exposer.order": {
    kind: "string",
    default: "",
    reload: "hot",
    label: "临时图床优先顺序",
    description: "按优先级排列的图床来源 ID，以逗号分隔；未指定的来源按扩展默认顺序追加"
  },
  "exposer.primary": {
    kind: "string",
    default: "auto",
    reload: "hot",
    label: "临时图床",
    description: "自动选择可用的临时图床提供商，也可指定来源"
  },
  "storage.expose": {
    kind: "string",
    default: "",
    reload: "hot",
    label: "临时图床（旧键）",
    description: "已由 exposer.primary 取代；仅在 exposer.primary 未显式配置时作为兼容值读取"
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
    description: "Ed25519 公钥列表，逗号分隔，每项为 <keyId>=<base64 公钥> 或 base64 公钥。命中的扩展显示为已验证；不在列表中的包要在安装时确认风险后才能安装"
  },
  /**
   * GitHub Release 市场来源（核心自带，与 local-file 同级）。
   *
   * 缺省开启并指向官方市场仓库：插件面板开箱就能搜索安装。关闭后来源不可用、不发起任何请求。
   * 未配令牌时走 github.com 网页端点（不消耗 REST API 60 次/小时的匿名限额）；配了令牌或
   * 换过 API 基址才走 REST（私有仓库 / GitHub Enterprise Server）。
   */
  "extensions.marketplace.github.enabled": {
    kind: "boolean",
    default: true,
    reload: "hot",
    label: "启用 GitHub 扩展来源",
    description: "允许从 GitHub Release 安装 .wxt 扩展包。开启后本机会访问 GitHub；关闭时不发起任何请求"
  },
  /** GitHub 仓库列表：逗号分隔的 `owner/repo`；每个仓库的 Release 资产都是候选包。 */
  "extensions.marketplace.github.repos": {
    kind: "string",
    default: DEFAULT_GITHUB_MARKETPLACE_REPOS,
    reload: "hot",
    label: "GitHub 扩展仓库列表",
    description: "逗号分隔的 owner/repo 列表，缺省为官方市场仓库。安装候选来自这些仓库 Release 的 .wxt 资产，文件名须为 <extensionId>-<version>.wxt"
  },
  /** GitHub REST API 地址；企业自建 GitHub（GitHub Enterprise Server）可改为 https://<host>/api/v3。 */
  "extensions.marketplace.github.apiBase": {
    kind: "url",
    protocols: ["https:", "http:"],
    default: "https://api.github.com",
    reload: "hot",
    label: "GitHub API 地址",
    description: "GitHub REST API 基址，缺省 https://api.github.com；GitHub Enterprise Server 改为 https://<host>/api/v3"
  },
  /** GitHub 访问令牌：私有仓库或强制走 REST API 用；只应写在密钥文件，缺省匿名走网页端点。 */
  "extensions.marketplace.github.token": {
    kind: "string",
    default: "",
    reload: "hot",
    secret: true,
    label: "GitHub 访问令牌",
    description: "访问私有仓库用；填写后改走 REST API（私有仓库只能这样）。留空时匿名读 github.com 网页端点，不占 API 限额。请写在密钥文件（woohaa.secrets.yml），不要写进普通配置文件"
  }
} as const satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;

type ValueOfDefinition<D> = D extends { kind: "integer" } ? number : D extends { kind: "boolean" } ? boolean : string;
export type SettingValue<K extends SettingKey> = ValueOfDefinition<(typeof SETTING_DEFINITIONS)[K]>;
/** 宿主自己的键有精确类型；插件声明的键按字符串索引读取。 */
export type SettingsValues = { [K in SettingKey]?: SettingValue<K> } & { [key: string]: SettingPrimitive | undefined };

/**
 * 扩展启停的配置段前缀：`extensions.<extensionId>.enabled`。
 *
 * **所有**扩展共用这一段（不区分 site / host / browser-local）：启停是配置的一部分，
 * 与 provider 参数同层同格式，由框架统一读取、校验与热重载。
 *
 * 这段是**动态键**（按扩展目录发现产生），不进静态定义表；解析时跳过，由
 * `SettingsService.extensionToggles()` 单独读取。
 */
export const EXTENSION_CONFIG_PREFIX = "extensions";

/**
 * 是否为扩展启停键：`extensions.<id>.enabled`（恰好三段，且最后一段是 `enabled`）。
 *
 * 只认这一种形态，避免把插件自己登记的 `extensions.<plugin>.<field>` 段误判为动态键。
 */
export function isExtensionToggleKey(key: string): boolean {
  const parts = key.split(".");
  return parts.length === 3 && parts[0] === EXTENSION_CONFIG_PREFIX && parts[2] === "enabled";
}

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

/** 已从设置面移除、旧配置文件里可能还在的键。读到时静默忽略，不报未知配置项。 */
const RETIRED_SETTING_KEYS = new Set(["extensions.marketplace.allowUnsigned"]);

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
      // 扩展启停键 `extensions.<id>.enabled` 是**动态键**（按扩展目录发现产生），由
      // `SettingsService.extensionToggles()` 单独读取，不进定义表也不报未知。
      // 只跳过这一种形态：`extensions.marketplace.*` 这类插件自己登记的段仍按定义表校验。
      if (isExtensionToggleKey(key)) continue;
      if (!known(key)) {
        if (RETIRED_SETTING_KEYS.has(key)) continue;
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
  /** 扩展声明的服务商网站。 */
  website?: string;
  /** 添加提供商列表的展示顺序；未声明时排在推荐入口之后。 */
  setupOrder?: number;
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
   * 插件声明的模型目录刷新入口（`ExtensionPlugin.modelRefresh`）；缺省表示该插件没有这一节。
   * 宿主只透传，不在管理面硬编码具体 Provider。
   */
  modelRefresh?: { path: string; hint: string };
  /**
   * 非站点扩展层插件最近一次启动失败的原因（Provider / 存储后端）。
   *
   * 这类插件没有 `actualState`：不进站点控制面，`apply` 抛错时宿主只记日志。带上这一项，
   * 设置页才能在「还没有模型」旁边说清「插件没启动起来」以及为什么，而不是让人去翻日志。
   * 站点插件的失败原因走 `plugins` 的 `actualState` / `diagnostics`，不用这个字段。
   */
  activationFailure?: string;
};



/**
 * 扩展启停状态：配置文件 `extensions.<extensionId>.enabled` 的投影。
 *
 * 事实来源是宿主配置文件，与扩展自己的参数配置同层同格式；消费方只投影它，不自带持久化。
 * 未出现的 ID 表示使用默认值：manifest 的 `defaultEnabled`；**未声明时按停用处理**。
 *
 * 缺省为**关**是有意的：站点/后端扩展（含市场安装的扩展）不会因为漏写 `defaultEnabled`
 * 就自动拿到可激活实例，启用必须有人显式表达。只有 Provider / 存储后端这类不进控制面的
 * `hostPlugin` 与本键无关，它们的键写了也不生效。
 */
export type ExtensionToggles = Readonly<Record<string, boolean>>;

/** @deprecated 旧名，等价于 `ExtensionToggles`；新代码用后者。 */
export type FrontendExtensionPreferences = ExtensionToggles;

/** 某个扩展在配置文件里的启停键：`extensions.<id>.enabled`。 */
export function extensionToggleKey(extensionId: string): string {
  return `${EXTENSION_CONFIG_PREFIX}.${extensionId}.enabled`;
}

/** @deprecated 旧名，等价于 `extensionToggleKey`；新代码用后者。 */
export const frontendExtensionSettingKey = extensionToggleKey;

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
  /**
   * 扩展的启停状态（配置文件 `extensions.<id>.enabled` 的投影）。
   * 缺省表示宿主没有提供该项（旧宿主）：消费方按 manifest 默认值处理。
   */
  extensionToggles?: ExtensionToggles;
  files: { config: string; secrets: string };
};

export type SettingsWriteValue = string | number | boolean | null;
export type SettingsWrite = { values: Record<string, SettingsWriteValue> };

/**
 * 解码 browser-local 插件启停写入：`{ extensionId, enabled }`。
 *
 * 与设置项写入分开表达：这类键是按目录发现动态产生的，不进静态定义表。
 */
export function decodeFrontendExtensionWrite(
  body: unknown
): { ok: true; value: { extensionId: string; enabled: boolean } } | { ok: false; message: string } {
  if (!isJsonObject(body)) return { ok: false, message: "请求体必须是 JSON 对象" };
  if (typeof body.extensionId !== "string" || body.extensionId.trim() === "") {
    return { ok: false, message: "extensionId 必须是非空字符串" };
  }
  if (typeof body.enabled !== "boolean") return { ok: false, message: "enabled 必须是布尔值" };
  return { ok: true, value: { extensionId: body.extensionId, enabled: body.enabled } };
}

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
