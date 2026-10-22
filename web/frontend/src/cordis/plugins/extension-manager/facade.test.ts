/**
 * Plugin Manager facade：站点插件行带出「Provider 类插件」标记。
 *
 * Provider 类插件（声明了 `providers.<providerId>` 配置段）的启停跟配置走，插件清单据此把它们
 * 从站点插件里摘出去；标记来源是设置快照算出的插件 id 集合（由调用方注入）。
 */
import { describe, expect, it } from "vitest";
import type { ApplicationExtensionStatus } from "@woohaa3/contracts";
import { createExtensionManagerFacade } from "./facade.js";
import type { ApplicationExtensionStatusService } from "../../services/application-extension-status.js";
import type { ExtensionManagerFacadeOptions } from "./facade.js";

const idleStatus: ApplicationExtensionStatus = {
  extensionId: "ark-provider",
  desiredEnabled: false,
  actualState: "disabled",
  configVersion: null,
  extensionRevision: 1,
  activeWorkCount: 0,
  diagnostics: []
};

const statusService: ApplicationExtensionStatusService = {
  getSnapshot: () => ({ revision: 1, catalog: [], plugins: [], error: null, loading: false }),
  subscribe: () => () => undefined,
  refresh: async () => undefined,
  refreshChanges: async () => undefined,
  writeConfig: async () => ({ ok: true, revision: 1, status: idleStatus }),
  start: () => undefined,
  stop: () => undefined,
  dispose: () => undefined
};

function facadeWith(site: ExtensionManagerFacadeOptions["site"]) {
  const { facade } = createExtensionManagerFacade({
    catalog: [],
    ids: [],
    assembled: {},
    refresh: () => undefined,
    site: {
      metadata: [
        { extensionId: "ark-provider", name: "Ark Provider", description: "火山方舟视频生成 Provider" },
        { extensionId: "game-furnace", name: "游戏炼丹炉", description: "站点插件" }
      ],
      statusService,
      ...site
    }
  });
  return facade;
}

describe("Plugin Manager facade 的 Provider 标记", () => {
  it("设置快照算出的 Provider 插件在站点行上标为 providerManaged", () => {
    const facade = facadeWith({ providerExtensions: () => new Set(["ark-provider"]) });
    const rows = facade.siteRows();
    expect(rows.map((row) => [row.extensionId, row.providerManaged])).toEqual([
      ["ark-provider", true],
      ["game-furnace", false]
    ]);
  });

  it("没有 Provider 归属信息时（非管理员 / 尚未读到设置）全部按普通站点插件处理", () => {
    const facade = facadeWith({});
    expect(facade.siteRows().every((row) => row.providerManaged === false)).toBe(true);
  });
});

/**
 * `degraded` 是「已装载但能力没就绪」的稳态（生成 Provider 缺凭据），不是进行中的状态：
 * 开关必须保持可用，否则管理员在补上凭据前根本关不掉这个插件；诊断文案要带出来。
 */
describe("站点行 health=degraded", () => {
  it("降级运行不算 busy，并带出插件诊断", () => {
    const degraded: ApplicationExtensionStatus = {
      ...idleStatus,
      desiredEnabled: true,
      actualState: "degraded",
      configVersion: 1,
      diagnostics: [{ code: "provider-credentials-missing", message: "未配置 API Key，模型当前不可执行" }]
    };
    const service: ApplicationExtensionStatusService = {
      ...statusService,
      getSnapshot: () => ({ revision: 2, catalog: [], plugins: [degraded], error: null, loading: false })
    };
    const row = facadeWith({ statusService: service })
      .siteRows()
      .find((candidate) => candidate.extensionId === "ark-provider")!;
    expect(row).toMatchObject({
      actualState: "degraded",
      actualStateLabel: "降级运行",
      busy: false,
      diagnostics: ["未配置 API Key，模型当前不可执行"]
    });
  });
});
