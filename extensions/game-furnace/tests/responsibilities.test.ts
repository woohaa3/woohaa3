import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import { checkExtensionDependencies, sourceModules } from "../../../web/tooling/extension-dependencies.js";

it("actual responsibilities, environments, public neutral entries and cycles", () => {
  expect(checkExtensionDependencies(ts, sourceModules(fileURLToPath(new URL("../src", import.meta.url))), ["frontend/index.ts", "shared.ts", "geometry.ts", "archive.ts"])).toEqual([]);
});
