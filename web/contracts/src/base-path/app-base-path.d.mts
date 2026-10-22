/**
 * `app-base-path.mjs` 的类型声明（Node 脚本与 TS 单元共用的唯一挂载路径契约）。
 */
export declare const APP_BASE_PATH_ENV: "WOOHAA3_BASE_PATH";
export declare const APP_BASE_PATH_META: "woohaa-app-base-path";
export declare const APP_BASE_PATH_MAX_LENGTH: 256;

export type AppBasePathNormalization =
  | { ok: true; basePath: string }
  | { ok: false; error: string };

export declare function normalizeAppBasePath(raw: unknown): AppBasePathNormalization;
export declare function isRootAppBasePath(basePath: string): boolean;
export declare function appBasePathPrefix(basePath: string): string;
export declare function addAppBasePath(basePath: string, logicalPath: string): string;
export declare function stripAppBasePath(basePath: string, pathname: string): string | null;

export type AppBasePathMatch =
  | { kind: "inside"; logicalPath: string }
  | { kind: "entry"; location: string }
  | { kind: "outside" };

export declare function matchAppBasePath(basePath: string, pathname: string): AppBasePathMatch;

export type AppPathMountDecision =
  | { action: "outside" }
  | { action: "invalid" }
  | { action: "redirect"; location: string }
  | { action: "forward"; url: string; pathname: string; search: string };

export declare function decideAppPathMount(basePath: string, rawUrl: string | undefined): AppPathMountDecision;
export declare function isSafeAppRequestPath(pathname: string): boolean;
