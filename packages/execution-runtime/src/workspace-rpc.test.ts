import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { startExecutorDaemon } from "./daemon.js";
import { createExecutorClient } from "./client.js";

it("validates workspace socket inputs before effects and keeps the daemon alive after rejection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-codecs-"));
  const options = { socketPath: path.join(root, "rpc.sock"), token: "token", workspaceKey: "test", stateDir: path.join(root, "state"), canvasWorkspaceRoot: path.join(root, "files") };
  const daemon = await startExecutorDaemon(options), client = createExecutorClient(options);
  try {
    const identity = { owner: "owner", canvasId: "canvas", requestId: "request" };
    const handle = await client.call("workspace.acquire", identity);
    for (const [method, params] of [
      ["workspace.acquire", { ...identity, rootPath: "/outside" }],
      ["workspace.write", { handle: { ...(handle as object), directoryKey: "../outside" }, input: { path: "shared/file", content: "x" } }],
      ["workspace.write", { handle, input: { path: "shared/file", content: "x", owner: "other" } }],
      ["workspace.execute", { handle, input: { operationId: "run", command: "node", args: [1] } }],
      ["workspace.query", { handle, input: { executionId: "id", after: -1 } }],
      ["workspace.release", { handle, outcome: "active" }],
      ["workspace.cancel", { handle: null }],
      ["workspace.migrate", { operationId: "move", targetPath: path.join(root, "next"), expectedRootRevision: "1" }]
    ] as const) await expect(client.call(method, params)).rejects.toHaveProperty("code", "workspace-forbidden");
    expect(await client.call("workspace.leases")).toMatchObject([{ status: "active" }]);
    expect(await client.call("workspace.settings")).toMatchObject({ rootRevision: 1 });
    expect((await client.call<{ workspaceKey: string }>("ping")).workspaceKey).toBe("test");
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
