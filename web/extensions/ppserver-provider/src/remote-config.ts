/**
 * 读公开远程配置，拿 ppserver 的地址与 Supabase 凭据。
 *
 * **为什么要有这一层**：PS 插件并不让用户填这些 —— 它在启动时拉
 * `https://sdppp.zombee.tech/banners/sixi/config.json`，取 `taskrouterBaseUrl` /
 * `supabaseUrl` / `supabaseAnonKey`（见 `sdppp-photoshop/vite.config.ts` 的
 * `remoteConfigLoader` 与 `tsx/sixi/config.ts`）。地址和 anon key 都是公开值，
 * 放在静态站上是为了「换后端不用发版」。插件里唯一的用户输入是登录换来的令牌。
 *
 * 照搬这套的好处是**两边永远指向同一个后端**：运维换地址，插件下次启动自动跟上。
 *
 * 失败不抛：配置拿不到就回落到调用方给的缺省值，并把原因记进 warnings，
 * 让设置页能说清楚是「没配」还是「拉不到」。
 */

/** PS 插件注册的 `sixi-sdpppx` 配置地址（注意是 sdppp，不是 sdpppx）。 */
export const DEFAULT_REMOTE_CONFIG_URL = "https://sdppp.zombee.tech/banners/sixi/config.json";

/** 拉配置不该拖慢启动。 */
const CONFIG_TIMEOUT_MS = 8_000;

export type RemoteSixiConfig = {
  taskrouterBaseUrl?: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
};

export type RemoteConfigResult = {
  config: RemoteSixiConfig;
  /** 取不到时的原因（面向设置页）。取到了就是 undefined。 */
  warning?: string;
};

export function interpretRemoteConfig(payload: unknown): RemoteSixiConfig {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const record = payload as Record<string, unknown>;
  return {
    ...(readString(record.taskrouterBaseUrl, true) ? { taskrouterBaseUrl: readString(record.taskrouterBaseUrl, true)! } : {}),
    ...(readString(record.supabaseUrl, true) ? { supabaseUrl: readString(record.supabaseUrl, true)! } : {}),
    ...(readString(record.supabaseAnonKey, false) ? { supabaseAnonKey: readString(record.supabaseAnonKey, false)! } : {})
  };
}

export async function fetchRemoteSixiConfig(options: {
  url?: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
} = {}): Promise<RemoteConfigResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = options.url ?? DEFAULT_REMOTE_CONFIG_URL;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? CONFIG_TIMEOUT_MS)
    });
    if (!response.ok) {
      return { config: {}, warning: `读取远程配置失败（HTTP ${response.status}）` };
    }
    return { config: interpretRemoteConfig(await response.json()) };
  } catch (error) {
    return {
      config: {},
      warning: `读取远程配置失败：${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/** 地址只要 http(s)；空串与其它协议一律当没给。 */
function readString(value: unknown, requireUrl: boolean): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (requireUrl && !/^https?:\/\//i.test(trimmed)) return undefined;
  return trimmed;
}
