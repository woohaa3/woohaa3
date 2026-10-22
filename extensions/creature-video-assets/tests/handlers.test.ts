import { describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ApplicationBackendHost, type ApplicationBackendHandlerRegistration } from "@woohaa3/contracts";
import { createCreatureVideoAssetsBackendDefinition } from "../src/integration/backend/extension.js";
import { initialInput } from "../src/state/shared/workflow.js";
import { memoryDocuments } from "./memory-documents.js";

function harness() {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas");
  canvas.document.nodes.push({ id: "workflow", type: "composite-asset", position: { x: 0, y: 0 } });
  canvas.nodeData.workflow = { extensionId: "creature-video-assets", extensionContentRef: { schemaVersion: 1, instanceId: "instance-123" } };
  const handlers = new Map<string, ApplicationBackendHandlerRegistration>();
  const authorize = vi.fn(async (_input: unknown) => ({ ok: true } as { ok: boolean; code?: string; message?: string }));
  const read = vi.fn(async () => canvas), submit = vi.fn(), admit = vi.fn(() => ({ ok: false, reason: "disabled" }));
  const host = { services: { documents: memoryDocuments(), canvasAccess: { authorize }, extensionNodes: { read }, media: { verify: vi.fn() }, tasks: { submit } }, config: { values: () => ({}) }, work: { admit, resume: () => null }, logger: vi.fn(), registerResource: vi.fn(), registerHandler: (handler: ApplicationBackendHandlerRegistration) => handlers.set(handler.route, handler) } as unknown as ApplicationBackendHost;
  createCreatureVideoAssetsBackendDefinition().activate(host);
  const identity = { canvasId: "canvas", nodeId: "workflow", instanceId: "instance-123" };
  const call = (route: string, body = {}, subject: string | null = "trusted-user") => handlers.get(route)!.handle({ body: { ...identity, ...body }, context: { principal: subject ? { subject } : null } } as never);
  return { call, authorize, read, submit, admit };
}
describe("受控工作流入口", () => {
  it("拒绝正文冒用身份和被拒绝的画布，不创建工作或任务", async () => {
    const h = harness();
    expect((await h.call("start", { subject: "forged" }, null)).status).toBe(401);
    expect(h.authorize).not.toHaveBeenCalled();
    h.authorize.mockResolvedValue({ ok: false, code: "denied", message: "无权限" });
    expect((await h.call("start")).status).toBe(403);
    expect(h.read).not.toHaveBeenCalled(); expect(h.admit).not.toHaveBeenCalled(); expect(h.submit).not.toHaveBeenCalled();
  });
  it("只信任权威节点业务身份与版本，第一步参考图须属于当前画布", async () => {
    const h = harness();
    expect((await h.call("status", { instanceId: "other-instance" })).status).toBe(409);
    expect((await h.call("start", { expectedVersion: 5 })).status).toBe(409);
    const input = { ...initialInput(), prompt: "苔原巡游者", referenceImages: [{ sourceNodeId: "foreign", assetId: "foreign", storageKey: "foreign.png", checksum: "foreign", contentType: "image/png", size: 24, title: "不属于此画布" }] };
    expect((await h.call("start", { expectedVersion: 0, stageId: "01_brief", input })).status).toBe(409);
    expect(h.admit).not.toHaveBeenCalled(); expect(h.submit).not.toHaveBeenCalled();
  });
  it("站点不接受新工作时不会绕过准入提交任务", async () => {
    const h = harness();
    const result = await h.call("start", { expectedVersion: 0, stageId: "01_brief", input: { ...initialInput(), prompt: "苔原巡游者" } });
    expect(result.status).toBe(503); expect(h.admit).toHaveBeenCalledOnce(); expect(h.submit).not.toHaveBeenCalled();
    expect(h.authorize).toHaveBeenCalledWith({ subject: "trusted-user", canvasId: "canvas", permission: "write" });
  });
});
