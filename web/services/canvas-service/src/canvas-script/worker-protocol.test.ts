import { describe, expect, it, vi } from "vitest";

const protocol = vi.hoisted(() => ({ messages: [] as unknown[] }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      postMessage() {
        queueMicrotask(() => {
          for (const message of protocol.messages) this.emit("message", message);
        });
      }
      terminate() { return Promise.resolve(0); }
    }
  };
});

import { CanvasScriptEngine } from "./engine.js";

function execute() {
  return new CanvasScriptEngine().execute({
    source: "", nodeKinds: ["text"], promptMaxChars: 8000,
    positionAbsMax: 1_000_000, deadlineMs: Date.now() + 2000
  });
}

describe("canvas script worker result channel", () => {
  it("ignores Node watch notifications and waits for the actual result in both realms", async () => {
    protocol.messages = [
      { "watch:import": ["node:worker_threads"] },
      { "watch:require": [null] }, null, undefined,
      { kind: "ok", payload: { ops: [], fatal: null, apiCalls: 0 } },
      { kind: "error" }
    ];
    await expect(execute()).resolves.toEqual({ ok: true, operations: [], apiCalls: 0 });
  });

  it.each([undefined, {}, { code: "broken", message: null }])(
    "returns a failed execution for a malformed error envelope instead of throwing: %j",
    async (error) => {
      protocol.messages = [{ kind: "error", error }];
      await expect(execute()).resolves.toMatchObject({ ok: false, error: { code: "script-runtime-error" } });
      protocol.messages = [{ kind: "ok", payload: { ops: [], fatal: null, apiCalls: 0 } }];
      await expect(execute()).resolves.toMatchObject({ ok: true });
    }
  );
});
