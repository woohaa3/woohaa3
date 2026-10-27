/**
 * 扩展插件（Extension Plugin）的**形状契约**：Cordis 对象插件 + 宿主装载所需的元数据。
 *
 * 这里是「一个扩展的宿主侧实现长什么样」的唯一声明处。它只描述形状，不含宿主实现，
 * 也不含任何具体扩展；扩展、宿主装载器与设置面都从这里取类型。
 *
 * 为什么在 `extension/` 而不是 `backend/`：插件形状不是后端专属——配置面（`defineConfigSchema`）
 * 前后端共用，前端也需要同一份 `Config` 语义。宿主**服务**的形状在 `./service.js`。
 *
 * 扩展用 `defineConfigSchema` 声明自己的全部配置项，密钥也是其中的 `secret` 字段：宿主把它们
 * 合并进设置定义表，设置页据此生成表单并经设置接口写回（密钥写进本地密钥文件）；配置变化后
 * 宿主以新配置重启该插件。
 */
import type { ApplicationBackendExtensionHealth } from "./host/runtime.js";
import type { PluginIcon } from "../plugin-icon.js";
import type { CanvasTaskModelType } from "../task/dto.js";
import { parseSettingValue, type SettingDefinition, type SettingPrimitive } from "../settings/index.js";
import type { HostExtensionContext } from "./service.js";

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
export type ExtensionPlugin<F extends HostConfigFields = HostConfigFields> = {
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
   * `path` 由插件自己在 `apply` 里用 `ctx.webServer.route`（或 `ctx.gateway.route`）注册并鉴权；
   * 宿主只把声明透传给设置面，MUST NOT 在管理面硬编码具体 Provider（见 application-extension-runtime 规范）。
   */
  readonly modelRefresh?: { readonly path: string; readonly hint: string };
  readonly configPrefix: string;
  /**
   * Cordis 的依赖注入声明（与 `ExtensionPlugin` 同形）。
   *
   * 两种形态：`string[]` 表示全部必需；对象形态可以区分必需与**可选**——
   * 宿主能力（`webServer` / `capabilities` / `services` / `diagnostics`）在最小装配里可能缺席，
   * 插件应声明为可选，缺席时按能力分支而不是装载失败。
   */
  readonly inject:
    | readonly string[]
    | { readonly required?: readonly string[]; readonly optional?: readonly string[] };
  readonly Config: HostConfigSchema<F>;
  /**
   * 插件自报健康：返回 `undefined` 表示健康，返回 degraded 表示「已装载但能力没就绪」
   * （例如生成 Provider 还没配 API Key）。
   *
   * 每次状态查询都会用**当前**配置调用它，所以补上凭据后不用重启插件，站点状态就回到 active。
   * 只有受站点开关管理的插件需要实现；未实现时一律按健康处理。
   *
   * 用方法签名而不是属性签名：属性上的函数类型在 strictFunctionTypes 下按逆变检查，会让
   * `ExtensionPlugin<具体 F>` 不再能赋给 `AnyExtensionPlugin`（`ExtensionPlugin<any>`）；
   * 方法签名保持双变（与 `apply` 一致），`AnyExtensionPlugin` 才继续成立。
   */
  health?(config: HostConfigValues<F>): ApplicationBackendExtensionHealth | undefined;
  apply(ctx: HostExtensionContext, config: HostConfigValues<F>): void | Promise<void>;
};

export type AnyExtensionPlugin = ExtensionPlugin<any>;
