/**
 * 基础层 · identity：`GET /api/host/identity`，回答「这是哪一份实例」。
 *
 * 同机多实例是常态（打包版、`pnpm dev` 的前后端、桌面随包宿主），而它们的 HTTP 形状一模一样：
 * 端口都能连、`/api/canvases` 都回 200、画布 id 甚至能重合，但数据完全是两套。外部工具要选
 * 「连哪一个」，就必须先能比对身份，否则只能靠猜端口。
 *
 * ## 为什么数据目录是身份的主要来源
 *
 * 它直接决定「这份数据是谁」：同一个目录的两个端口（dev 的 vite 页面前端与后端）应当被认成
 * 一个实例，不同目录的两个端口必须是不同实例。端口、进程 id 都不具备这个性质。
 *
 * ## 为什么还要启动时刻
 *
 * 同一份数据被重启后，「当前挂载、运行态、内存缓存」全都换了。把启动时刻并进指纹，
 * 重启就会被判成新实例，外部工具据此重新握手而不是继续用旧结论。
 *
 * ## 落盘目录怎么定位
 *
 * 三种运行形态给出不同的环境变量，按优先级取第一个存在的：
 * 1. `WOOHAA3_RUNTIME_DATA_DIR`：桌面随包宿主显式给出；
 * 2. 应用库在 `<数据根>/stores/application.sqlite`（打包版 web host）：取它的上两级；
 * 3. 其余（`pnpm dev` 的扁平 `.local/`）：取应用库所在目录。
 *
 * 取不到时回落进程工作目录——宁可给一个不够精确的答案，也不要让端点整个不可用：
 * 外部工具至少还能靠启动时刻区分进程。
 */
import path from "node:path";
import { createHostIdentity, createHostIdentityApiHandler } from "../../api/host-identity-api.js";
import {
  IDENTITY_REGISTRY_SCHEMA,
  removeRegistryEntry,
  resolveRegistryDir,
  writeRegistryEntry
} from "../identity-registry.js";
import type { HostPlugin } from "../context.js";
import { ROUTE_ORDER } from "../order.js";

/** 身份端点在网关里的顺序：与重启端点同区间，早于所有领域服务的宽前缀。 */
const IDENTITY_ORDER = ROUTE_ORDER.hostRestart + 1;

/**
 * 写入实例登记。
 *
 * 放在这个插件里是刻意的：登记描述的就是「身份 + 我在哪个端口」，两者同源才不会写出
 * 一条自相矛盾的记录。端点在监听之后才有真实的端口，所以由进程入口通过
 * `publishOrigin` 补上；在此之前不登记（宁可晚一点，也不要写错端口）。
 */
export type HostIdentityRegistration = {
  /** 记录监听成功后真实生效的 origin，并写入登记表。 */
  publishOrigin(origin: string): void;
};

export type HostIdentityPluginOptions = {
  env: Record<string, string | undefined>;
  /** 登记目录；缺省按平台推导（见 `resolveRegistryDir`）。 */
  registryDir?: string;
};

/**
 * 从环境变量推导数据根目录。
 * @param env - 宿主环境变量。
 * @returns 绝对路径；全部缺失时回落工作目录。
 */
export function resolveDataDir(env: Record<string, string | undefined>): string {
  const runtimeDir = env.WOOHAA3_RUNTIME_DATA_DIR?.trim();
  if (runtimeDir) return path.resolve(runtimeDir);
  const storePath = env.WOOHAA3_APPLICATION_STORE_PATH?.trim();
  if (storePath) {
    const directory = path.dirname(path.resolve(storePath));
    // 打包版把库放在 `<数据根>/stores/`；dev 是扁平的 `.local/xxx.sqlite`。
    return path.basename(directory) === "stores" ? path.dirname(directory) : directory;
  }
  return process.cwd();
}

export const identityPlugin: HostPlugin<HostIdentityPluginOptions> = {
  name: "identity",
  inject: ["log", "gateway"],
  apply(ctx, { env, registryDir }) {
    const log = ctx.log.scope("host-identity");
    const dataDir = resolveDataDir(env);
    const identity = createHostIdentity({
      dataDir,
      startedAt: new Date(),
      version: env.WOOHAA3_APP_VERSION?.trim() ?? ""
    });
    log({ event: "host-identity-published", instanceId: identity.instanceId, dataDir });
    const handler = createHostIdentityApiHandler(identity);
    ctx.effect(() => ctx.gateway.route(IDENTITY_ORDER, handler));

    /**
     * 登记表：把「我是谁、我在哪」写到固定目录，让同机其他工具不必扫端口找人。
     *
     * 撤销登记挂在插件 effect 上：插件卸载或进程正常退出都会走到这里。被强杀时条目会残留，
     * 由读取方按 pid 与身份端点校验——清理是 best-effort，读取方不依赖它。
     */
    const directory = resolveRegistryDir(registryDir);
    let published = false;
    ctx.provide("hostIdentityRegistration", {
      publishOrigin(origin: string) {
        // 只登记一次：origin 在监听后不再变化，重复写没有意义（也避免测试里被多次调用干扰）。
        if (published) return;
        published = true;
        // 页面地址优先：dev 形态里后端只监听 API 端口，页面由 vite 在另一个端口提供。
        // 登记成 API 端口的话，外部工具选过去点开画布只会看到 404。
        const publicOrigin = env.WOOHAA3_PUBLIC_ORIGIN?.trim();
        const registeredOrigin = (publicOrigin !== undefined && publicOrigin !== "" ? publicOrigin : origin).replace(/\/+$/, "");
        try {
          writeRegistryEntry(directory, {
            schema: IDENTITY_REGISTRY_SCHEMA,
            instanceId: identity.instanceId,
            origin: registeredOrigin,
            dataDir: identity.dataDir,
            startedAt: identity.startedAt,
            pid: process.pid,
            version: identity.version,
            ...(publicOrigin !== undefined && publicOrigin !== "" ? { apiOrigin: origin.replace(/\/+$/, "") } : {})
          });
          log({ event: "host-identity-registered", instanceId: identity.instanceId, origin: registeredOrigin });
        } catch (error) {
          // 登记失败不影响身份端点：发现方还有端口探测这条退路。
          log({ event: "host-identity-register-failed", message: error instanceof Error ? error.message : String(error) });
        }
      }
    } satisfies HostIdentityRegistration);
    ctx.effect(() => () => removeRegistryEntry(directory, identity.instanceId));
  }
};
