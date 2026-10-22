/**
 * 游戏炼丹炉本站隔离预览（只读会话、响应级 CSP sandbox）
 * （change: 2026-10-10-add-game-furnace-extension，任务 8 / design D12）。
 *
 * 纯 Node 内存实现：不接触 COS 凭据、不读取任意 storageKey，只按 build manifest 提供入口与
 * 已登记资源。会话短期、只读、不可写；token 只在运行态，不进入 canonical 或源码包。
 * 响应带 CSP sandbox + nosniff + no-store，直接打开预览 URL 仍隔离。
 */
import { decodeSourcePackage, type GameSourcePackage } from "../../state/shared/package.js";
import { randomBytes } from "node:crypto";
import { safeSitePath } from "../../state/shared/site-contract.js";
import type { GamePreviewHost, GamePreviewSession } from "../../state/backend/preview-port.js";

export const GAME_SITE_BASE = "/api/extensions/game-furnace/site";

export type { GamePreviewHost, GamePreviewSession } from "../../state/backend/preview-port.js";

/** 预览 HTML 响应头：sandbox/CSP、nosniff、禁止缓存、referrer 策略。 */
export const PREVIEW_HTML_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": [
    "sandbox allow-scripts",
    "default-src 'none'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store"
};

export const PREVIEW_ASSET_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store"
};

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 16;

export function createGamePreviewHost(now: () => number = () => Date.now()): GamePreviewHost {
  const sessions = new Map<string, GamePreviewSession>();

  const sweep = (): void => {
    const current = now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= current) sessions.delete(id);
    }
  };

  const registerSession: GamePreviewHost["registerSession"] = ({ manifest, html, resources, files: siteFiles, ttlMs }) => {
    sweep();
    if (sessions.size >= MAX_SESSIONS) {
      // 容量上限：驱逐最早到期者，保证有界。
      const oldest = [...sessions.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (oldest) sessions.delete(oldest[0]);
    }
    const sessionId = randomBytes(32).toString("hex");
    const files = new Map<string, { bytes: Uint8Array; contentType: string }>(siteFiles);
    if (!files.has("index.html")) files.set("index.html", { bytes: new TextEncoder().encode(html), contentType: "text/html; charset=utf-8" });
    // 只登记 manifest 显式声明的资源路径；路径是确定相对路径，不能穿越。
    for (const entry of manifest.resources) {
      const asset = resources.get(entry.assetId);
      if (asset) files.set(entry.path, asset);
    }
    const session: GamePreviewSession = {
      sessionId,
      buildId: manifest.buildId,
      sourceHash: manifest.sourceHash,
      policyVersion: manifest.policyVersion,
      expiresAt: now() + (ttlMs ?? DEFAULT_TTL_MS),
      files
    };
    sessions.set(sessionId, session);
    return { sessionId, expiresAt: session.expiresAt };
  };

  const resolve: GamePreviewHost["resolve"] = (sessionId, path) => {
    const session = sessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= now()) {
      sessions.delete(sessionId);
      return null;
    }
    // 严格按 manifest 解析：拒绝路径穿越、绝对路径、查询/片段与未登记 key。
    if (typeof path !== "string" || !safeSitePath(path) || path.includes("..")) {
      return null;
    }
    const file = session.files.get(path);
    if (!file) return null;
    const isHtml = path === "index.html";
    return { bytes: file.bytes, contentType: file.contentType, headers: isHtml ? { ...PREVIEW_HTML_HEADERS } : { ...PREVIEW_ASSET_HEADERS, "Content-Type": /^(?:text\/|application\/json)/.test(file.contentType) && !file.contentType.includes("charset") ? `${file.contentType}; charset=utf-8` : file.contentType, "Access-Control-Allow-Origin": "*" } };
  };

  return {
    registerSession,
    resolve,
    describe(sessionId) {
      const session = sessions.get(sessionId);
      if (!session || session.expiresAt <= now()) return null;
      const htmlFile = session.files.get("index.html");
      if (!htmlFile) return null;
      const assets: { path: string; dataUrl: string }[] = [];
      for (const [path, file] of session.files) {
        if (path === "index.html") continue;
        assets.push({ path, dataUrl: `data:${file.contentType};base64,${base64FromBytes(file.bytes)}` });
      }
      return { html: new TextDecoder().decode(htmlFile.bytes), assets };
    },
    revoke(sessionId) {
      sessions.delete(sessionId);
    },
    sweeper: () => {
      const timer = setInterval(sweep, 60 * 1000);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    dispose() {
      sessions.clear();
    }
  };
}

/** 从源码包字节重建预览所需的 html + 资源（供 finalize/preview handler 复用）。 */
export function readSourcePackageForPreview(bytes: Uint8Array): GameSourcePackage | null {
  try {
    const pkg = decodeSourcePackage(bytes);
    return pkg;
  } catch {
    return null;
  }
}

function base64FromBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
