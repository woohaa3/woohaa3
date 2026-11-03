/**
 * 参考图上传：把字节传到 ppserver 自己的 `/media/upload`，拿回云端读得到的公网地址。
 *
 * 为什么需要：画布里的参考图在宿主本机存储里，地址是 `/api/media/<key>` 这类本机相对路径，
 * 云上的 ppserver 读不到。PS 插件的做法（`uploadProvider: 'media'`）是先上传、再把返回的
 * 公网地址写进表单字段；这里与它同一协议：
 * - `POST <ppserver origin>/media/upload`，`Authorization: Bearer <access_token>`；
 * - 请求体是**原始字节**（Content-Type 为图片类型），不是 multipart；
 * - 响应是 JSON（`url` / `fileUrl` / `file_url`，可嵌在 `data` 或 `result` 下）或纯文本 URL。
 *
 * 不走 `createGuardedFetch`：它只放行 image/video 响应，而上传响应是 JSON。
 */
import { ppserverOrigin } from "./shared.js";

export type PpserverUploadOptions = {
  baseUrl: string;
  /** 令牌，或每次现取令牌的函数（续期会换掉令牌，别在构造时固定）。 */
  accessToken: string | (() => Promise<string>);
  bytes: Uint8Array;
  contentType: string;
  fetchImpl?: typeof globalThis.fetch;
  signal?: AbortSignal;
};

const KEYS = ["url", "fileUrl", "file_url"] as const;

function extractUrl(payload: unknown): string | undefined {
  if (typeof payload === "string") {
    const value = payload.trim();
    return /^https?:\/\//i.test(value) ? value : undefined;
  }
  if (payload === null || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return extractUrl(record.data) ?? extractUrl(record.result);
}

/** 失败返回 undefined（调用方回落到存储签名）；原因不带令牌。 */
export async function uploadPpserverReference(options: PpserverUploadOptions): Promise<string | undefined> {
  if (options.bytes.byteLength === 0) return undefined;
  const token = (typeof options.accessToken === "function" ? await options.accessToken() : options.accessToken).trim();
  if (token === "") return undefined;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const response = await doFetch(`${ppserverOrigin(options.baseUrl)}/media/upload`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": options.contentType !== "" ? options.contentType : "application/octet-stream"
    },
    body: options.bytes as unknown as BodyInit,
    ...(options.signal ? { signal: options.signal } : {})
  });
  if (!response.ok) throw new Error(`ppserver media upload failed: HTTP ${response.status}`);
  const text = await response.text();
  let raw: unknown = text;
  try {
    raw = JSON.parse(text);
  } catch {
    // 纯文本 URL 也是合法响应。
  }
  return extractUrl(raw);
}
