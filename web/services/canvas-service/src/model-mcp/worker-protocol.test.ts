import { expect, it, vi } from "vitest";

const protocol = vi.hoisted(() => ({ result: {} as unknown }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return { Worker: class extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => {
        this.emit("message", { "watch:import": ["node:worker_threads"] });
        this.emit("message", { "watch:require": [null] });
        this.emit("message", null);
        this.emit("message", { kind: "model-script-result", result: protocol.result });
      });
    }
    terminate() { return Promise.resolve(0); }
  } };
});
import { executeSceneIr } from "./script-executor.js";

it("ignores Node watch dependency notifications and waits for the model execution result", async () => {
  protocol.result = { ok: true, version: "woohaa-model-js-v2", sceneVersion: "woohaa-model-scene-ir-v2", ops: [], json: "{}", sourceHash: "hash" };
  await expect(executeSceneIr("scene.box({});", "woohaa-model-js-v2")).resolves.toEqual(protocol.result);
  protocol.result = { ok: false, stage: "validate", code: "invalid-scene", message: "bad scene" };
  await expect(executeSceneIr("scene.box({});", "woohaa-model-js-v2")).resolves.toEqual(protocol.result);
});

it("turns malformed execution envelopes into explicit failures", async () => {
  protocol.result = { ok: false };
  await expect(executeSceneIr("scene.box({});", "woohaa-model-js-v2")).resolves.toMatchObject({ ok: false, stage: "execute", code: "runtime-error", message: expect.any(String) });
});
