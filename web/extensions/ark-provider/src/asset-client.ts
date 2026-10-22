/** Ark 素材库 OpenAPI 的请求签名与资产调用。 */
import { createHash, createHmac } from "node:crypto";

const MAX_ASSET_NAME_CHARACTERS = 64;

export type VolcengineAssetClientOptions = {
  accessKeyId: string;
  secretAccessKey: string;
  groupId: string;
  projectName: string;
  region: string;
  service: string;
  endpoint: string;
  fetch?: typeof fetch;
  now?: () => Date;
};

export type VolcengineAssetStatus = {
  assetId: string;
  status?: string;
};

export function createVolcengineAssetClient(options: VolcengineAssetClientOptions) {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());

  const request = async (action: "CreateAsset" | "GetAsset", body: Record<string, unknown>, idempotencyKey?: string, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const endpoint = new URL(options.endpoint);
    endpoint.search = "";
    endpoint.searchParams.set("Action", action);
    endpoint.searchParams.set("Version", "2024-01-01");
    const payload = JSON.stringify(body);
    const date = now();
    const xDate = formatDate(date);
    const shortDate = xDate.slice(0, 8);
    const payloadHash = sha256(payload);
    const host = endpoint.host;
    // Volcengine's OpenAPI signer treats content-type as an unsignable header.
    // It must still be sent, but including it in SignedHeaders changes the
    // canonical request and causes a signature mismatch.
    const canonicalHeaders = `host:${host}\nx-content-sha256:${payloadHash}\nx-date:${xDate}\n`;
    const signedHeaders = "host;x-content-sha256;x-date";
    const canonicalRequest = [
      "POST",
      endpoint.pathname || "/",
      canonicalQuery(endpoint.searchParams),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const credentialScope = `${shortDate}/${options.region}/${options.service}/request`;
    const stringToSign = [
      "HMAC-SHA256",
      xDate,
      credentialScope,
      sha256(canonicalRequest),
    ].join("\n");
    const signingKey = hmac(
      hmac(hmac(hmac(options.secretAccessKey, shortDate), options.region), options.service),
      "request",
    );
    const signature = hmacHex(signingKey, stringToSign);
    const response = await fetcher(endpoint, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Host: host,
        "X-Content-Sha256": payloadHash,
        "X-Date": xDate,
        Authorization: `HMAC-SHA256 Credential=${options.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        ...(idempotencyKey ? { "X-Idempotency-Key": idempotencyKey } : {}),
      },
      body: payload,
    });
    const text = await response.text();
    let parsed: unknown = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
    if (!response.ok) {
      throw new Error(`火山素材库 ${action} 失败（HTTP ${response.status}）：${readError(parsed) || text || "未知错误"}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`火山素材库 ${action} 返回了无效响应`);
    }
    const record = parsed as Record<string, unknown>;
    const error = readError(record);
    if (error) throw new Error(`火山素材库 ${action} 失败：${error}`);
    return record;
  };

  return {
    async createImageAsset(input: { url: string; name: string; idempotencyKey?: string; signal?: AbortSignal }): Promise<string> {
      const response = await request("CreateAsset", {
        GroupId: options.groupId,
        AssetType: "Image",
        URL: input.url,
        ProjectName: options.projectName,
        Name: normalizeAssetName(input.name),
      }, input.idempotencyKey, input.signal);
      const assetId = readString(response, ["Result.Id", "Id", "result.id", "Data.Id", "Result.AssetId", "Result.AssetID", "result.assetId", "Data.AssetId"]);
      if (!assetId) throw new Error("火山素材库 CreateAsset 未返回素材 Id");
      return assetId;
    },

    async getAsset(assetId: string, signal?: AbortSignal): Promise<VolcengineAssetStatus> {
      const response = await request("GetAsset", { Id: assetId, ProjectName: options.projectName }, undefined, signal);
      const returnedId = readString(response, ["Result.Id", "Id", "result.id", "Data.Id", "Result.AssetId", "Result.AssetID", "result.assetId", "Data.AssetId"]) || assetId;
      return {
        assetId: returnedId,
        status: readString(response, ["Result.Status", "Status", "result.status", "Data.Status"]),
      };
    },
  };
}

export type VolcengineAssetClient = ReturnType<typeof createVolcengineAssetClient>;

function normalizeAssetName(value: string): string {
  const name = value.trim() || "asset";
  const characters = Array.from(name);
  if (characters.length <= MAX_ASSET_NAME_CHARACTERS) return name;

  const extensionStart = name.lastIndexOf(".");
  const extension = extensionStart > 0 ? Array.from(name.slice(extensionStart)) : [];
  if (extension.length < MAX_ASSET_NAME_CHARACTERS) {
    return `${characters.slice(0, MAX_ASSET_NAME_CHARACTERS - extension.length).join("")}${extension.join("")}`;
  }
  return characters.slice(0, MAX_ASSET_NAME_CHARACTERS).join("");
}

function formatDate(value: Date): string {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${uriEncode(key)}=${uriEncode(value)}`)
    .join("&");
}

function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: string | Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function readString(input: Record<string, unknown>, paths: string[]): string | undefined {
  for (const path of paths) {
    let value: unknown = input;
    for (const part of path.split(".")) value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readError(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  return readString(record, ["ResponseMetadata.Error.Message", "ResponseMetadata.Error.Code", "error.message", "Error.Message", "Error.Code"])
    || (typeof record.message === "string" ? record.message : undefined);
}
