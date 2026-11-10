import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteToolGrantStore } from "./tool-grant-store.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-tool-grants-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const grant = {
  token: "grant-1",
  canvasIds: ["canvas"],
  nodeIds: ["node"],
  tools: ["get_model_node", "submit_model_script"],
  workId: "work-1",
  cameraId: "camera-1",
  groupScope: { canvasId: "canvas", rootGroupId: "group", scopeEpoch: 4 },
  credentialEpoch: 2
};

describe("persistent tool grant store (task 2.2)", () => {
  it("loads grants after a restart and keeps their exact scope", () => {
    const dir = tempDir();
    const file = path.join(dir, "tool-grants.sqlite");
    const first = createSqliteToolGrantStore({ path: file });
    first.put(grant, "alice");
    first.close();

    const second = createSqliteToolGrantStore({ path: file });
    expect(second.load()).toEqual([{ grant, subject: "alice", revokedAt: null }]);
    second.close();
  });

  it("marks revocations durably so a restarted host cannot revive them", () => {
    const dir = tempDir();
    const file = path.join(dir, "tool-grants.sqlite");
    const first = createSqliteToolGrantStore({ path: file });
    first.put(grant, "alice");
    expect(first.revoke("work-1", "alice", "2026-11-10T00:00:00.000Z")).toEqual(["grant-1"]);
    first.close();

    const second = createSqliteToolGrantStore({ path: file });
    expect(second.load().map((entry) => entry.revokedAt)).toEqual(["2026-11-10T00:00:00.000Z"]);
    second.close();
  });

  it("does not revoke another subject's grants for the same work", () => {
    const dir = tempDir();
    const store = createSqliteToolGrantStore({ path: path.join(dir, "tool-grants.sqlite") });
    store.put(grant, "alice");
    store.put({ ...grant, token: "grant-bob" }, "bob");
    expect(store.revoke("work-1", "alice", "2026-11-10T00:00:00.000Z")).toEqual(["grant-1"]);
    expect(store.load().map((entry) => [entry.grant.token, entry.revokedAt])).toEqual([
      ["grant-1", "2026-11-10T00:00:00.000Z"],
      ["grant-bob", null]
    ]);
    store.close();
  });
});
