import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteToolGrantStore } from "./tool-grant-store.js";
import { createToolGrantRegistry } from "./authoring-adapters.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-grant-registry-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const grant = {
  token: "grant-1",
  canvasIds: ["canvas"],
  nodeIds: [],
  tools: ["get_model_node", "submit_model_script"],
  workId: "work-1"
};

const now = "2026-11-10T00:00:00.000Z";

describe("persistent tool grant registry (task 2.2)", () => {
  it("keeps grants usable across a host restart", () => {
    const file = path.join(tempDir(), "tool-grants.sqlite");
    const first = createToolGrantRegistry({ store: createSqliteToolGrantStore({ path: file }), now: () => now });
    first.issue(grant, "alice");
    first.close?.();

    const restarted = createToolGrantRegistry({ store: createSqliteToolGrantStore({ path: file }), now: () => now });
    expect(restarted.subject("grant-1")).toBe("alice");
    expect(restarted.authorize({ token: "grant-1", tool: "submit_model_script", canvasId: "canvas" })).toEqual({ ok: true });
    restarted.close?.();
  });

  it("rejects immediately after revocation and after restart", () => {
    const file = path.join(tempDir(), "tool-grants.sqlite");
    const first = createToolGrantRegistry({ store: createSqliteToolGrantStore({ path: file }), now: () => now });
    first.issue(grant, "alice");
    first.revoke("work-1", "alice");
    expect(first.verify("grant-1")).toBeNull();
    expect(first.authorize({ token: "grant-1", tool: "get_model_node" })).toEqual({ ok: false, reason: "unknown-grant" });
    first.close?.();

    const restarted = createToolGrantRegistry({ store: createSqliteToolGrantStore({ path: file }), now: () => now });
    expect(restarted.verify("grant-1")).toBeNull();
    restarted.close?.();
  });

  it("never widens the frozen tool or canvas scope", () => {
    const registry = createToolGrantRegistry();
    registry.issue(grant, "alice");
    expect(registry.authorize({ token: "grant-1", tool: "delete_canvas", canvasId: "canvas" })).toEqual({ ok: false, reason: "tool-not-allowed" });
    expect(registry.authorize({ token: "grant-1", tool: "get_model_node", canvasId: "other" })).toEqual({ ok: false, reason: "canvas-not-allowed" });
  });
});
