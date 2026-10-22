import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
// @ts-expect-error Shared Node build-time checker has no TypeScript declaration.
import { checkPublicBoundary } from "../../scripts/check-public-boundary.mjs";

describe("independent public client", () => {
  it("contains no parent source dependency or private deployment configuration", () => {
    expect(checkPublicBoundary(fileURLToPath(new URL("../..", import.meta.url)))).toEqual([]);
  });
});
