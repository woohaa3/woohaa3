/**
 * Agent 授权/目录的 provider 适配测试
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 4.4/6.5）。
 *
 * 覆盖：决策来自注入的 CanvasAccessPort（不再是存在性放行）、空 principal 拒绝、provider 故障
 * fail closed、目录未注入/故障返回空。
 */
import { describe, expect, it, vi } from "vitest";
import type { PrincipalContext, ResourceDirectory } from "@woohaa3/contracts";
import { createPolicyBackedAuthorizer, createPolicyBackedDirectory, createDiscoverableCanvasIds, mergeDiscoverableIds, delegatedPrincipalContext } from "./policy-agent-access.js";
import type { CanvasAccessPort } from "./access-port.js";

function port(authorize: CanvasAccessPort["authorize"]): CanvasAccessPort {
  return { authorize };
}

describe("createPolicyBackedAuthorizer（任务 4.4/6.5）", () => {
  it("允许/拒绝都来自 ResourceAccessPolicy 决策，并携带 delegated principal", async () => {
    const seen: Array<{ principal: PrincipalContext; canvasId: string; permission: string }> = [];
    const access = port(async (input) => {
      seen.push(input);
      return input.canvasId === "c1" ? { allowed: true } : { allowed: false, code: "forbidden", message: "无权访问该画布" };
    });
    const authorizer = createPolicyBackedAuthorizer(access);

    expect(await authorizer.authorize({ principalId: "u1", canvasId: "c1", permission: "read" })).toEqual({ allowed: true });
    const denied = await authorizer.authorize({ principalId: "u1", canvasId: "c2", permission: "write" });
    expect(denied.allowed).toBe(false);
    expect(seen[0]!.principal).toMatchObject({ subject: "u1", identityProvider: "mcp-delegation" });
    expect(seen[0]!.canvasId).toBe("c1");
    expect(seen[0]!.permission).toBe("read");
  });

  it("空白 principal 直接拒绝（不查询策略）", async () => {
    const authorize = vi.fn(async () => ({ allowed: true as const }));
    const authorizer = createPolicyBackedAuthorizer(port(authorize));
    expect(await authorizer.authorize({ principalId: "  ", canvasId: "c1", permission: "read" })).toMatchObject({ allowed: false });
    expect(authorize).not.toHaveBeenCalled();
  });

  it("策略故障时 fail closed", async () => {
    const authorizer = createPolicyBackedAuthorizer(port(async () => {
      throw new Error("provider down");
    }));
    expect(await authorizer.authorize({ principalId: "u1", canvasId: "c1", permission: "read" })).toMatchObject({ allowed: false });
  });
});

describe("createPolicyBackedDirectory（任务 4.4/6.5）", () => {
  const provider = (items: Array<{ id: string; title: string }>): ResourceDirectory => ({
    directoryId: "test:dir",
    async list() {
      return {
        items: items.map((item) => ({
          resource: { kind: "canvas" as const, id: item.id },
          title: item.title,
          revision: 3,
          updatedAt: "2026-01-01T00:00:00Z",
          nodeCount: 2
        })),
        nextCursor: "next"
      };
    }
  });

  it("目录来自注入的 ResourceDirectory（与我的目录同一规则）", async () => {
    const directory = createPolicyBackedDirectory(() => provider([{ id: "c1", title: "A" }]));
    const page = await directory.list({ principalId: "u1" });
    expect(page.canvases).toEqual([{ canvasId: "c1", title: "A", revision: 3, updatedAt: "2026-01-01T00:00:00Z", nodeCount: 2 }]);
    expect(page.nextCursor).toBe("next");
  });

  it("未注入目录时返回空（不退回列举全库）", async () => {
    const directory = createPolicyBackedDirectory(() => null);
    expect(await directory.list({ principalId: "u1" })).toEqual({ canvases: [] });
  });

  it("目录故障时返回空", async () => {
    const failing: ResourceDirectory = {
      directoryId: "test:dir",
      async list() {
        throw new Error("boom");
      }
    };
    const directory = createPolicyBackedDirectory(() => failing);
    expect(await directory.list({ principalId: "u1" })).toEqual({ canvases: [] });
  });

  it("delegated principal 上下文标记为 mcp-delegation", () => {
    expect(delegatedPrincipalContext("u1")).toEqual({ subject: "u1", identityProvider: "mcp-delegation" });
  });
});

describe("createDiscoverableCanvasIds（任务 5.5）", () => {
  const principal: PrincipalContext = { subject: "u1", identityProvider: "test" };

  it("优先用 listDiscoverableIds 一次取全量", async () => {
    const list = vi.fn();
    const provider: ResourceDirectory = {
      directoryId: "test:dir",
      list,
      async listDiscoverableIds() { return ["c1", "c2"]; }
    };
    expect(await createDiscoverableCanvasIds(() => provider)(principal)).toEqual(["c1", "c2"]);
    expect(list).not.toHaveBeenCalled();
  });

  it("未实现 listDiscoverableIds 时翻页收集 list 条目", async () => {
    const provider: ResourceDirectory = {
      directoryId: "test:dir",
      async list({ cursor }) {
        const item = (id: string) => ({
          resource: { kind: "canvas" as const, id },
          title: id,
          revision: 1,
          updatedAt: "2026-01-01T00:00:00Z",
          nodeCount: 0
        });
        return cursor ? { items: [item("c2")] } : { items: [item("c1")], nextCursor: "p2" };
      }
    };
    expect(await createDiscoverableCanvasIds(() => provider)(principal)).toEqual(["c1", "c2"]);
  });

  it("目录提供者未注入时返回 null（调用方回退逐项判定）", async () => {
    expect(await createDiscoverableCanvasIds(() => null)(principal)).toBeNull();
  });

  it("匿名主体返回空（fail closed，不查询目录）", async () => {
    const list = vi.fn();
    const provider: ResourceDirectory = { directoryId: "test:dir", list };
    expect(await createDiscoverableCanvasIds(() => provider)({ subject: "  ", identityProvider: "test" })).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it("目录故障时抛出（由入口 fail closed）", async () => {
    const provider: ResourceDirectory = {
      directoryId: "test:dir",
      async list() { return { items: [] }; },
      async listDiscoverableIds() { throw new Error("down"); }
    };
    await expect(createDiscoverableCanvasIds(() => provider)(principal)).rejects.toThrow("down");
  });
});

describe("mergeDiscoverableIds（任务 5.9：并集导入目标可读集合）", () => {
  it("目录提供者未注入（null）时返回 null（保持逐项回退，不伪造完整集合）", () => {
    expect(mergeDiscoverableIds(null, ["imported-1"])).toBeNull();
  });

  it("并集去重，且不改写输入顺序（企业集合在前）", () => {
    expect(mergeDiscoverableIds(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("过滤空串/非字符串 ID", () => {
    expect(mergeDiscoverableIds(["a", ""], ["", "b"])).toEqual(["a", "b"]);
  });

  it("空企业集合时仅返回导入集合（导入画布仍可见）", () => {
    expect(mergeDiscoverableIds([], ["imported-1"])).toEqual(["imported-1"]);
  });
});
