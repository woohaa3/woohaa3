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
import { fetchTemplateCatalog } from "./catalog.js";
import { discoverTemplates, ppserverModelDefinitions, type PpserverTemplate } from "./discovery.js";
import { createPpserverProvider, type PpserverCatalog } from "./provider.js";
import { fetchRemoteSixiConfig } from "./remote-config.js";
import { ensureSession, sessionFilePath } from "./session.js";
import { registerPpserverProxy } from "./routes.js";
import {
  DEFAULT_PPSERVER_BASE_URL,
  DEFAULT_SUPABASE_ANON_KEY,
  DEFAULT_SUPABASE_URL,
  PPSERVER_PLUGIN_ID,
  PPSERVER_PROVIDER_ID,
  ppserverOrigin
} from "./shared.js";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const REFRESH_PATH = "/api/providers/ppserver/refresh";

/**
 * 默认租户。**与 PS 插件是同一个值**（`tsx/sixi/config.ts` 的 `SIXI_TENANT_ID`），
 * 不是猜的 —— 两边必须指向同一个租户，否则计费与模板筛选会对不上。
 */
const DEFAULT_TENANT_ID = "d531fe93-2b6a-4941-a3c9-3fd312053379";

/**
 * 配置项与 PS 插件对齐：**只有令牌要人填**。
 *
 * 地址、Supabase 地址与 anon key 都是公开值，启动时从远程配置读
 * （见 `remote-config.ts`）；租户 ID 是常量。之所以还留成配置项，是为了
 * 私有部署能覆盖 —— 但**不填也能用**，缺省走远程配置。
 */
export const PPSERVER_CONFIG = defineConfigSchema({
  accessToken: {
    kind: "string",
    secret: true,
    reload: "hot",
    legacyEnv: "PPSERVER_ACCESS_TOKEN",
    label: "访问令牌",
    description: "登录后拿到的 Supabase access_token。这是唯一需要手填的一项；地址与 anon key 会自动从公开配置读取。"
  },
  refreshToken: {
    kind: "string",
    secret: true,
    reload: "hot",
    legacyEnv: "PPSERVER_REFRESH_TOKEN",
    label: "刷新令牌（推荐）",
    description:
      "Supabase 的 refresh_token。填了它，访问令牌过期时会自动续期并写回扩展数据目录，不用手工重填；只填访问令牌则约一小时后需要重新获取。"
  },
  baseUrl: {
    kind: "url",
    protocols: ["https:", "http:"],
    reload: "hot",
    legacyEnv: "PPSERVER_BASE_URL",
    label: "API 地址（可选）",
    description: "留空则用公开配置里的 taskrouterBaseUrl。只有私有部署才需要填。"
  },
  supabaseUrl: {
    kind: "url",
    protocols: ["https:", "http:"],
    reload: "hot",
    legacyEnv: "PPSERVER_SUPABASE_URL",
    label: "Supabase 地址（可选）",
    description: "留空则用公开配置里的 supabaseUrl。只有私有部署才需要填。"
  },
  supabaseAnonKey: {
    kind: "string",
    reload: "hot",
    legacyEnv: "PPSERVER_SUPABASE_ANON_KEY",
    label: "Supabase anon key（可选）",
    description: "留空则用公开配置里的 supabaseAnonKey。只有私有部署才需要填。"
  },
  tenantId: {
    kind: "string",
    reload: "hot",
    legacyEnv: "PPSERVER_TENANT_ID",
    label: "租户 ID（可选）",
    description: "留空则用内置常量，与 PS 插件一致。"
  }
});

export type PpserverRegistrationInput = {
  accessToken?: string;
  /**
   * 取当前可用的令牌（含自动续期）。给了就用它代替 `accessToken`，
   * 每次请求现取 —— 续期会换掉令牌，构造时固定的话续期后仍用旧值。
   */
  resolveAccessToken?: () => Promise<string>;
  baseUrl?: string;
  /** 读模板目录用的 Supabase 地址（`.../supabase/<项目 id>`）。 */
  supabaseUrl?: string;
  /** Supabase 公开 anon key。 */
  supabaseAnonKey?: string;
  tenantId?: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof globalThis.fetch;
  jobRepository?: unknown;
  /** 已发现的结果（刷新后回填）。 */
  discovered?: readonly PpserverTemplate[];
};

export type PpserverPluginDependencies = Pick<
  PpserverRegistrationInput,
  "timeoutMs" | "maxBytes" | "fetchImpl" | "jobRepository"
>;

/**
 * 目录来自模板表，所以 `available` 取决于「令牌 + 地址 + Supabase 地址」三项，
 * 而不是手填的模板名单。未配齐时仍注册，设置页能看到插件并预填。
 */
export function createPpserverRegistration(input: PpserverRegistrationInput): {
  registration: GenerationProvider;
  catalog: PpserverCatalog;
} {
  const accessToken = (input.accessToken ?? "").trim();
  const baseUrl = (input.baseUrl ?? DEFAULT_PPSERVER_BASE_URL).trim();
  const tenantId = (input.tenantId ?? "").trim();
  const available = accessToken !== "" && baseUrl !== "" && (input.supabaseUrl ?? "").trim() !== "";

  const catalog: PpserverCatalog = { templates: [...(input.discovered ?? [])] };

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
        accessToken: input.resolveAccessToken ?? accessToken,
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
        "模型目录直接读 ppserver 的任务模板表（与管理后台、PS 插件同一份数据）：启用中的模板会自动出现，带价格与分类。填好访问令牌、Supabase 地址与 anon key 后会发现一次，也可以再刷新；参数表单在刷新时从 /tasks/describe 补充。"
    },
    inject: ["log", "generation", "gateway", "access"],
    Config: PPSERVER_CONFIG,
    health: (config) => {
      // 只查令牌：地址与 anon key 由远程配置提供，启动后才知道拉没拉到（拉不到会记日志）。
      const accessToken = (config.accessToken ?? "").trim();
      if (accessToken !== "") return undefined;
      return {
        state: "degraded" as const,
        diagnostics: [{
          code: "provider-credentials-missing",
          message: "未填写访问令牌（登录后拿到的 Supabase access_token）。地址与 anon key 会自动从公开配置读取，不用手填。"
        }]
      };
    },
    async apply(ctx, config) {
      const accessToken = config.accessToken?.trim() ?? "";
      const refreshToken = config.refreshToken?.trim() ?? "";
      const log = ctx.log.scope(PPSERVER_PLUGIN_ID);

      /*
       * 地址与 Supabase 凭据：**先看远程配置，再看配置项覆盖**。
       *
       * 与 PS 插件一致（`tsx/sixi/config.ts` 的 `override ?? remoteConfig ?? ""`）——
       * 公开值放在静态站上，运维换后端不用发版。显式配置仍然优先，留给私有部署。
       */
      const remote = await fetchRemoteSixiConfig({
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
      });
      if (remote.warning) log({ event: "ppserver-remote-config-failed", message: remote.warning });
      const baseUrl = config.baseUrl?.trim() || remote.config.taskrouterBaseUrl || DEFAULT_PPSERVER_BASE_URL;
      /*
       * Supabase 地址与 anon key：配置项 > 远程配置 > **内置默认值**。
       *
       * 内置默认值不是冗余 —— `banners/sixi/config.json` 里的那组指向另一个项目
       * （`sdpppx.zombee.tech/supabase/…`），拿它查模板表会一直报「令牌无效」。
       * PS 插件本身也是用打包进去的 `sdpppX.js` 覆盖掉远程值的，这里与它保持一致。
       */
      /*
       * **不用 `config.json` 里的 Supabase 值**。
       *
       * 它的 `supabaseUrl` 指向 `sdpppx.zombee.tech/supabase/scehmsoyamzjjwzbnqxu`，
       * 而 PS 插件实际用的是 `sdpppX.js` 里那个库 —— 拿前者查模板表会一直报 401
       * 「令牌无效」，真正原因是连错了项目（踩过，排查了很久）。
       *
       * 所以这里只认「配置项 > 内置默认值」：与 PS 插件行为一致（它也是用打包进去的
       * `sdpppX.js` 覆盖远程值）。要换项目就改配置项。
       */
      const supabaseUrl = config.supabaseUrl?.trim() || DEFAULT_SUPABASE_URL;
      const anonKey = config.supabaseAnonKey?.trim() || DEFAULT_SUPABASE_ANON_KEY;
      // 租户 ID 与 PS 插件一样是常量，配置项只用于覆盖。
      const tenantId = config.tenantId?.trim() || DEFAULT_TENANT_ID;

      /*
       * 会话与续期。会话落盘到扩展数据目录（桌面端由宿主注入
       * `WOOHAA3_EXTENSION_DATA_DIR`；开发期没有就用临时目录，重启即丢 —— 仍可接受）。
       *
       * **必须在每次请求前取一次**：Supabase 刷新会轮换 refresh_token，续期后的新值
       * 只有落到内存里的 resolver 上才生效，所以 `resolveAccessToken` 是个函数。
       */
      const sessionFile = sessionFilePath(process.env.WOOHAA3_EXTENSION_DATA_DIR);
      let cachedToken = accessToken;
      const resolveAccessToken = async (): Promise<string> => {
        const result = await ensureSession({
          supabaseUrl,
          anonKey,
          ...(accessToken ? { fallbackAccessToken: accessToken } : {}),
          ...(refreshToken ? { seedRefreshToken: refreshToken } : {}),
          filePath: sessionFile,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          onRefreshError: (message) => log({ event: "ppserver-token-refresh-failed", message })
        });
        if (!result.ok) {
          // 续期拿不到新令牌时退回配置值：过期了就由请求本身报 401，信息更准确。
          log({ event: "ppserver-session-unavailable", message: result.message });
          return cachedToken;
        }
        if (result.refreshed) {
          cachedToken = result.session.accessToken;
          log({ event: "ppserver-token-refreshed", expiresAt: new Date(result.session.expiresAt).toISOString() });
        }
        return result.session.accessToken;
      };

      const { registration, catalog } = createPpserverRegistration({
        ...deps,
        fetchImpl: createProviderLifecycleFetch(ctx, deps.fetchImpl),
        ...(accessToken ? { accessToken } : {}),
        resolveAccessToken,
        baseUrl,
        ...(supabaseUrl ? { supabaseUrl } : {}),
        ...(anonKey ? { supabaseAnonKey: anonKey } : {}),
        ...(tenantId ? { tenantId } : {})
      });

      const refresh = async (): Promise<{ ok: true; modelCount: number; message?: string } | { ok: false; message: string }> => {
        // 目录读表（与 PS 插件同一张 tasks_template），参数表单仍问 describe。
        const listed = await fetchTemplateCatalog({
          supabaseUrl,
          anonKey,
          accessToken,
          ...(tenantId ? { tenantId } : {}),
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
        });
        if (!listed.ok) {
          log({ event: "ppserver-catalog-failed", message: listed.message });
          return listed;
        }

        // describe 只补表单，取不到不该让整个目录消失：参数面板退回模板表的默认值。
        const described = await discoverTemplates({
          baseUrl: ppserverOrigin(baseUrl),
          specs: listed.templates.map((template) => ({ templateId: template.templateId, kind: template.kind })),
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
        });
        const forms = new Map(
          (described.ok ? described.templates : []).map((template) => [template.templateId, template])
        );
        const templates = listed.templates.map((template) => {
          const form = forms.get(template.templateId);
          return {
            ...template,
            ...(form?.inputSchema ? { inputSchema: form.inputSchema } : {}),
            ...(form?.defaultInput ? { defaultInput: form.defaultInput } : {}),
            ...(form?.uploadProvider ? { uploadProvider: form.uploadProvider } : {})
          };
        });

        catalog.templates.splice(0, catalog.templates.length, ...templates);
        registration.models.splice(0, registration.models.length, ...ppserverModelDefinitions(templates));
        log({ event: "ppserver-templates-discovered", templateCount: templates.length });
        // describe 失败时把原因带出来，但目录本身已经可用。
        const note = described.ok ? undefined : `参数表单读取失败（${described.message}），已用模板默认值`;
        return { ok: true, modelCount: templates.length, ...(note ? { message: note } : {}) };
      };

      if (registration.available) await refresh();
      ctx.effect(() => ctx.generation.register(registration));
      registerModelRefreshRoute(ctx, { path: REFRESH_PATH, refresh });
      // 同源转发：四喜前端没有令牌，只能经这条路由借宿主的凭据调 ppserver。
      registerPpserverProxy(ctx, {
        baseUrl,
        accessToken: () => accessToken,
        tenantId: () => tenantId
      });
      log({
        event: "ppserver-plugin-activated",
        available: registration.available,
        modelCount: registration.models.length
      });
    }
  };
}
