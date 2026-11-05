import { describe, expect, it } from "vitest";
import { createDefaultWorldCameraData } from "@woohaa3/contracts";
import { createRendererClient } from "./client.js";

describe("world renderer wire compatibility", () => {
  it("sends the dedicated world protocol and continues ordinary work after an old worker rejects it", async () => {
    const script = `
      let buffered = Buffer.alloc(0);
      process.stdin.on('data', chunk => {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
          const length = buffered.readUInt32BE(0);
          const request = JSON.parse(buffered.subarray(4, 4 + length));
          buffered = buffered.subarray(4 + length);
          const world = request.world;
          const correctWorld = request.protocolVersion === 'woohaa-world-renderer-protocol-v1'
            && world.camera.projection.kind === 'perspective' && world.camera.cameraId === 'camera';
          const correctModel = request.protocolVersion === 'woohaa-model-renderer-protocol-v4';
          const response = world ? { ok: false, code: correctWorld ? 'unsupported-protocol-version' : 'wrong-world-wire' }
            : correctModel ? { ok: true, pngLen: 3 } : { ok: false, code: 'wrong-model-wire' };
          const json = Buffer.from(JSON.stringify(response));
          const header = Buffer.alloc(4); header.writeUInt32BE(json.length);
          process.stdout.write(Buffer.concat([header, json]));
          if (response.ok) { const size = Buffer.alloc(4); size.writeUInt32BE(3); process.stdout.write(Buffer.concat([size, Buffer.from([1, 2, 3])])); }
        }
      });
    `;
    const client = createRendererClient({ command: process.execPath, args: ["-e", script], timeoutMs: 2000 });
    const request = { requestId: "world", sceneVersion: "woohaa-model-scene-ir-v2", signature: "s", extent: 1, ops: [],
      capture: { width: 16, height: 9, background: "transparent", cameraPreset: "dimetric" } };
    try {
      const results = await Promise.all([
        client.render({ ...request, world: { camera: createDefaultWorldCameraData("camera", "v1", { u: 0, v: 0 }), instances: [] } }),
        client.render({ ...request, requestId: "ordinary" })
      ]);
      expect(results[0]).toMatchObject({ ok: false, code: "unsupported-protocol-version" });
      expect(results[1]).toMatchObject({ ok: true, png: Buffer.from([1, 2, 3]) });
    } finally { await client.close(); }
  });
});
