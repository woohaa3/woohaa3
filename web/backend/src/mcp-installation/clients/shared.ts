/** 注册表规格共用的路径、检测证据与条目形状辅助；规格模块本身保持无副作用。 */
import path from "node:path";
import type { DetectEvidence, InstallTarget, McpConfigFormat, RemoteEntryShape, SpecContext } from "./types.js";

export const inHome = (home: string, ...parts: string[]) => path.join(home, ...parts);

/** 用户配置根：XDG_CONFIG_HOME / %APPDATA%（Windows）/ ~/.config。 */
export function configRoot(ctx: Pick<SpecContext, "env" | "home" | "platform">) {
  const { env, home, platform } = ctx;
  return env.XDG_CONFIG_HOME?.trim() || (platform === "win32" ? env.APPDATA?.trim() || inHome(home, "AppData", "Roaming") : inHome(home, ".config"));
}

export const executable = (...names: string[]): DetectEvidence => ({ kind: "executable", names });
export const app = (...names: string[]): DetectEvidence => ({ kind: "app", names });
export const files = (paths: (ctx: SpecContext) => readonly string[] | Promise<readonly string[]>): DetectEvidence => ({ kind: "file", paths });
export const targets: DetectEvidence = { kind: "targets" };

/** 单目标客户端的通用目标：用户级配置文件。 */
export const target = (path: string, format: McpConfigFormat, label = "用户配置"): InstallTarget => ({ key: "default", label, path, format });

export function entry(options: {
  container: string[];
  urlField?: string;
  fields: (url: string) => Record<string, unknown>;
  array?: boolean;
  remoteType?: string;
}): RemoteEntryShape {
  const { container, urlField = "url", fields, array, remoteType } = options;
  return {
    container,
    urlField,
    fields,
    ...(array ? { array: true } : {}),
    ...(remoteType ? { remoteMarker: { field: "type", values: [remoteType] } } : {}),
  };
}
