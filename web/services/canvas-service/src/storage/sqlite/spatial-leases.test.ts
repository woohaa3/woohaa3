import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorldObjectVersion } from "@woohaa3/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { loadNodeSqlite } from "./sqlite-loader.js";
import { SqliteSpatialLeaseStore } from "./spatial-leases.js";
import type { LeaseIntent, SpatialLeaseAuthority } from "../../world-authoring/spatial-leases.js";

const instance = (instanceId: string) => ({ kind: "instance" as const, instanceId, version: "v1" });
const camera = (cameraId: string) => ({ kind: "camera" as const, cameraId, version: "v1" });
const intent = (requestId: string, writable: WorldObjectVersion[] = [instance("a")]): LeaseIntent => ({ requestId, canvasId: "canvas", runId: requestId, epoch: 1, executionId: `exec-${requestId}`, scope: { scope: { kind: "scene-area", areaId: "area" }, scopeVersion: "s1" }, writable, readOnly: [] });
const { DatabaseSync } = loadNodeSqlite();
const authority: SpatialLeaseAuthority = { eligible: (_intent, targets) => targets.every(t => t.version === "v1"), stopped: (identity, evidence) => evidence === `stopped-${identity.executionId}` };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "spatial-leases-")); dirs.push(dir);
  const file = join(dir, "db.sqlite");
  const a = new DatabaseSync(file), b = new DatabaseSync(file);
  return { file, a, b, one: new SqliteSpatialLeaseStore(a, authority), two: new SqliteSpatialLeaseStore(b, authority) };
}
describe("durable spatial leases", () => {
  it("atomically fences overlapping typed identities across connections", () => {
    const { a, b, one, two } = fixture();
    one.acquire(intent("one", [instance("a"), instance("b")]));
    expect(() => two.acquire(intent("two", [instance("c"), instance("b")]))).toThrow("lease-conflict");
    two.acquire(intent("three", [instance("c"), camera("a")]));
    expect(() => one.validateUnoccupied("canvas", [instance("a")])).toThrow("lease-conflict");
    a.close(); b.close();
  });
  it("persists normalized intent and rolls back injected failures", () => {
    const { file, a, b, one } = fixture();
    const original = intent("one", [instance("b"), instance("a")]);
    one.acquire(original);
    one.extend("canvas", "one", [instance("c")]);
    expect(one.acquire({ ...original, writable: [...original.writable].reverse() }).intent.writable).toHaveLength(3);
    expect(() => one.acquire({ ...original, executionId: "different" })).toThrow("request-conflict");
    let writes = 0;
    const faulty = new SqliteSpatialLeaseStore(b, authority, () => { if (++writes === 2) throw new Error("injected"); });
    expect(() => faulty.acquire(intent("failed", [instance("z")]))).toThrow("injected");
    expect(faulty.lookup("canvas", "failed")).toBeNull();
    faulty.validateUnoccupied("canvas", [instance("z")]);
    a.close(); b.close();
    const reopened = new DatabaseSync(file); const store = new SqliteSpatialLeaseStore(reopened, authority);
    expect(store.acquire(original).intent.runId).toBe("one");
    expect(store.listPending()).toHaveLength(1); reopened.close();
  });
  it("retains cancelled locks until exact trusted stop and fences stale completion", () => {
    const { file, a, b, one, two } = fixture(); const first = intent("one");
    one.acquire(first); one.cancel("canvas", "one");
    const reopened = new DatabaseSync(file); const recovery = new SqliteSpatialLeaseStore(reopened, authority);
    expect(recovery.listPending()[0]?.state).toBe("cancelled");
    expect(() => recovery.validateUnoccupied("canvas", [instance("a")])).toThrow("lease-conflict");
    reopened.close();
    expect(() => one.validateForCommit("canvas", "one", "one", 1, first.scope, first.writable)).toThrow("cancelled");
    expect(() => two.acquire(intent("two"))).toThrow("lease-conflict");
    expect(() => one.confirmStopped("canvas", "one", "one", 1, first.executionId, true)).toThrow("unverified-stop");
    one.confirmStopped("canvas", "one", "one", 1, first.executionId, "stopped-exec-one");
    two.acquire({ ...intent("two"), epoch: 2 });
    one.confirmStopped("canvas", "one", "one", 1, first.executionId, "stopped-exec-one");
    expect(() => one.confirmStopped("canvas", "two", "two", 1, "exec-two", "stopped-exec-two")).toThrow("stale-epoch");
    expect(() => one.validateUnoccupied("canvas", [instance("a")])).toThrow("lease-conflict");
    a.close(); b.close();
  });
  it("rechecks eligibility and atomically extends without upgrading references", () => {
    const { a, b, one, two } = fixture();
    const first = { ...intent("one"), readOnly: [instance("ref")] }; one.acquire(first);
    two.acquire(intent("two", [instance("busy")]));
    expect(() => one.extend("canvas", "one", [instance("new"), instance("busy")])).toThrow("lease-conflict");
    one.validateUnoccupied("canvas", [instance("new"), instance("ref")]);
    expect(() => one.extend("canvas", "one", [instance("ref")])).toThrow("outside-scope");
    expect(() => one.extend("canvas", "one", [{ ...instance("new"), version: "untrusted" }])).toThrow("outside-scope");
    one.extend("canvas", "one", [instance("new")]);
    a.exec("BEGIN IMMEDIATE");
    one.validateForCommit("canvas", "one", "one", 1, first.scope, [instance("new")]);
    expect(() => one.validateForCommit("canvas", "one", "one", 1, first.scope, [{ ...instance("new"), version: "v2" }])).toThrow("version-conflict");
    a.exec("ROLLBACK");
    expect(() => new SqliteSpatialLeaseStore(b).acquire(intent("no-authority", [instance("free")]))).toThrow("unavailable");
    a.close(); b.close();
  });
});
