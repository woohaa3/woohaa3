/**
 * Application extension API：HTTP helper（URL/header/JSON/超时）
 * （自 `extension-api.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R15）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { WOOHAA3_PROTOCOL_VERSION, type ApplicationExtensionErrorCode } from "@woohaa3/contracts";

export function safeUrl(raw: string | undefined): URL | null {
  try {
    return new URL(raw ?? "/", "http://localhost");
  } catch {
    return null;
  }
}

export function headerValue(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function sendError(res: ServerResponse, status: number, code: ApplicationExtensionErrorCode, message: string): void {
  sendJson(res, status, { code, message, protocolVersion: WOOHAA3_PROTOCOL_VERSION });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.end(payload);
}

export async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        reject(new Error("payload-too-large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text === "") return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(null);
      }
    });
    req.on("error", reject);
  });
}

export async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        reject(new Error("payload-too-large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller?: AbortController): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller?.abort();
      reject(new Error("handler-timeout"));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
