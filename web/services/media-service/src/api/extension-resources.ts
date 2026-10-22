import type { IncomingMessage, ServerResponse } from "node:http";
import type { MediaStorage } from "@woohaa3/contracts";
import { createExtensionMediaResources, ExtensionResourceError } from "../application/extension-resources.js";
import { decodeCanvasScope } from "../application/media-scope.js";

export async function handleExtensionResources(req: IncomingMessage, res: ServerResponse, storage: MediaStorage, write: boolean): Promise<boolean> {
  const send = (status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
    return true;
  };
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 24 * 1024 * 1024) return send(413, { code: "limit-exceeded", message: "媒体数据超限" });
      chunks.push(bytes);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    if (typeof body.extensionId !== "string" || !/^[a-z][a-z0-9-]{0,127}$/.test(body.extensionId)) return send(400, { code: "malformed-request", message: "插件身份非法" });
    // 画布作用域：body 由本 handler 自己读取（上限 24 MiB，比内部 JSON 路由大），所以在这里用
    // 与 verify/sign/import 相同的 `decodeCanvasScope` 口径解码，而不是在 internal-handler 预读。
    // 非法 id 直接 400，不能静默丢弃 —— 否则调用方会以为字节写到了画布后端。
    const scope = decodeCanvasScope(body.canvasId);
    if (!scope.ok) return send(400, { code: "malformed-request", message: scope.message });
    const canvasId = scope.scope?.canvasId;
    const resources = createExtensionMediaResources(storage);
    if (!write) {
      const object = await resources.read(body.storageKey as string, canvasId);
      return send(200, { bytesBase64: Buffer.from(object.bytes).toString("base64"), contentType: object.contentType });
    }
    if (typeof body.contentType !== "string" || typeof body.bytesBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.bytesBase64)) return send(400, { code: "malformed-request", message: "媒体类型或字节非法" });
    return send(200, await resources.write({
      bytes: Buffer.from(body.bytesBase64, "base64"),
      contentType: body.contentType,
      ...(canvasId !== undefined ? { canvasId } : {})
    }));
  } catch (error) {
    if (error instanceof ExtensionResourceError) return send(error.status, { code: error.code, message: error.message });
    return send((error as { code?: string }).code === "MEDIA_OBJECT_NOT_FOUND" ? 404 : 400, { code: "storage-failed", message: "稳定资源读写失败" });
  }
}
