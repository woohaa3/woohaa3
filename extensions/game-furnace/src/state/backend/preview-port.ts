import type { GamePackageManifest } from "../shared/package.js";

export type GamePreviewSession = {
  sessionId: string;
  buildId: string;
  sourceHash: string;
  policyVersion: string;
  expiresAt: number;
  files: Map<string, { bytes: Uint8Array; contentType: string }>;
};

export type GamePreviewHost = {
  registerSession(input: { projectKey: string; manifest: GamePackageManifest; html: string; resources: Map<string, { bytes: Uint8Array; contentType: string }>; files?: Map<string, { bytes: Uint8Array; contentType: string }>; ttlMs?: number }): { sessionId: string; expiresAt: number };
  /** 按 manifest 解析入口/资源；返回 null 表示未授权/越界/失效。 */
  resolve(sessionId: string, path: string): { bytes: Uint8Array; contentType: string; headers: Record<string, string> } | null;
  /** 供工作区 iframe 组装：入口 HTML + 授权资源（data URL，隔离沙箱内使用，不写 canonical）。 */
  describe(sessionId: string): { html: string; assets: { path: string; dataUrl: string }[] } | null;
  revoke(sessionId: string): void;
  sweeper(): () => void;
  dispose(): void;
};
