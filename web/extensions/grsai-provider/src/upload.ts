/**
 * grsai 参考素材上传（Provider 自带上传，凭据不出插件）。
 *
 * 两步：先用 Key 换上传令牌，再把字节 POST 到令牌给出的对象存储地址，返回可直接进
 * `urls` 的公网地址。第二步的目标地址来自 grsai 自己的响应，但仍按受控规则校验
 * （只允许公网 https，拒绝回环/私网）后再发。
 */
import { assertPublicHttpsUrl } from "@woohaa3/provider-sdk";
import { GRSAI_UPLOAD_TOKEN_PATH } from "./shared.js";

export type GrsaiUploadInput = {
  origin: string;
  apiKey: string;
  bytes: Uint8Array;
  contentType: string;
  filename?: string;
  /** 受控 fetch：只用于可信 origin 上的令牌请求。 */
  tokenFetch: typeof globalThis.fetch;
  /** 原始 fetch：只用于已校验过的上传目标。 */
  uploadFetch: typeof globalThis.fetch;
};

export async function uploadGrsaiReference(input: GrsaiUploadInput): Promise<string> {
  const extension = extensionOf(input.contentType, input.filename);
  const tokenResponse = await input.tokenFetch(`${input.origin}${GRSAI_UPLOAD_TOKEN_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
    body: JSON.stringify({ sux: extension })
  });
  if (!tokenResponse.ok) throw new Error(`grsai 上传令牌请求失败（HTTP ${tokenResponse.status}）`);
  const payload = (await tokenResponse.json()) as { data?: Record<string, unknown> } | null;
  const data = payload?.data;
  const url = typeof data?.url === "string" ? data.url : "";
  const token = typeof data?.token === "string" ? data.token : "";
  const key = typeof data?.key === "string" ? data.key : "";
  const domain = typeof data?.domain === "string" ? data.domain : "";
  if (!url || !token || !key || !domain) throw new Error("grsai 上传令牌响应不完整");

  const target = assertPublicHttpsUrl(url);
  const form = new FormData();
  form.append("token", token);
  form.append("key", key);
  // 复制一份独立的 Uint8Array：BlobPart 不接受共享缓冲视图。
  const bytes = new Uint8Array(input.bytes);
  form.append("file", new Blob([bytes], { type: input.contentType }), input.filename ?? `upload.${extension}`);
  const response = await input.uploadFetch(target, { method: "POST", body: form });
  if (!response.ok) throw new Error(`grsai 参考图上传失败（HTTP ${response.status}）`);
  return `${domain.replace(/\/+$/, "")}/${key.replace(/^\/+/, "")}`;
}

function extensionOf(contentType: string, filename?: string): string {
  const fromName = filename?.includes(".") ? filename.split(".").pop() ?? "" : "";
  if (/^[A-Za-z0-9]{2,5}$/.test(fromName)) return fromName.toLowerCase();
  const media = contentType.toLowerCase();
  if (media.includes("jpeg") || media.includes("jpg")) return "jpg";
  if (media.includes("webp")) return "webp";
  if (media.includes("gif")) return "gif";
  return "png";
}
