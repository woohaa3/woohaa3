/**
 * ChatGPT authoring 端口 owner 透传测试
 * （修复：模型聚焦面板生成报「缺少可信用户委托」）。
 *
 * 回归点：本地开发（无宿主 principal）时 owner 是本地会话 id（`local:<id>`），端口 MUST 用
 * 生成层传入的 owner 构造委托，而不是读取空的宿主 principal 或进程级可变作用域。
 */
import { describe, expect, it } from "vitest";
import type { ApplicationBackendHost, ApplicationUserDelegation } from "@woohaa3/contracts";
import { createChatGptAuthoringPorts } from "../src/backend/index.js";

type Recorded = { op: string; delegation: ApplicationUserDelegation | undefined; canvasId: string; nodeId: string };

function host(recorded: Recorded[]): ApplicationBackendHost {
  const authoring = {
    readNode: async (input: { delegation?: ApplicationUserDelegation; canvasId: string; nodeId: string }) => {
      recorded.push({ op: "read", delegation: input.delegation, canvasId: input.canvasId, nodeId: input.nodeId });
      return { ok: true as const, nodeType: "model3d", title: "t", prompt: "", references: [], cameras: [] };
    },
    submitModel: async (input: { delegation?: ApplicationUserDelegation; canvasId: string; nodeId: string }) => {
      recorded.push({ op: "submit", delegation: input.delegation, canvasId: input.canvasId, nodeId: input.nodeId });
      return { ok: true as const, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "cmd", duplicate: false, noop: false };
    },
    commitAnimation: async (input: { delegation?: ApplicationUserDelegation; canvasId: string; nodeId: string }) => {
      recorded.push({ op: "commit", delegation: input.delegation, canvasId: input.canvasId, nodeId: input.nodeId });
      return { ok: true as const, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "cmd", duplicate: false, noop: false };
    },
    mutateCamerasBatch: async (input: { delegation?: ApplicationUserDelegation; canvasId: string; nodeId: string }) => {
      recorded.push({ op: "cameras", delegation: input.delegation, canvasId: input.canvasId, nodeId: input.nodeId });
      return { ok: true as const, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "cmd", duplicate: false, noop: false };
    }
  };
  return { services: { authoring: { authoring } } } as unknown as ApplicationBackendHost;
}

describe("ChatGPT authoring 端口 owner 透传", () => {
  it("本地会话 owner 也能构造委托并写入（不再报缺少可信用户委托）", async () => {
    const recorded: Recorded[] = [];
    const ports = createChatGptAuthoringPorts(host(recorded));

    const read = await ports.readNode({ ownerId: "local:abc", canvasId: "cv", nodeId: "n" });
    expect(read.ok).toBe(true);
    await ports.submitModel({ ownerId: "local:abc", canvasId: "cv", nodeId: "n", requestId: "r1", source: "scene.box({id:'b',size:[1,1,1]});" });
    await ports.commitAnimation({ ownerId: "local:abc", canvasId: "cv", nodeId: "n", requestId: "r2", animation: {} as never });
    await ports.mutateCamerasBatch({ ownerId: "local:abc", canvasId: "cv", nodeId: "n", requestId: "r3", mutations: [] });

    expect(recorded.map((entry) => entry.op)).toEqual(["read", "submit", "commit", "cameras"]);
    for (const entry of recorded) {
      expect(entry.delegation?.subject).toBe("local:abc");
      expect(entry.delegation?.authLevel).toBe("authenticated");
    }
  });

  it("并发请求各自携带不同 owner，不串号", async () => {
    const recorded: Recorded[] = [];
    const ports = createChatGptAuthoringPorts(host(recorded));
    await Promise.all([
      ports.readNode({ ownerId: "principal:alice", canvasId: "cv", nodeId: "n" }),
      ports.readNode({ ownerId: "principal:bob", canvasId: "cv", nodeId: "n" })
    ]);
    const subjects = recorded.map((entry) => entry.delegation?.subject);
    expect(subjects).toContain("principal:alice");
    expect(subjects).toContain("principal:bob");
  });

  it("空 owner 拒绝读取（不越权）", async () => {
    const recorded: Recorded[] = [];
    const ports = createChatGptAuthoringPorts(host(recorded));
    const read = await ports.readNode({ ownerId: "", canvasId: "cv", nodeId: "n" });
    expect(read.ok).toBe(false);
    expect(recorded).toEqual([]);
  });
});
