import { describe, expect, it } from "vitest";
import { ContentContributionRegistry } from "./content-contribution.js";
import { dispatchContentRoute } from "./content-route.js";

function registry(): ContentContributionRegistry {
  const result = new ContentContributionRegistry();
  result.register({
    extensionId: "test-route",
    routes: [
      { method: "POST", path: ["render"], handle: ({ body }) => ({ status: 200, body: { echoed: body } }) },
      { method: "POST", path: ["bad"], handle: () => ({ status: 99 }) },
      { method: "POST", path: ["boom"], handle: () => { throw new Error("boom"); } }
    ]
  });
  return result;
}

describe("content routes", () => {
  it("dispatches an owner route with the parsed body", async () => {
    await expect(dispatchContentRoute(registry(), "test-route", "POST", ["render"], { a: 1 })).resolves.toEqual({
      ok: true,
      result: { status: 200, body: { echoed: { a: 1 } } }
    });
  });

  it("returns stable 404 for unknown owners and paths", async () => {
    await expect(dispatchContentRoute(registry(), "missing", "POST", ["render"], {})).resolves.toEqual({
      ok: false, status: 404, code: "content-route-not-found"
    });
    await expect(dispatchContentRoute(registry(), "test-route", "GET", ["render"], {})).resolves.toEqual({
      ok: false, status: 404, code: "content-route-not-found"
    });
  });

  it("normalizes invalid results and thrown handlers", async () => {
    await expect(dispatchContentRoute(registry(), "test-route", "POST", ["bad"], {})).resolves.toEqual({
      ok: false, status: 500, code: "content-route-invalid-result"
    });
    await expect(dispatchContentRoute(registry(), "test-route", "POST", ["boom"], {})).resolves.toEqual({
      ok: false, status: 500, code: "content-route-failed"
    });
  });

  it("scopes route identity by owner and rejects duplicates inside one owner", async () => {
    const target = registry();
    target.register({
      extensionId: "other-route",
      routes: [{ method: "POST", path: ["render"], handle: () => ({ status: 200, body: "other" }) }]
    });
    await expect(dispatchContentRoute(target, "other-route", "POST", ["render"], {})).resolves.toEqual({
      ok: true,
      result: { status: 200, body: "other" }
    });
    expect(() => target.register({
      extensionId: "duplicate-route",
      routes: [
        { method: "POST", path: ["render"], handle: () => ({ status: 200 }) },
        { method: "POST", path: ["render"], handle: () => ({ status: 200 }) }
      ]
    })).toThrow("content-registration-invalid");
  });
});
