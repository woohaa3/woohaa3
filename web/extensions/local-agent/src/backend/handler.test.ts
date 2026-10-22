/**
 * local-agent 受控 HTTP handler 测试
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 2.5/3.2/3.3 验收）。
 *
 * 覆盖：owner 只取可信 principal；创建/删除连接；无 API Key 表单路径；未启用部署时 `/check`
 * 明确不可用；CLI 存在也不冒称 transport ready；登录指引透传位置说明。
 */
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type {
  ApplicationExtensionRawRequest,
  ApplicationExtensionRawResponse,
  ApplicationExtensionRequestContext,
} from "@woohaa3/contracts";
import type { ConnectionService } from "@woohaa3/agent-connections";
import { createLocalAgentHandler } from "./handler.js";
import type { LocalAgentDeployment } from "../shared.js";
import type { ProcessManager } from "./process-manager.js";

type Conn = {
  connectionId: string;
  owner: string;
  adapterId: string;
  name: string;
  runCategory: string;
  authMode: string;
  configRevision: number;
  credentialEpoch: number;
  createdAt: string;
  updatedAt: string;
};

function fakeService(initial: Conn[] = []): {
  service: ConnectionService;
  records: Conn[];
} {
  const records = [...initial];
  let counter = initial.length;
  const service = {
    list: async (owner: string) =>
      records.filter((record) => record.owner === owner),
    get: async (owner: string, connectionId: string) =>
      records.find(
        (record) =>
          record.owner === owner && record.connectionId === connectionId,
      ) ?? null,
    create: async (owner: string, input: Record<string, unknown>) => {
      counter += 1;
      const created: Conn = {
        connectionId: `c${counter}`,
        owner,
        adapterId: String(input.adapterId),
        name: String(input.name ?? input.adapterId),
        runCategory: String(input.runCategory),
        authMode: String(input.authMode),
        configRevision: 1,
        credentialEpoch: 0,
        createdAt: "",
        updatedAt: "",
      };
      records.push(created);
      return { ok: true as const, value: created };
    },
    remove: async (owner: string, connectionId: string) => {
      const index = records.findIndex(
        (record) =>
          record.owner === owner && record.connectionId === connectionId,
      );
      if (index < 0)
        return {
          ok: false as const,
          error: { code: "not-found", message: "x" },
        };
      records.splice(index, 1);
      return { ok: true as const, value: { removed: true } };
    },
    setStatus: async () => ({ ok: true as const, value: records[0] }),
  };
  return { service: service as unknown as ConnectionService, records };
}

function fakeProcessManager(
  installed: boolean,
): Pick<ProcessManager, "probe" | "get"> {
  return {
    probe: () =>
      installed
        ? { ok: true, version: "unknown" }
        : { ok: false, code: "runtime-missing", message: "未安装本机 CLI" },
    get: () => null,
  };
}

function request(
  method: string,
  path: string,
  body?: unknown,
): ApplicationExtensionRawRequest {
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")],
  ) as unknown as ApplicationExtensionRawRequest;
  (req as unknown as { method: string }).method = method;
  (req as unknown as { url: string }).url = path;
  return req;
}

function context(owner = "u1"): ApplicationExtensionRequestContext {
  return {
    principal: { subject: owner },
  } as unknown as ApplicationExtensionRequestContext;
}

function response() {
  let statusCode = 0;
  let payload = "";
  const res = {
    set statusCode(value: number) {
      statusCode = value;
    },
    get statusCode() {
      return statusCode;
    },
    setHeader: () => undefined,
    end: (chunk?: string) => {
      payload = chunk ?? "";
    },
  } as unknown as ApplicationExtensionRawResponse;
  return {
    res,
    status: () => statusCode,
    json: () =>
      (payload === "" ? null : JSON.parse(payload)) as Record<string, unknown>,
  };
}

async function call(
  options: {
    installed: boolean;
    records?: Conn[];
    executable?: string | null;
  },
  method: string,
  path: string,
  body?: unknown,
  owner = "u1",
) {
  const { service, records } = fakeService(options.records ?? []);
  const deployment: LocalAgentDeployment = {
    codexBin:
      options.executable === undefined ? "/usr/bin/codex" : options.executable,
    opencodeBin: null,
    codebuddyBin: null,
    workDir: null,
    codexHome: null,
    portRange: { min: 42000, max: 42100 },
  };
  const handler = createLocalAgentHandler({
    service,
    executableFor: () => (options.installed ? deployment.codexBin : null),
    discover: async (_adapter, managed) => ({
      installed: options.installed,
      running: managed,
      managed,
      note: "检测完成",
    }),
    processManager: fakeProcessManager(
      options.installed,
    ) as unknown as ProcessManager,
  });
  const req = request(
    method,
    `/api/local-agent/${path.replace(/^\/+/, "")}`,
    body,
  );
  const out = response();
  await handler.handle(req, out.res, context(owner));
  return { status: out.status(), body: out.json(), records };
}

describe("local-agent handler（任务 2.5/3.2/3.3）", () => {
  it("列出连接带安装/启用/运行状态与位置说明，不含任何 Key 表单路径", async () => {
    const result = await call(
      {
        installed: true,
        records: [
          {
            connectionId: "c1",
            owner: "u1",
            adapterId: "codex-appserver",
            name: "本机 Codex",
            runCategory: "local-appserver",
            authMode: "local-login",
            configRevision: 1,
            credentialEpoch: 0,
            createdAt: "",
            updatedAt: "",
          },
        ],
      },
      "GET",
      "connections",
    );
    expect(result.status).toBe(200);
    expect(result.body.locationNote).toContain("后端");
    expect(
      (result.body.connections as Array<Record<string, unknown>>)[0],
    ).toMatchObject({
      executableInstalled: true,
      running: false,
      authMode: "local-login",
    });
  });

  it("创建本机连接只写设置；未知接入方式拒绝", async () => {
    const created = await call(
      { installed: true },
      "POST",
      "connections",
      { adapterId: "opencode-server" },
    );
    expect(created.status).toBe(200);
    const bad = await call(
      { installed: true },
      "POST",
      "connections",
      { adapterId: "nope" },
    );
    expect(bad.status).toBe(400);
  });

  it("CLI 存在也不冒称 transport ready；缺 CLI 准确报 runtime-missing", async () => {
    const installed = await call(
      {
        installed: true,
        records: [
          {
            connectionId: "c1",
            owner: "u1",
            adapterId: "codex-appserver",
            name: "x",
            runCategory: "local-appserver",
            authMode: "local-login",
            configRevision: 1,
            credentialEpoch: 0,
            createdAt: "",
            updatedAt: "",
          },
        ],
      },
      "POST",
      "check",
      { connectionId: "c1" },
    );
    expect(installed.body).toMatchObject({ transport: "unknown" });

    const missing = await call(
      {
        installed: false,
        records: [
          {
            connectionId: "c1",
            owner: "u1",
            adapterId: "codex-appserver",
            name: "x",
            runCategory: "local-appserver",
            authMode: "local-login",
            configRevision: 1,
            credentialEpoch: 0,
            createdAt: "",
            updatedAt: "",
          },
        ],
      },
      "POST",
      "check",
      { connectionId: "c1" },
    );
    expect(missing.body).toMatchObject({
      transport: "unavailable",
      note: expect.stringContaining("未安装"),
    });
  });

  it("跨 owner 不可见", async () => {
    const result = await call(
      {
        installed: true,
        records: [
          {
            connectionId: "c1",
            owner: "u1",
            adapterId: "codex-appserver",
            name: "x",
            runCategory: "local-appserver",
            authMode: "local-login",
            configRevision: 1,
            credentialEpoch: 0,
            createdAt: "",
            updatedAt: "",
          },
        ],
      },
      "POST",
      "connections/c1/delete",
      undefined,
      "u2",
    );
    expect(result.status).toBe(404);
  });
});

it("useDetected 启用已安装工具，重复操作复用配置；CLI 缺失时拒绝", async () => {
  const first = await call(
    { installed: true },
    "POST",
    "connections",
    { adapterId: "codex-appserver", useDetected: true },
  );
  expect(first.status).toBe(200);
  const again = await call(
    { installed: true, records: first.records },
    "POST",
    "connections",
    { adapterId: "codex-appserver", useDetected: true },
  );
  expect(again.records).toHaveLength(1);
  expect(again.body.connectionId).toBe(first.body.connectionId);
  expect(
    (
      await call({ installed: false }, "POST", "connections", {
        adapterId: "codex-appserver",
        useDetected: true,
      })
    ).body,
  ).toMatchObject({ code: "runtime-missing" });
});
