/**
 * local-agent 连接设置 remote adapter（extension 前端 owner）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 2.5/3.3 / design D4/D5）。
 *
 * 浏览器访问 `/api/local-agent/*` 的唯一出口，复用宿主注入的 `ApplicationRemoteTransport`。
 * 本机来源不涉及 API Key；只做连接列表/创建/删除与运行依赖探测。
 */
import type { ApplicationRemoteTransport } from "@woohaa3/frontend/extension-api";

export type LocalAgentConnectionView = {
  connectionId: string;
  adapterId: string;
  name: string;
  label: string;
  runCategory: string;
  authMode: string;
  configRevision: number;
  requiresLocalLogin: boolean;
  executableInstalled: boolean;
  running: boolean;
  lastStatus?: unknown;
};

export type LocalAgentAdapterView = {
  adapterId: string;
  label: string;
  transport: string;
  requiresLocalLogin: boolean;
  supportedVersions: string;
  installed?: boolean;
  running?: boolean;
  managed?: boolean;
  endpoint?: string;
  version?: string;
  note?: string;
};

export type LocalAgentRemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code?: string };

export type LocalAgentRemote = {
  list: () => Promise<
    LocalAgentRemoteResult<{
      connections: LocalAgentConnectionView[];
      adapters: LocalAgentAdapterView[];
      locationNote: string;
    }>
  >;
  create: (input: {
    adapterId: string;
    useDetected?: boolean;
    name?: string;
    models?: string[];
  }) => Promise<LocalAgentRemoteResult<{ connectionId: string }>>;
  remove: (
    connectionId: string,
  ) => Promise<LocalAgentRemoteResult<{ removed: boolean }>>;
  check: (
    connectionId: string,
  ) => Promise<
    LocalAgentRemoteResult<{
      transport: string;
      credential: string;
      modelAccess: string;
      tools: string;
      note: string;
    }>
  >;
};

export function createLocalAgentRemote(options: {
  transport: ApplicationRemoteTransport;
  basePath?: string;
}): LocalAgentRemote {
  const basePath = (options.basePath ?? "/api/local-agent").replace(/\/$/, "");
  const transport = options.transport;
  const path = (suffix: string) => `${basePath}/${suffix}`;
  const fail = (
    result: { error: string; code?: string },
    fallback: string,
  ): LocalAgentRemoteResult<never> => ({
    ok: false,
    error: result.error !== "" ? result.error : fallback,
    ...(result.code ? { code: result.code } : {}),
  });
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  return {
    async list() {
      const result = await transport.request({
        path: path("connections"),
        method: "GET",
      });
      if (!result.ok) return fail(result, "无法读取本机连接");
      if (!isRecord(result.data) || !Array.isArray(result.data.connections))
        return { ok: false, error: "连接响应无法识别" };
      return {
        ok: true,
        value: {
          connections: result.data.connections as LocalAgentConnectionView[],
          adapters: (Array.isArray(result.data.adapters)
            ? result.data.adapters
            : []) as LocalAgentAdapterView[],
          locationNote:
            typeof result.data.locationNote === "string"
              ? result.data.locationNote
              : "",
        },
      };
    },
    async create(input) {
      const result = await transport.request({
        path: path("connections"),
        method: "POST",
        body: input,
      });
      if (!result.ok) return fail(result, "创建本机连接失败");
      if (
        !isRecord(result.data) ||
        typeof result.data.connectionId !== "string"
      )
        return { ok: false, error: "创建响应无法识别" };
      return { ok: true, value: { connectionId: result.data.connectionId } };
    },
    async remove(connectionId) {
      const result = await transport.request({
        path: path(`connections/${encodeURIComponent(connectionId)}/delete`),
        method: "POST",
        body: {},
      });
      if (!result.ok) return fail(result, "删除本机连接失败");
      return { ok: true, value: { removed: true } };
    },
    async check(connectionId) {
      const result = await transport.request({
        path: path("check"),
        method: "POST",
        body: { connectionId },
      });
      if (!result.ok) return fail(result, "本机依赖探测失败");
      if (!isRecord(result.data))
        return { ok: false, error: "探测响应无法识别" };
      return {
        ok: true,
        value: result.data as unknown as {
          transport: string;
          credential: string;
          modelAccess: string;
          tools: string;
          note: string;
        },
      };
    },
  };
}
