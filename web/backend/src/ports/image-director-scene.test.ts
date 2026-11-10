import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, SHARED_WORLD_VERSION } from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { CanvasRoom } from "../../../services/canvas-service/src/sync/room.js";
import { SqliteYjsRepository } from "../../../services/canvas-service/src/storage/sqlite/yjs.js";
import { createImageDirectorScenePort } from "../../../services/canvas-service/src/world-authoring/image-director-port.js";
import { createSqliteAgentConversationStore } from "../../../services/application-service/src/repository/agent-conversation-repository.js";
import { ImageDirectorSceneStore } from "../../../services/application-service/src/repository/image-director-scene-store.js";
import { createAgentConversationService } from "../../../services/application-service/src/extensions/agent-conversation-service.js";
import { ImageDirectorSceneService } from "../../../services/application-service/src/extensions/image-director-scene-service.js";
import { createAgentRoleRegistry } from "../../../services/application-service/src/agent-roles/registry.js";

describe("image director cross-service delivery", () => {
  it("reserves an empty director area, lets the role write with tools, and finalizes one receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "image-director-integration-"));
    const yjs = new SqliteYjsRepository({ path: join(dir, "canvas.sqlite") });
    const conversationsStore = createSqliteAgentConversationStore({ path: join(dir, "application.sqlite") });
    const records = new ImageDirectorSceneStore(join(dir, "application.sqlite"));
    const room = new CanvasRoom({ canvasId: "canvas", repository: yjs });
    const canvas = createEmptyWoohaa3ServerCanvas("canvas");
    canvas.document.nodes.push({ id: "image", type: "image", position: { x: 0, y: 0 } });
    canvas.nodeData.image = { outputAssetId: "asset" };
    canvas.assets.push({ id: "asset", mediaKind: "image", title: "image", status: "ready", source: "uploaded", createdAt: "2026-11-03T00:00:00Z", metadata: { storageKey: "image.png" } } as never);
    await room.initialize({ canvas, roomEpoch: "epoch", createdAt: new Date().toISOString() });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=", "base64");
    const port = createImageDirectorScenePort({ resolveRoom: async () => room, authorize: async () => true, media: { verify: async () => ({ exists: true, matches: true }), read: async () => ({ bytes: png, contentType: "image/png" }) } });
    const binding = { connectionId: "connection", adapterId: "adapter", configRevision: 1, credentialEpoch: 1 };
    const connection = { ...binding, extensionId: "test", name: "test", runCategory: "http-sdk", authMode: "api-key", ready: true, credentialConfigured: true, status: {}, capabilities: { tools: true, targets: ["world"], textDelivery: { imageInput: true, maxImages: 1 } }, models: [{ id: "model", label: "Model", source: "remote-catalog", accountAuthorized: true }] };
    const adapter = {
      id: "adapter",
      capabilities: () => ({ discussion: true, targets: ["world"], tools: true, models: "remote" }),
      authorization: async () => "ready" as const,
      models: async () => ({ models: connection.models }),
      async run(input: { intent: { canvasId: string; nodeId?: string } }) {
        const areaNodeId = input.intent.nodeId!;
        const snapshot = room.exportCanvas();
        if (!snapshot.ok) throw new Error(snapshot.message);
        const result = await room.submit({
          protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: input.intent.canvasId, commandId: "tool-write", actorId: "test", baseRevision: snapshot.canvas.revision,
          commands: [
            { type: "node.add", node: { id: "model-1", type: "model3d", position: { x: 0, y: 0 } }, nodeData: { modelScript: "scene.box({});", modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2", sharedWorldInstance: { kind: "world-instance", version: SHARED_WORLD_VERSION, instanceId: "instance-1", transform: { version: SHARED_WORLD_VERSION, position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } } } },
            { type: "node.add", node: { id: "camera-1", type: "world-camera", position: { x: 0, y: 0 } }, nodeData: { worldCamera: { kind: "world-camera", version: SHARED_WORLD_VERSION, cameraId: "camera-id", settingsVersion: "camera-v1", position: { u: 0, v: 2, h: 1 }, rotation: [0, 0, 0, 1], projection: { kind: "perspective", verticalFovRadians: 1, nearMeters: 0.1, farMeters: 100 }, captureMode: { kind: "static" }, aspect: { width: 4, height: 3 }, boundInstanceId: null } } },
            { type: "nodeData.patch", nodeId: areaNodeId, value: { title: "导演区" } }
          ]
        });
        if (!result.ok) throw new Error(result.message);
        return { status: "succeeded" as const };
      }
    };
    const registry = { resolve: () => ({ ok: true, handle: { adapter, capabilities: adapter.capabilities(), owner: { adapterId: "adapter", extensionId: "test", configVersion: 1, mode: "public" } } }), list: () => [], resolveByCapabilityId: () => { throw new Error("unused"); } };
    const connections = { getConnection: async () => connection, list: () => [], listConnections: async () => [connection], resolve: () => ({ ok: false, code: "adapter-unavailable", message: "unused" }) };
    const agentRoles = createAgentRoleRegistry({ availableTools: () => ["get_world_context", "create_world_model", "create_world_camera"] });
    const registered = agentRoles.register({
      extensionId: "test", artifactId: "test@1", implementation: {
        definition: {
          id: "scene-director", revision: "1", title: "导演区", specialty: "场景",
          instructions: "你是导演区角色。", inputSchema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" }, action: { type: "string" } } }, contextSchema: { type: "object" },
          tools: { required: ["get_world_context"], optional: ["create_world_model", "create_world_camera"] },
          nativeCapabilities: { required: [], optional: [] }, requirements: { imageInput: false, toolCalling: true, structuredOutput: "none" }, output: { kind: "tool-receipts" }
        },
        prepare: () => ({ messages: [{ role: "user", content: "build" }], tools: ["get_world_context", "create_world_model", "create_world_camera"] })
      }
    });
    if (!registered.ok) throw new Error(registered.message);
    const conversations = createAgentConversationService({ store: conversationsStore, registry: registry as never, connections: connections as never, agentRoles });
    const service = new ImageDirectorSceneService({ store: records, conversations, registry: registry as never, connections: connections as never, canvas: port, agentRoles });
    try {
      const created = conversations.createConversation({ owner: "owner", canvasId: "canvas", adapterId: "adapter", connectionId: "connection" });
      if (!created.ok) throw new Error(created.error.message);
      const request = { requestId: "request", sourceNodeId: "image", connectionId: "connection", model: "model", variant: null, instructions: "build" };
      const input = { owner: "owner", canvasId: "canvas", conversationId: created.conversation.conversationId, request, connection: binding, entry: { roleId: "test/scene-director", action: "generate" as const, canvasId: "canvas", nodeId: "image", connectionId: "connection", model: "model", prompt: "build" } };
      const accepted = await service.accept(input);
      if (!accepted.ok) throw new Error(accepted.error.message);
      await conversations.whenSettled(accepted.turn.turnId);
      const result = service.query("owner", "canvas", "request");
      expect(result?.stage).toBe("delivered");
      expect(result?.receipt?.modelNodeIds).toEqual(["model-1"]);
      expect(result?.receipt?.cameraNodeId).toBe("camera-1");
      const after = room.exportCanvas();
      if (!after.ok) throw new Error(after.message);
      expect(after.canvas.nodeData[result!.reservation!.nodeId]?.title).toBe("导演区");
      expect(after.canvas.document.nodes.some(node => node.id === "model-1")).toBe(true);
    } finally { room.dispose(); records.close(); conversationsStore.close(); yjs.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
