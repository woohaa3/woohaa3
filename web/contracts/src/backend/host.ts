/**
 * 本机宿主 Cordis 插件树的公共契约。
 *
 * 插件树分三层：基础（log / config）、核心（canvas / task / generation / storage / media）、
 * 扩展（provider 与存储后端等可增删插件）。`generation` 与 `storage` 是核心扩展点，`media`
 * 只使用存储。扩展只依赖这里声明的服务形状，不 import 宿主实现。
 *
 * 扩展用 `defineConfigSchema` 声明自己的全部配置项，密钥也是其中的 `secret` 字段：宿主把它们
 * 合并进设置定义表，设置页据此生成表单并经设置接口写回（密钥写进本地密钥文件）；配置变化后
 * 宿主以新配置重启该插件。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { FilmSetConversionProvider } from "../canvas/film-set-conversion/provider.js";
import type {
  ApplicationBackendExtensionHealth,
  ApplicationBackendHandlerRegistration,
  ApplicationBackendHttpHandlerRegistration,
  ApplicationBackendRawHttpHandlerRegistration
} from "../extension/runtime.js";
import type { PluginIcon } from "../plugin-icon.js";
import type { CanvasTaskModelType } from "../task/dto.js";
import { parseSettingValue, type SettingDefinition, type SettingPrimitive } from "../settings/index.js";
import type { GenerationProvider } from "./generation.js";
import type { HostMarketplaceService } from "./marketplace.js";
import type { HostStorageService } from "./storage.js";

export type HostLog = (event: Record<string, unknown>) => void;

export type HostLogService = {
  /** 带 `module` 字段的结构化日志出口。 */
  scope(module: string): HostLog;
};

/** `ctx.generation`：生成 Provider 的注册面，Task 从这里读取。 */
export type HostGenerationService = {
  /** 注册 Provider；返回注销函数（插件放进 `ctx.effect`，卸载时自动注销）。 */
  register(provider: GenerationProvider): () => void;
  unregister(providerId: string): void;
  /** 注册「转为片场」转换提供方；返回注销函数。 */
  registerConversion(provider: FilmSetConversionProvider): () => void;
  list(): readonly GenerationProvider[];
  resolve(providerId: string): GenerationProvider | undefined;
  conversions(): readonly FilmSetConversionProvider[];
};

/** 扩展可注入的宿主服务。 */
export type HostExtensionContext = Context & {
  readonly log: HostLogService;
  readonly generation: HostGenerationService;
  readonly storage: HostStorageService;
  /**
   * 扩展市场来源注册面（change: 2026-10-21-add-extension-marketplace-point，D1/D3）。
   * 只有内置根扩展可以注册来源；受管根 / 可写根扩展调用 `register` 会被宿主拒绝。
   */
  readonly marketplace: HostMarketplaceService;
  /**
   * 受控 HTTP 路由（可选：最小装配/测试里可能没有 gateway）。
   *
   * 与 `generation` / `storage` 同级：它是**公共基础设施**，不是某类插件的专属特权。
   * 声明它是可选的原因：纯 provider 插件不需要它，宿主在无 gateway 的组合里也不提供。
   */
  readonly webServer?: HostWebServerService;
};

/**
 * 扩展层 Cordis 插件的种类（`extension.json` 的 `hostPlugin.kind`）：`provider` 注入 `ctx.generation`，
 * `storage` 注入 `ctx.storage`，`marketplace-source` 注入 `ctx.marketplace`（只允许内置根）。
 */
export const HOST_PLUGIN_KINDS = ["provider", "storage", "marketplace-source"] as const;
export type HostPluginKind = (typeof HOST_PLUGIN_KINDS)[number];

export type HostConfigField = SettingDefinition extends infer D ? (D extends unknown ? Omit<D, "group" | "ownerExtensionId"> : never) : never;
export type HostConfigFields = Readonly<Record<string, HostConfigField>>;

type FieldValue<D> = D extends { kind: "integer" } ? number : D extends { kind: "boolean" } ? boolean : string;
type HasDefault<D> = D extends { default: infer V } ? (undefined extends V ? false : true) : false;

/** 有默认值的字段必有值，其余可缺省。 */
export type HostConfigValues<F extends HostConfigFields> = {
  -readonly [K in keyof F as HasDefault<F[K]> extends true ? K : never]: FieldValue<F[K]>;
} & {
  -readonly [K in keyof F as HasDefault<F[K]> extends true ? never : K]?: FieldValue<F[K]>;
};

type ConfigIssue = { readonly message: string; readonly path?: ReadonlyArray<PropertyKey> };

/** 结构上满足 Standard Schema v1，可直接作为 Cordis 插件的 `Config`。 */
export type HostConfigSchema<F extends HostConfigFields = HostConfigFields> = {
  readonly fields: F;
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: "woohaa3";
    readonly validate: (value: unknown) => { readonly value: HostConfigValues<F> } | { readonly issues: ReadonlyArray<ConfigIssue> };
    readonly types?: { readonly input: unknown; readonly output: HostConfigValues<F> };
  };
};

export function defineConfigSchema<const F extends HostConfigFields>(fields: F): HostConfigSchema<F> {
  return {
    fields,
    "~standard": {
      version: 1,
      vendor: "woohaa3",
      validate(value) {
        const input = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
        const output: Record<string, SettingPrimitive> = {};
        const issues: ConfigIssue[] = [];
        for (const [key, field] of Object.entries(fields)) {
          const raw = input[key];
          if (raw === undefined || raw === null || raw === "") {
            if (field.default !== undefined) output[key] = field.default;
            continue;
          }
          const parsed = parseSettingValue(field as SettingDefinition, raw);
          if (parsed.ok) output[key] = parsed.value;
          else issues.push({ message: `${key}：${parsed.message}`, path: [key] });
        }
        return issues.length > 0 ? { issues } : { value: output as HostConfigValues<F> };
      }
    }
  };
}

/**
 * 扩展插件：Cordis 对象插件加上宿主装载所需的元数据。
 *
 * 宿主从配置段 `configPrefix` 读取值、按 `Config` 校验后调用 `apply`；`label` 是设置页分组名。
 */
export type HostExtensionPlugin<F extends HostConfigFields = HostConfigFields> = {
  readonly name: string;
  readonly label: string;
  /** 宿主扫描到的插件绝对目录，仅用于展示。 */
  readonly directory?: string;
  /** 设置页插件卡片上的图标：语义图形名（`PLUGIN_ICON_NAMES`）或品牌图形路径；缺省显示通用插件图标。 */
  readonly icon?: PluginIcon;
  /** Provider 适配器支持的输出类型，用于配置前的能力标签；不代表账号已有模型或授权。 */
  readonly modelTypes?: readonly CanvasTaskModelType[];
  /**
   * 模型目录刷新入口声明：设置页据此显示「可用模型」一节（说明 + 刷新按钮）。
   *
   * `path` 由插件自己在 `apply` 里用 `ctx.gateway.route` 注册并鉴权；宿主只把声明透传给设置面，
   * MUST NOT 在管理面硬编码具体 Provider（见 application-extension-runtime 规范）。
   */
  readonly modelRefresh?: { readonly path: string; readonly hint: string };
  readonly configPrefix: string;
  readonly inject: string[];
  readonly Config: HostConfigSchema<F>;
  /**
   * 插件自报健康：返回 `undefined` 表示健康，返回 degraded 表示「已装载但能力没就绪」
   * （例如生成 Provider 还没配 API Key）。
   *
   * 每次状态查询都会用**当前**配置调用它，所以补上凭据后不用重启插件，站点状态就回到 active。
   * 只有受站点开关管理的插件需要实现；未实现时一律按健康处理。
   *
   * 用方法签名而不是属性签名：属性上的函数类型在 strictFunctionTypes 下按逆变检查，会让
   * `HostExtensionPlugin<具体 F>` 不再能赋给 `AnyHostExtensionPlugin`（`HostExtensionPlugin<any>`）；
   * 方法签名保持双变（与 `apply` 一致），`AnyHostExtensionPlugin` 才继续成立。
   */
  health?(config: HostConfigValues<F>): ApplicationBackendExtensionHealth | undefined;
  apply(ctx: HostExtensionContext, config: HostConfigValues<F>): void | Promise<void>;
};

export type AnyHostExtensionPlugin = HostExtensionPlugin<any>;

/**
 * `ctx.webServer`：扩展注册受控 HTTP 路由的唯一入口。
 *
 * 与 `hostPlugin` 的 `ctx.generation` / `ctx.storage` 同级——不再挂在某个「后端宿主」胖接口上。
 * 注册仍是**相对 route**：宿主按 `<extensionId>/<route>` 组织全局注册表并对外拼
 * `/api/extensions/<extensionId>/...`，前缀由宿主添加，插件无法绕过（否则任意扩展都能占用根路径）。
 *
 * 三种注册对应三种响应能力：
 * - `register`：结构化 JSON（自动序列化、受控错误码）；
 * - `registerHttp`：可写 header / 状态码，仍由宿主构造 req/res 视图；
 * - `registerRawHttp`：直接操作 Node `req`/`res`（302 重定向、HTML 完成页、SSE 长连接）。
 */
export type HostWebServerService = {
  /** 受控 JSON handler：路由 + 处理函数，宿主统一分派并序列化结果。 */
  register(registration: ApplicationBackendHandlerRegistration): void;
  /** HTTP handler：可设置状态码与响应头。 */
  registerHttp(registration: ApplicationBackendHttpHandlerRegistration): void;
  /** 原始 HTTP handler：直接读写 Node `req`/`res`（重定向、HTML、SSE）。 */
  registerRawHttp(registration: ApplicationBackendRawHttpHandlerRegistration): void;
};
