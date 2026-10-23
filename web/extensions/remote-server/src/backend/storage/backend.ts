/**
 * 服务端托管存储后端（remote-server 的一个后端模块，不是独立插件）。
 *
 * 向宿主 `ctx.storage` 注册 `backendId = "server"` 的后端：字节存在远端 woohaa-server，
 * 元数据与签名走 `woohaa.storage.v1.StorageService`，字节读写一律走短时签名地址
 * （设计见 docs/design/server-object-storage.md）。
 *
 * 为什么字节不走一元 RPC：把大对象塞进 Connect 一元调用既没有流控也没有断点，而「私有读写」
 * 本来就该只有一条授权路径——签名。于是 `get`/`put` 只是「签个地址再 fetch」。
 *
 * 必须保留的行为：
 * - 对象键布局分两种：
 *   - **带画布作用域**（`scope.canvasId` 存在）：`<canvasId>/[<keyPrefix>/]<core 传入的 key>`。
 *     首段必须是 canvasId —— 服务端按首段判定画布 ACL，然后把前缀放在 canvasId 前面会让
 *     服务端认不出画布。
 *   - **无作用域**：`[<keyPrefix>/]<core 传入的 key>`，与旧版完全一致，已存对象不失联。
 *   core 已把 namespace 拼进 key（media 即 `media/<sha256>.<ext>`），本模块只加自己那几层。
 * - 会话与 remote-server 共用一份（`../session.js` 的 `RemoteSessionSource`），不自己登录；
 *   本模块**拿不到**部署凭证，也就没有把它带进日志或错误体的机会。
 * - 会话只在内存/宿主文档存储里：令牌不进日志、不进错误信息、不进响应体。
 */
import {
  StorageObjectNotFoundError,
  type StorageBackend,
  type StorageObject,
  type StorageObjectStat,
  type StorageObjectStream,
  type StorageScope
} from "@woohaa3/contracts";
import type { MediaLocator } from "@woohaa3/contracts";
import type { EnsureSessionResult, RemoteSession } from "../session.js";
import { REMOTE_SERVER_EXTENSION_ID } from "../../shared.js";
import {
  SERVER_STORAGE_BACKEND_ID,
  SERVER_STORAGE_LABEL,
  type ServerStorageConfig
} from "./config.js";
import {
  ServerStorageCallError,
  createServerStorageClient,
  parseProtoJsonInt,
  type ServerStorageClient,
  type ServerStorageSessionSource
} from "./client.js";

/** `CreateSignedUrl` 的取值（ProtoJSON 用枚举名）。 */
const SIGNED_URL_METHOD_GET = "SIGNED_URL_METHOD_GET";
const SIGNED_URL_METHOD_PUT = "SIGNED_URL_METHOD_PUT";

export type ServerStorageBackendOptions = {
  config: ServerStorageConfig;
  /** 与 remote-server 共用的会话来源（**不是**存储后端自己的登录缓存）。 */
  session: ServerStorageSessionSource;
  /** 注入 fake 传输层（测试用）；缺省按配置与共用会话构造真实客户端。 */
  client?: ServerStorageClient;
  /** 出站 fetch（仅在自建客户端时生效）。 */
  fetchImpl?: typeof globalThis.fetch;
  /** 时钟（测试用）。 */
  now?: () => number;
  /** 单次一元调用超时（测试可缩短）。 */
  timeoutMs?: number;
  /** 签名地址传输超时（测试可缩短）。 */
  transferTimeoutMs?: number;
  /** 站内相对基址的出站 origin（测试用）。 */
  hostOrigin?: string;
};

/**
 * 构造存储后端（便于测试直接使用）。
 *
 * `head` 不存在返回 `null`；`get`/`openRead` 不存在抛 `StorageObjectNotFoundError`；
 * `delete` 幂等（服务端对不存在的键同样返回成功）；`presign` 声明了，因此这个后端
 * 既能当 `storage.primary` 也能当 `storage.expose`。
 */
export function createServerStorageBackend(options: ServerStorageBackendOptions): StorageBackend {
  const { config } = options;
  const client = options.client ?? createServerStorageClient({
    config,
    session: options.session,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.transferTimeoutMs ? { transferTimeoutMs: options.transferTimeoutMs } : {}),
    ...(options.hostOrigin ? { hostOrigin: options.hostOrigin } : {})
  });

  // core 传进来的 key 已带 namespace；这里只加「画布 + 后端前缀」这两层。
  const keyPrefix = config.keyPrefix.replace(/^\/+|\/+$/g, "");

  /**
   * 对象键布局（服务端 ACL 依赖首段是 canvasId）。
   *
   * - 有作用域：`<canvasId>[/<keyPrefix>]/<key>`；
   * - 无作用域：`[/<keyPrefix>]/<key>` —— 保持旧布局，兼容同步前写入的对象。
   *
   * canvasId 两端的斜杠被去掉（作用域来自宿主，不该因为一个 "/" 把首段变成空串）。
   */
  const keyFor = (key: string, scope?: StorageScope): string => {
    const canvasId = scope?.canvasId?.trim().replace(/^\/+|\/+$/g, "") ?? "";
    if (canvasId) return [canvasId, ...(keyPrefix ? [keyPrefix] : []), key].join("/");
    return keyPrefix ? `${keyPrefix}/${key}` : key;
  };

  const createSignedUrl = async (
    key: string,
    method: string,
    extra: { expiresSeconds?: number; contentType?: string } = {}
  ): Promise<{ url: string; expiresAt: number | null }> => {
    const response = await client.call<unknown>("CreateSignedUrl", {
      key,
      method,
      // 0 表示「按服务端默认值」，与协议注释一致。
      expiresSeconds: extra.expiresSeconds && extra.expiresSeconds > 0 ? extra.expiresSeconds : 0,
      ...(extra.contentType ? { contentType: extra.contentType } : {})
    });
    const url = readString(response, "url");
    if (!url) throw new ServerStorageCallError("invalid-response", 200, "服务端没有返回签名地址");
    // expiresAt 是 int64：ProtoJSON 用字符串，手写网关可能给数字，两种都容错。
    return { url, expiresAt: parseProtoJsonInt(readField(response, "expiresAt")) };
  };

  /** 签名地址上的读取：把 404 映射成 not-found，其余错误按稳定短语抛出。 */
  const fetchSigned = async (url: string, init: RequestInit): Promise<Response> => {
    let response: Response;
    try {
      // 超时由 client 统一合成（它知道传输超时口径）；这里只负责把失败翻成稳定短语。
      response = await client.fetchSigned(url, init);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new ServerStorageCallError(timedOut ? "timeout" : "unreachable", 0, timedOut ? "签名地址读取超时" : "无法访问签名地址");
    }
    return response;
  };

  /**
 * 读一个已经拼好的物理键（get 与 readLocator 共用）。
 *
 * 两者的差别只有「键怎么来」：get 的键由画布作用域拼出来，readLocator 的键就是
 * locator 里那一段。授权、签名、容错必须只有一份实现。
 */
const readStored = async (errorKey: string, storedKey: string): Promise<StorageObject> => {
      const signed = await createSignedUrl(storedKey, SIGNED_URL_METHOD_GET);
      const response = await fetchSigned(signed.url, { method: "GET" });
      if (response.status === 404) throw new StorageObjectNotFoundError(errorKey);
      if (!response.ok) {
        throw new ServerStorageCallError(
          response.status === 403 ? "permission_denied" : `http-${response.status}`,
          response.status,
          `签名地址读取失败（HTTP ${response.status}）`
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      // 签名地址按协议回 Content-Type（HEAD/GET 同一套头）；万一网关剥掉了它，
      // 再问一次元数据——媒体 verify 会比对 contentType，缺了它等于读不出这个对象。
      const headerType = response.headers.get("content-type");
      const contentType = headerType ?? (await readRemoteContentType(client, storedKey));
      return { bytes, ...(contentType ? { contentType } : {}) };
};

const backend: StorageBackend = {
    backendId: SERVER_STORAGE_BACKEND_ID,
    label: SERVER_STORAGE_LABEL,
    ownerExtensionId: REMOTE_SERVER_EXTENSION_ID,
    // 声明自己是画布托管存储的承载者：归属远端的画布，媒体读写由 core 路由到这里。
    // core 不认 backendId=server 这个字符串，只认这个能力（纯本地部署没有任何承载者）。
    canvasScoped: true,
    async head(key, scope): Promise<StorageObjectStat | null> {
      const storedKey = keyFor(key, scope);
      let info: unknown;
      try {
        const response = await client.call<unknown>("HeadObject", { key: storedKey });
        info = readField(response, "info");
      } catch (error) {
        // 服务端约定用 `exists=false` 表达不存在；个别代理/旧版本会映射成 not_found，
        // 这里也当作「没有这个对象」，避免把正常的缺对象路径报成故障。
        if (error instanceof ServerStorageCallError && error.code === "not_found") return null;
        throw error;
      }
      if (readField(info, "exists") !== true) return null;
      // ProtoJSON 省略零值：空对象的 `size` 根本不出现（不是 0 的字符串）。缺字段按 0 解释，
      // 否则「存在但为空」的对象会被报成读取失败。出现字段但解析不了才是真的坏响应。
      const rawSize = readField(info, "size");
      const size = rawSize === null ? 0 : parseProtoJsonInt(rawSize);
      if (size === null || size < 0) throw new ServerStorageCallError("invalid-response", 200, `无法读取服务端对象大小：${key}`);
      const contentType = readString(info, "contentType");
      return { size, ...(contentType ? { contentType } : {}) };
    },
    async get(key, scope): Promise<StorageObject> {
      return readStored(key, keyFor(key, scope));
    },
    async openRead(key, range, scope): Promise<StorageObjectStream> {
      const storedKey = keyFor(key, scope);
      const signed = await createSignedUrl(storedKey, SIGNED_URL_METHOD_GET);
      const controller = new AbortController();
      const headers: Record<string, string> = {};
      if (range) headers.Range = `bytes=${range.start}-${range.end}`;

      let response: Response;
      try {
        response = await client.fetchSigned(signed.url, { method: "GET", headers, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) throw new Error("媒体读取已取消");
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        throw new ServerStorageCallError(timedOut ? "timeout" : "unreachable", 0, timedOut ? "签名地址读取超时" : "无法访问签名地址");
      }
      if (response.status === 404) throw new StorageObjectNotFoundError(key);
      if (!response.ok) {
        throw new ServerStorageCallError(
          response.status === 403 ? "permission_denied" : `http-${response.status}`,
          response.status,
          `签名地址读取失败（HTTP ${response.status}）`
        );
      }

      // 取消要一路传到 fetch：媒体面板换素材时旧请求必须真的停，否则服务端继续传字节。
      const bytes = readResponseStream(response, () => {
        if (!controller.signal.aborted) controller.abort();
      });
      return {
        bytes,
        cancel() {
          if (!controller.signal.aborted) controller.abort();
        }
      };
    },
    async put(key, bytes, contentType, scope): Promise<void> {
      const storedKey = keyFor(key, scope);
      // PUT 签名绑定 Content-Type：签名时给什么，写的时候必须原样发送（否则服务端 403）。
      const signed = await createSignedUrl(storedKey, SIGNED_URL_METHOD_PUT, { contentType });
      const response = await fetchSigned(signed.url, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        // DOM 的 BodyInit 只接受 ArrayBuffer 视角的视图；core 传进来的 Uint8Array 可能挂着
        // SharedArrayBuffer 类型参数，这里不复制字节，只做类型收窄（复制大对象是纯浪费）。
        body: bytes as unknown as BodyInit
      });
      if (!response.ok) {
        throw new ServerStorageCallError(
          response.status === 403 ? "permission_denied" : `http-${response.status}`,
          response.status,
          `签名地址写入失败（HTTP ${response.status}）`
        );
      }
    },
    async delete(key, scope): Promise<void> {
      // 服务端对不存在的键同样返回成功（幂等），这里不再做前置 head。
      await client.call<unknown>("DeleteObject", { key: keyFor(key, scope) });
    },
    async presign(key, presignOptions, scope): Promise<string> {
      const signed = await createSignedUrl(keyFor(key, scope), SIGNED_URL_METHOD_GET, {
        ...(presignOptions?.expiresSeconds ? { expiresSeconds: presignOptions.expiresSeconds } : {})
      });
      return signed.url;
    },
    /**
     * 给出某个稳定键对应的 locator。
     *
     * 前缀里的后端 id 是本部署的存储后端：别人据此把字节交回来解析，而不是自己拼路径。
     */
    async locatorOf(key, scope): Promise<MediaLocator | undefined> {
      return `media://${SERVER_STORAGE_BACKEND_ID}/${keyFor(key, scope)}`;
    },
    /**
     * 按 locator 读字节：locator 里已经是物理键，不再拼画布前缀。
     */
    async readLocator(locator): Promise<StorageObject> {
      const prefix = `media://${SERVER_STORAGE_BACKEND_ID}/`;
      if (!locator.startsWith(prefix)) {
        throw new ServerStorageCallError("invalid-response", 0, "不是本部署存储的 locator");
      }
      return readStored(locator.slice(prefix.length), locator.slice(prefix.length));
    },
  };

  return backend;
}

/** 从 HeadObject 兜底读 contentType（仅在签名地址响应缺 Content-Type 时用）。 */
async function readRemoteContentType(client: ServerStorageClient, key: string): Promise<string | undefined> {
  try {
    const response = await client.call<unknown>("HeadObject", { key });
    return readString(readField(response, "info"), "contentType") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把 `Response.body` 变成 AsyncIterable。
 *
 * `release` 在「读完」和「调用方提前 break / cancel」两种情况下都会跑：前者只是关掉底层请求的
 * 剩余生命周期，后者必须真的 abort（否则服务端继续往一个没人读的连接里传字节）。
 */
function readResponseStream(response: Response, release: () => void): AsyncIterable<Uint8Array> {
  return (async function* () {
    const body = response.body;
    if (!body) return;
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value && value.byteLength > 0) yield value;
      }
    } finally {
      release();
      reader.releaseLock();
    }
  })();
}

function readField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return null;
  return (value as Record<string, unknown>)[key] ?? null;
}

function readString(value: unknown, key: string): string | null {
  const raw = readField(value, key);
  return typeof raw === "string" && raw !== "" ? raw : null;
}

/** 便于测试构造：把会话直接包成客户端的会话来源（不触发真实登录）。 */
export function staticSessionSource(session: RemoteSession | null): ServerStorageSessionSource {
  return {
    async ensure(): Promise<EnsureSessionResult> {
      return session ? { ok: true, session } : { ok: false, code: "unauthenticated" };
    },
    async invalidate() {
      // 静态会话不参与换发：测试用它表达「会话是给定的」。
    }
  };
}
