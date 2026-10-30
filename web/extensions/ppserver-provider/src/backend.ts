/**
 * ppserver Provider 后端插件入口。
 *
 * 声明 `providers.ppserver` 配置段，向 `ctx.generation` 注册。与其它 Provider 的区别：
 *
 * - **没有厂商模型表**。模型 = 服务端模板（`tasks_template.id`，UUID），由配置里的模板名单
 *   决定；参数表单来自 `/tasks/describe`，所以厂商改参数不用改插件；
 * - **供应商由服务端路由**，插件只认 templateId，不接触 CRUN / Novita 的密钥；
 * - 需要的是**一个 Bearer 令牌**（Supabase access_token），不是厂商 API Key。
 *
 * 令牌作为 `secret` 配置字段写进本地密钥文件。这是站点级配置，不是「每个用户各自登录」——
 * 按用户授权的形态要等宿主把用户 principal 传给 Provider（`serviceConnectionFactory`），
 * 现在没有这条通路，所以别在前端假装它已经按用户隔离。
 */
import {
  defineConfigSchema,
  type GenerationModelDescription,
  type GenerationProvider,
  type ExtensionPlugin
} from "@woohaa3/contracts";
import { createProviderLifecycleFetch, createGuardedFetch, registerModelRefreshRoute } from "@woohaa3/provider-sdk";
import { discoverTemplates, parseTemplateSpecs, ppserverModelDefinitions, type PpserverTemplate, type TemplateSpec } from "./discovery.js";
import { createPpserverProvider, type PpserverCatalog } from "./provider.js";
import { DEFAULT_PPSERVER_BASE_URL, PPSERVER_PLUGIN_ID, PPSERVER_PROVIDER_ID, ppserverOrigin } from "./shared.js";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const REFRESH_PATH = "/api/providers/ppserver/refresh";

export const PPSERVER_CONFIG = defineConfigSchema({
  accessToken: {
    kind: "string",
    secret: true,
    reload: "hot",
    legacyEnv: "PPSERVER_ACCESS_TOKEN",
    label: "访问令牌",
    description: "ppserver 的 Bearer 令牌（Supabase access_token）。厂商密钥在服务端，插件不接触。"
  },
  baseUrl: {
    kind: "url",
    protocols: ["https:", "http:"],
    default: DEFAULT_PPSERVER_BASE_URL,
    reload: "hot",
    legacyEnv: "PPSERVER_BASE_URL",
    label: "API 地址",
    description: "任务路由器地址，例如 https://sdpppx.zombee.tech/ppserver"
  },
  tenantId: {
    kind: "string",
    reload: "hot",
    legacyEnv: "PPSERVER_TENANT_ID",
    label: "租户 ID",
    description: "服务端按租户计费与筛选模板；留空则由服务端按令牌推断"
  },
  templates: {
    kind: "string",
    reload: "hot",
    label: "模板",
    description:
      "要接入的生图 / 生视频模板（UUID），逗号或换行分隔。生视频模板写 `<UUID>:video`，其余按图片处理。模板 ID 在管理后台「任务模板」页查看。"
  }
});

export type PpserverRegistrationInput = {
  accessToken?: string;
  baseUrl?: string;
  tenantId?: string;
  templates?: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof globalThis.fetch;
  jobRepository?: unknown;
  /** 已发现的结果（刷新后回填）；缺省时按配置里的 spec 建目录。 */
  discovered?: readonly PpserverTemplate[];
};

export type PpserverPluginDependencies = Pick<
  PpserverRegistrationInput,
  "timeoutMs" | "maxBytes" | "fetchImpl" | "jobRepository"
>;

/** 没有 discover 结果时的占位目录：模型条目要等刷新才完整，但设置页能先看到插件。 */
export function templatesFromSpecs(specs: readonly TemplateSpec[]): PpserverTemplate[] {
  return specs.map((spec) => ({
    modelId: spec.templateId,
    templateId: spec.templateId,
    kind: spec.kind ?? "image",
    title: spec.templateId
  }));
}

/**
 * `available` 需要令牌、地址，以及至少一条合法模板 ID。
 * 未配齐时仍注册，设置页能看到插件并预填。
 */
export function createPpserverRegistration(input: PpserverRegistrationInput): {
  registration: GenerationProvider;
  catalog: PpserverCatalog;
} {
  const accessToken = (input.accessToken ?? "").trim();
  const baseUrl = (input.baseUrl ?? DEFAULT_PPSERVER_BASE_URL).trim();
  const tenantId = (input.tenantId ?? "").trim();
  const parsed = parseTemplateSpecs(input.templates);
  const available = accessToken !== "" && baseUrl !== "" && parsed.ok && parsed.specs.length > 0;

  const catalog: PpserverCatalog = {
    templates: [...(input.discovered ?? (parsed.ok ? templatesFromSpecs(parsed.specs) : []))]
  };

  const guarded = createGuardedFetch({
    baseUrl,
    maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // 结果地址由 ppserver 返回，通常是它自己的 CDN；只放行图片与视频。
    allowedContentTypes: ["image/", "video/"],
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });

  const provider = available
    ? createPpserverProvider({
        accessToken,
        baseUrl,
        catalog,
        ...(tenantId ? { tenantId } : {}),
        ...(input.jobRepository ? { jobRepository: input.jobRepository } : {}),
        fetch: guarded
      })
    : undefined;

  return {
    catalog,
    registration: {
      extensionId: PPSERVER_PLUGIN_ID,
      providerId: PPSERVER_PROVIDER_ID,
      available,
      provider,
      models: ppserverModelDefinitions(catalog.templates),
      describeModel: (model) => {
        const found = catalog.templates.find((item) => item.modelId === model.providerModelId);
        if (!found) return undefined;
        return {
          title: found.title,
          ...(found.inputSchema ? { inputSchema: found.inputSchema } : {}),
          ...(found.defaultInput ? { defaultInput: found.defaultInput } : {}),
          promptRequirement: "required",
          cancel: "remote"
        } satisfies GenerationModelDescription;
      }
    }
  };
}

export function createPpserverProviderPlugin(
  deps: PpserverPluginDependencies = {}
): ExtensionPlugin<typeof PPSERVER_CONFIG.fields> {
  return {
    name: PPSERVER_PLUGIN_ID,
    label: "ppserver",
    configPrefix: "providers.ppserver",
    modelTypes: ["image", "video"],
    modelRefresh: {
      path: REFRESH_PATH,
      hint:
        "模板由 ppserver 的任务模板表提供，插件不写死模型。填好令牌与模板 ID（UUID，生视频写 <UUID>:video）后会发现一次，也可以再刷新；参数表单在每次刷新时从 /tasks/describe 读取。"
    },
    inject: ["log", "generation", "gateway", "access"],
    Config: PPSERVER_CONFIG,
    health: (config) => {
      const accessToken = (config.accessToken ?? "").trim();
      const baseUrl = (config.baseUrl ?? DEFAULT_PPSERVER_BASE_URL).trim();
      const parsed = parseTemplateSpecs(config.templates);
      if (accessToken !== "" && baseUrl !== "" && parsed.ok && parsed.specs.length > 0) return undefined;
      const message = accessToken === ""
        ? "未配置访问令牌，ppserver 模板当前不可执行"
        : baseUrl === ""
          ? "API 地址为空，ppserver 模板当前不可执行"
          : !parsed.ok
            ? parsed.message
            : "未填写模板。在管理后台「任务模板」页复制模板 ID（UUID）";
      return { state: "degraded" as const, diagnostics: [{ code: "provider-credentials-missing", message }] };
    },
    async apply(ctx, config) {
      const accessToken = config.accessToken?.trim() ?? "";
      const baseUrl = config.baseUrl;
      const tenantId = config.tenantId?.trim() ?? "";
      const log = ctx.log.scope(PPSERVER_PLUGIN_ID);

      const { registration, catalog } = createPpserverRegistration({
        ...deps,
        fetchImpl: createProviderLifecycleFetch(ctx, deps.fetchImpl),
        ...(accessToken ? { accessToken } : {}),
        baseUrl,
        ...(tenantId ? { tenantId } : {}),
        ...(config.templates ? { templates: config.templates } : {})
      });

      const refresh = async (): Promise<{ ok: true; modelCount: number; message?: string } | { ok: false; message: string }> => {
        const parsed = parseTemplateSpecs(config.templates);
        if (!parsed.ok) return { ok: false, message: parsed.message };
        if (parsed.specs.length === 0) return { ok: false, message: "先填写模板 ID" };
        const result = await discoverTemplates({
          baseUrl: ppserverOrigin(baseUrl),
          specs: parsed.specs,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
        });
        if (!result.ok) {
          log({ event: "ppserver-template-discovery-failed", message: result.message });
          return result;
        }
        catalog.templates.splice(0, catalog.templates.length, ...result.templates);
        registration.models.splice(0, registration.models.length, ...ppserverModelDefinitions(result.templates));
        log({ event: "ppserver-templates-discovered", templateCount: result.templates.length });
        return {
          ok: true,
          modelCount: result.templates.length,
          ...(result.message ? { message: result.message } : {})
        };
      };

      if (registration.available) await refresh();
      ctx.effect(() => ctx.generation.register(registration));
      registerModelRefreshRoute(ctx, { path: REFRESH_PATH, refresh });
      log({
        event: "ppserver-plugin-activated",
        available: registration.available,
        modelCount: registration.models.length
      });
    }
  };
}
